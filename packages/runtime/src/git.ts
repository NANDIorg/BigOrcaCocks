import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { InitialCommitMode, ProjectBranchInfo, ProjectBranchList, ProjectBranchUpstream, ProjectGitResult, ProjectLocalBranch } from '@orca-board/contracts'
import { canonicalGitCommonDir, createGitOperationQueue, type GitOperationQueue } from './git-operation-queue.ts'
import { createGitProcessService, GitProcessError, type GitProcessService } from './git-process.ts'

/** Коды прежних Git-отказов; способ отображения и класс ошибки задаёт host. */
export type GitErrorCode = 'git.branchBusy' | 'git.branchNotFound' | 'git.dirtyTree' | 'git.noCommits' | 'git.noUpstream' | 'git.notFastForward' | 'git.notRepo' | 'git.opFailed' | 'git.timeout' | 'git.workersActive'

export interface GitMessage {
  key: GitErrorCode
  params?: GitMessageParams
}
export type GitMessageParams = Record<string, string | number | GitMessage>

export interface GitMessages {
  error(key: GitErrorCode, params?: GitMessageParams): Error
  untrackedLabel(): string
}

export interface ReviewInfo {
  base: string
  branch: string
  stat: string
  commits: string[]
  dirty: boolean
}

/**
 * `git merge` не удался. `conflict` — git начал слияние и упёрся в конфликтующие файлы: его разрешают в ветке задачи
 * и сливают снова. Иначе git до слияния не дошёл (занят `index.lock`, незакоммиченное в цели, нет ветки, таймаут):
 * это не конфликт, повтор после устранения причины сольёт как есть.
 */
export class MergeError extends Error {
  readonly conflict: boolean

  constructor(message: string, conflict: boolean) {
    super(message)
    this.conflict = conflict
  }
}

/** Отказ git-операции ноды: текст `git <команда>: <причина>` уходит в `task.feedback` и исход `error`. */
export class GitOpError extends Error {}

/** Один экземпляр операций на owner; callbacks не привязывают runtime к глобальному языку Desktop. */
export function createGitOperations(messages: GitMessages, operationQueue: GitOperationQueue = createGitOperationQueue(), processes: GitProcessService = createGitProcessService()) {
  // git вызывается только массивом аргументов без shell: на Windows execFileSync находит git.exe через PATH,
  // сами команды (worktree, merge, branch, status, diff) одинаковы на всех платформах.
  function git(cwd: string, args: string[], timeoutMs?: number): string {
    return execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: gitEnv(),
      ...(timeoutMs ? { timeout: timeoutMs, killSignal: 'SIGKILL' as const } : {})
    }).trim()
  }

  /**
   * Окружение git в runtime: терминала нет, поэтому ни пароля (`GIT_TERMINAL_PROMPT=0`), ни редактора сообщения
   * (`GIT_EDITOR=true` — merge/commit без `-m` не повиснут в ожидании vim).
   */
  function gitEnv(): NodeJS.ProcessEnv {
    return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' }
  }

  /**
   * Сколько ждать git, который меняет репозиторий (merge, commit, worktree remove). git в main синхронный: хук,
   * подпись коммита (gpg-agent ждёт пин-код) или чужая блокировка файлов иначе вешают приложение насовсем.
   * Таймаут — обычная ошибка: мерж подзадачи встаёт с причиной (`Task.stageBlock`), «Принять» его повторит.
   */
  const MUTATE_TIMEOUT_MS = 120_000

  /** Текст ошибки git из execFileSync: stdout+stderr или «не ответил за N с» по таймауту. */
  function gitFailure(e: unknown, timeoutMs: number): string {
    const err = e as { stdout?: string; stderr?: string; message?: string; code?: string }
    if (err.code === 'ETIMEDOUT') return `git не ответил за ${Math.round(timeoutMs / 1000)} с`
    return `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`.trim() || err.message || 'неизвестная ошибка'
  }

  /**
   * Текущая ветка корня; detached HEAD — `'HEAD'` (так его узнают `headBase` и вызывающие). `symbolic-ref`, а не
   * `rev-parse --abbrev-ref HEAD`: последний в репозитории без коммитов (unborn HEAD) падает с кодом 128, а
   * `symbolic-ref` отдаёт имя ветки. Код 1 — HEAD не на ветке; другой (128 — не репозиторий) пробрасывается.
   */
  function currentBranch(repoRoot: string): string {
    try {
      return git(repoRoot, ['symbolic-ref', '--short', '-q', 'HEAD'])
    } catch (e) {
      if ((e as { status?: number }).status === 1) return 'HEAD'
      throw e
    }
  }

  /** В репозитории есть хотя бы один коммит (HEAD не unborn). Не репозиторий — исключение git. */
  function hasCommits(repoRoot: string): boolean {
    try {
      git(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
      return true
    } catch (e) {
      if ((e as { status?: number }).status === 1) return false
      throw e
    }
  }

  /**
   * Orca ветвит работу от коммита: в репозитории без коммитов (свежий `git init`) `worktree add -b` без базы создаёт
   * пустую ветку-сироту без файлов проекта, а с базой падает сырым «invalid reference». Отказываем понятной ошибкой.
   */
  function assertHasCommits(repoRoot: string): void {
    if (!hasCommits(repoRoot)) throw messages.error('git.noCommits', { branch: currentBranch(repoRoot) })
  }

  /**
   * Точка отсчёта новой ветки от HEAD корня — его текущая ветка (туда сольёт `merge`). Detached HEAD — хеш коммита:
   * слово `HEAD` в worktree означало бы уже его собственный HEAD. Коммитов нет — сначала `assertHasCommits`.
   */
  function headBase(repoRoot: string): string {
    const branch = currentBranch(repoRoot)
    return branch === 'HEAD' ? git(repoRoot, ['rev-parse', 'HEAD']) : branch
  }

  /**
   * Worktree задачи на ветке `branch`: ветка есть — worktree на неё; нет — новая ветка от `base` (ветка глобальной
   * задачи), без `base` — от HEAD корня. Новая ветка требует коммит в репозитории: иначе получилась бы сирота.
   */
  function addTaskWorktree(repoRoot: string, worktree: string, branch: string, base?: string): void {
    if (localBranchExists(repoRoot, branch)) {
      git(repoRoot, ['worktree', 'add', worktree, branch])
      return
    }
    assertHasCommits(repoRoot)
    git(repoRoot, ['worktree', 'add', '-b', branch, worktree, ...(base ? [base] : [])])
  }

  /** Состояние HEAD корня проекта для UI; см. `ProjectBranchInfo` в contracts. */
  function projectBranchInfo(repoRoot: string): ProjectBranchInfo {
    try {
      if (git(repoRoot, ['rev-parse', '--is-inside-work-tree']) !== 'true') return { isGitRepo: false, branch: null, detached: false }
    } catch {
      return { isGitRepo: false, branch: null, detached: false }
    }
    try {
      // symbolic-ref, а не `rev-parse --abbrev-ref`: в репозитории без коммитов последний падает, а этот отдаёт имя ветки.
      const branch = git(repoRoot, ['symbolic-ref', '--short', '-q', 'HEAD'])
      // Сбой самой проверки коммитов (не код 1) — не повод для `unborn`: `projectBranchInfo` не бросает, а UI не должен
      // предлагать начальный коммит по ошибке.
      const unborn = (() => {
        try {
          return !hasCommits(repoRoot)
        } catch {
          return false
        }
      })()
      return unborn ? { isGitRepo: true, branch, detached: false, unborn: true } : { isGitRepo: true, branch, detached: false }
    } catch {
      // код 1 у symbolic-ref — HEAD не на ветке (detached)
      try {
        return { isGitRepo: true, branch: null, detached: true, sha: git(repoRoot, ['rev-parse', '--short', 'HEAD']) }
      } catch {
        return { isGitRepo: true, branch: null, detached: true }
      }
    }
  }

  /**
   * Что накопилось в ветке задачи относительно базовой ветки: ветки глобальной задачи (`reviewBase`) или, без неё,
   * текущей ветки корня. Refs у всех worktree общие, поэтому diff считается из корня.
   */
  function reviewInfo(repoRoot: string, worktree: string, branch: string, base = currentBranch(repoRoot)): ReviewInfo {
    const dirty = existsSync(worktree) && git(worktree, ['status', '--porcelain']) !== ''
    let stat = ''
    let commits: string[] = []
    try {
      stat = git(repoRoot, ['diff', '--stat', `${base}...${branch}`])
      commits = git(repoRoot, ['log', '--oneline', `${base}..${branch}`]).split('\n').filter(Boolean)
    } catch {
      // ветки может ещё не быть
    }
    if (dirty) {
      const wtStat = git(worktree, ['diff', '--stat'])
      const untracked = git(worktree, ['ls-files', '--others', '--exclude-standard'])
      stat = [stat, wtStat, untracked ? `${messages.untrackedLabel()}\n${untracked}` : ''].filter(Boolean).join('\n')
    }
    return { base, branch, stat, commits, dirty }
  }

  /** Незакоммиченное в worktree — коммитим от имени orca, чтобы не потерять при мерже. */
  function commitWorktree(worktree: string, message: string): void {
    if (git(worktree, ['status', '--porcelain']) === '') return
    git(worktree, ['add', '-A'], MUTATE_TIMEOUT_MS)
    try {
      git(worktree, ['-c', 'user.name=orca-board', '-c', 'user.email=orca@local', 'commit', '-q', '-m', message], MUTATE_TIMEOUT_MS)
    } catch (e) {
      throw new Error(`коммит хвостов worktree не удался: ${gitFailure(e, MUTATE_TIMEOUT_MS)}`)
    }
  }

  /**
   * Слить ветку задачи в ветку, выбранную в каталоге `cwd`: worktree глобальной задачи или корень (`mergeTarget`).
   * Не слилось — `MergeError` с текстом git и признаком конфликта; начатое слияние отменяется (`merge --abort`).
   */
  function mergeBranch(cwd: string, branch: string, message: string): void {
    try {
      git(cwd, ['merge', '--no-ff', '-m', message, branch], MUTATE_TIMEOUT_MS)
    } catch (e) {
      const text = gitFailure(e, MUTATE_TIMEOUT_MS)
      // Конфликт — по незаслитым путям в индексе, а не по тексту: его язык зависит от локали git.
      let conflict = false
      try {
        conflict = git(cwd, ['diff', '--name-only', '--diff-filter=U']) !== ''
      } catch {
        /* индекс недоступен — это не конфликт */
      }
      try {
        git(cwd, ['merge', '--abort'], MUTATE_TIMEOUT_MS)
      } catch {
        /* нечего отменять */
      }
      throw new MergeError(`мерж не удался:\n${text}`, conflict)
    }
  }

  /** Убрать только worktree, ветку оставить: работа не слита, но и не потеряна (воркфлоу закончился без мержа). */
  function removeWorktreeKeepBranch(repoRoot: string, worktree: string): void {
    if (existsSync(worktree)) git(repoRoot, ['worktree', 'remove', '--force', worktree], MUTATE_TIMEOUT_MS)
  }

  /**
   * Убрать worktree и ветку. `foreign` — ветку создал не orca (нода `git` переключила worktree на существующую,
   * `Task.branchForeign`): её удалять нельзя, снимается только worktree.
   */
  function removeWorktree(repoRoot: string, worktree: string, branch: string, foreign = false): void {
    if (foreign) {
      removeWorktreeKeepBranch(repoRoot, worktree)
      return
    }
    if (existsSync(worktree)) git(repoRoot, ['worktree', 'remove', '--force', worktree], MUTATE_TIMEOUT_MS)
    // Папку убрали руками — запись worktree осталась, и `branch -D` отказал бы («ветка выгружена в …»).
    else git(repoRoot, ['worktree', 'prune'], MUTATE_TIMEOUT_MS)
    try {
      git(repoRoot, ['branch', '-D', branch])
    } catch {
      /* уже удалена */
    }
  }

  // ---------- git-операции ноды воркфлоу «Git» (docs/workflow.md → «Нода Git») ----------

  /** Сколько ждать сеть (`push`): git выполняется синхронно в main, зависший remote не должен вешать приложение насовсем. */
  const PUSH_TIMEOUT_MS = 120_000

  /** Папка worktree задачи по умолчанию — та же, что создаёт `startWorker`: рядом с репозиторием. */
  function taskWorktreePath(repoRoot: string, taskId: string): string {
    return join(repoRoot, '..', '.orca-worktrees', taskId)
  }

  /**
   * git с понятной ошибкой: `git <команда без -c>: <stderr>`. `GIT_TERMINAL_PROMPT=0` — без запроса пароля в
   * терминале, которого у main нет (иначе `push` зависает на ожидании ввода).
   */
  function opGit(cwd: string, args: string[], timeoutMs?: number): string {
    try {
      return execFileSync('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        ...(timeoutMs ? { timeout: timeoutMs, killSignal: 'SIGKILL' as const } : {})
      }).trim()
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string; message?: string; code?: string }
      const shown: string[] = []
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '-c') i += 1
        else shown.push(args[i])
      }
      const reason = err.code === 'ETIMEDOUT'
        ? `не ответил за ${Math.round((timeoutMs ?? 0) / 1000)} с`
        : (err.stderr?.toString().trim() || err.stdout?.toString().trim() || err.message || 'неизвестная ошибка')
      throw new GitOpError(`git ${shown.join(' ')}: ${reason}`)
    }
  }

  /** Ветка существует локально. */
  function localBranchExists(repoRoot: string, branch: string): boolean {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot, stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }

  /** Имя допустимо для git по-настоящему (`git check-ref-format --branch`); упрощённую проверку core делает исполнитель до этого. */
  function isBranchNameAcceptedByGit(repoRoot: string, name: string): boolean {
    try {
      execFileSync('git', ['check-ref-format', '--branch', name], { cwd: repoRoot, stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }

  /** Ветка, на которой стоит worktree; `undefined` — detached HEAD. */
  function worktreeBranch(worktree: string): string | undefined {
    try {
      return opGit(worktree, ['symbolic-ref', '--short', '-q', 'HEAD'])
    } catch {
      return undefined
    }
  }

  /** `git switch`/`checkout` с грязным деревом может унести правки на другую ветку — поэтому требуем чистоту. */
  function assertClean(worktree: string, action: string): void {
    if (opGit(worktree, ['status', '--porcelain']) !== '') {
      throw new GitOpError(`в worktree есть незакоммиченные изменения — ${action} не выполняется; добавьте перед ним операцию commit`)
    }
  }

  /**
   * Операция `create_branch`: новая ветка `branch` от `base`, worktree — на ней. Worktree ещё нет (нода стоит до первой
   * «Работы») — создаётся сразу на новой ветке, `orca/<id>` не заводится; `base` по умолчанию — текущая ветка корня.
   * Worktree уже есть — переключается на новую ветку; `base` по умолчанию — то место, где он стоит.
   * `own` — `branch` уже записана в задаче (повторный заход в ноду после возврата, конец без мержа): существующая ветка
   * не ошибка, worktree ставится на неё.
   */
  function gitCreateBranch(repoRoot: string, worktree: string, branch: string, base: string | undefined, own: boolean): void {
    if (localBranchExists(repoRoot, branch)) {
      if (!own) throw new GitOpError(`ветка «${branch}» уже существует`)
      checkoutBranch(repoRoot, worktree, branch)
      return
    }
    const verify = (start: string): void => {
      try {
        execFileSync('git', ['rev-parse', '--verify', '--quiet', `${start}^{commit}`], { cwd: repoRoot, stdio: 'pipe' })
      } catch {
        throw new GitOpError(`базовой ветки «${start}» нет — не от чего создавать «${branch}»`)
      }
    }
    // --no-track: иначе ветка от remote-ветки унаследовала бы её upstream, и голый `git push` ушёл бы не туда.
    if (existsSync(worktree)) {
      // Worktree уже есть (нода посреди работы): без `base` ветвимся от того места, где он стоит, — коммиты задачи не теряются.
      assertClean(worktree, 'создание ветки')
      if (base) verify(base)
      opGit(worktree, ['checkout', '-q', '--no-track', '-b', branch, ...(base ? [base] : [])])
      return
    }
    if (!base && !hasCommits(repoRoot)) {
      throw new GitOpError(`в репозитории нет ни одного коммита — не от чего создавать «${branch}»: создайте начальный коммит`)
    }
    const start = base ?? headBase(repoRoot)
    verify(start)
    opGit(repoRoot, ['worktree', 'add', '-q', '--no-track', '-b', branch, worktree, start])
  }

  /** Операция `checkout`: worktree — на существующую локальную ветку; worktree нет — создаётся на ней. */
  function gitCheckout(repoRoot: string, worktree: string, branch: string): void {
    if (!localBranchExists(repoRoot, branch)) throw new GitOpError(`ветки «${branch}» нет`)
    checkoutBranch(repoRoot, worktree, branch)
  }

  function checkoutBranch(repoRoot: string, worktree: string, branch: string): void {
    if (!existsSync(worktree)) {
      opGit(repoRoot, ['worktree', 'add', '-q', worktree, branch])
      return
    }
    if (worktreeBranch(worktree) === branch) return
    assertClean(worktree, 'переключение ветки')
    opGit(worktree, ['checkout', '-q', branch])
  }

  /** Операция `commit`: всё незакоммиченное — одним коммитом от `orca-board`; нечего коммитить — тоже успех. */
  function gitCommit(worktree: string, message: string): void {
    if (!existsSync(worktree)) throw new GitOpError('у задачи нет worktree — коммитить нечего')
    if (opGit(worktree, ['status', '--porcelain']) === '') return
    opGit(worktree, ['add', '-A'])
    opGit(worktree, ['-c', 'user.name=orca-board', '-c', 'user.email=orca@local', 'commit', '-q', '-m', message])
  }

  /** Операция `push`: ветка задачи в `remote` с upstream, без force. */
  function gitPush(repoRoot: string, worktree: string | undefined, remote: string, branch: string): void {
    const cwd = worktree && existsSync(worktree) ? worktree : repoRoot
    opGit(cwd, ['push', '-u', remote, branch], PUSH_TIMEOUT_MS)
  }

  /**
   * Команда подготовки нового worktree по lock-файлу.
   * Это строка для shell платформы (на Windows pnpm/npm/yarn — .cmd-шимы, нужен cmd.exe),
   * запуском занимается worker.ts.
   */
  function setupCommand(worktree: string): string | null {
    if (existsSync(join(worktree, 'pnpm-lock.yaml'))) return 'pnpm install --prefer-offline'
    if (existsSync(join(worktree, 'package-lock.json'))) return 'npm ci'
    if (existsSync(join(worktree, 'yarn.lock'))) return 'yarn install'
    if (existsSync(join(worktree, 'poetry.lock'))) return 'poetry install'
    return null
  }

  // ---------- git корня проекта: ветки, fetch, pull, checkout (IPC `projects:branches` и др.) ----------

  /** Сколько ждать сеть (`fetch`/`pull`): зависший remote не должен держать кнопку в UI бесконечно. */
  const NET_TIMEOUT_MS = 120_000
  /** Локальные операции (список веток, checkout) — секунды; таймаут только против зависшего git. */
  const LOCAL_TIMEOUT_MS = 30_000
  const OUTPUT_LIMIT = 4000

  /** HEAD exit 1 — unborn; сбой Git не выдаём за отсутствие коммитов. */
  async function hasCommitsAsync(root: string): Promise<boolean> {
    const result = await processes.run(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { acceptedExitCodes: [1] })
    return result.code === 0
  }

  function preserveCancellation(error: unknown): void {
    if (error instanceof GitProcessError && error.cancelled) throw error
  }

  /** Совместимый DTO без sync process calls; ошибка metadata не должна предлагать начальный commit. */
  async function projectBranchInfoAsync(root: string): Promise<ProjectBranchInfo> {
    try {
      if ((await processes.run(root, ['rev-parse', '--is-inside-work-tree'])).stdout.trim() !== 'true') return { isGitRepo: false, branch: null, detached: false }
    } catch (error) { preserveCancellation(error); return { isGitRepo: false, branch: null, detached: false } }
    let branch: string | undefined
    try {
      const result = await processes.run(root, ['symbolic-ref', '--short', '-q', 'HEAD'], { acceptedExitCodes: [1] })
      if (result.code === 0) branch = result.stdout.trim()
    } catch (error) { preserveCancellation(error) }
    if (branch !== undefined) {
      let unborn = false
      try { unborn = !await hasCommitsAsync(root) } catch (error) { preserveCancellation(error) }
      return unborn ? { isGitRepo: true, branch, detached: false, unborn: true } : { isGitRepo: true, branch, detached: false }
    }
    try {
      const sha = (await processes.run(root, ['rev-parse', '--short', 'HEAD'])).stdout.trim()
      return { isGitRepo: true, branch: null, detached: true, sha }
    } catch (error) { preserveCancellation(error); return { isGitRepo: true, branch: null, detached: true } }
  }

  /**
   * Асинхронно, а не `execFileSync`: `fetch` идёт до двух минут, синхронный вызов заморозил бы окно и терминалы.
   * `input` — stdin команды (`hash-object --stdin`); service закрывает stdin и владеет деревом hooks.
   */
  async function runGit(cwd: string, args: string[], timeoutMs = LOCAL_TIMEOUT_MS, input?: string): Promise<{ stdout: string; stderr: string }> {
    try { return await processes.run(cwd, args, { timeoutMs, input }) }
    catch (e) { throw opFailed(args, e, timeoutMs) }
  }

  const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

  function tail(text: string, limit: number): string {
    const clean = text.replace(ANSI, '').trim()
    return clean.length > limit ? `…${clean.slice(clean.length - limit)}` : clean
  }

  /** `git.opFailed` с командой без `-c` и stderr git; таймаут — отдельным текстом. */
  function opFailed(args: string[], e: unknown, timeoutMs: number): Error {
    if (e instanceof GitProcessError && e.cancelled) return e
    const err = e as { stderr?: string; stdout?: string; message?: string; killed?: boolean; code?: string | number }
    const shown: string[] = []
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '-c') i += 1
      else shown.push(args[i])
    }
    const error = e instanceof GitProcessError ? e.timedOut
      ? { key: 'git.timeout' as const, params: { seconds: Math.round(timeoutMs / 1000) } }
      : tail(e.stderr || e.stdout || e.message, 1000) || String(e.code ?? '?') : err.killed
      ? { key: 'git.timeout' as const, params: { seconds: Math.round(timeoutMs / 1000) } }
      : tail(err.stderr?.toString() || err.stdout?.toString() || err.message || '', 1000) || String(err.code ?? '?')
    return messages.error('git.opFailed', { command: shown.join(' '), error })
  }

  /** Очередь одна для общего repo, включая linked worktree и symlink; другие repo не ждут. */
  async function serial<T>(root: string, fn: () => Promise<T>): Promise<T> {
    let key: string
    try { key = await canonicalGitCommonDir(root, processes) }
    catch (error) {
      if (error instanceof GitProcessError && error.cancelled) throw error
      throw messages.error('git.notRepo', { path: root })
    }
    return operationQueue.enqueue(key, fn)
  }

  async function checked<T>(promise: Promise<T>, guard: () => void): Promise<T> {
    const result = await promise; guard(); return result
  }

  async function assertRepo(root: string, guard: () => void): Promise<void> {
    if (!(await checked(projectBranchInfoAsync(root), guard)).isGitRepo) throw messages.error('git.notRepo', { path: root })
  }

  /** Ветка → путь worktree, где она checked out (по `git worktree list --porcelain`), включая корень. */
  async function checkedOutBranches(root: string): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    let path = ''
    for (const line of (await runGit(root, ['worktree', 'list', '--porcelain'])).stdout.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
      else if (line.startsWith('branch refs/heads/')) out.set(line.slice('branch refs/heads/'.length), path)
    }
    return out
  }

  async function refNames(root: string, prefix: 'refs/heads/' | 'refs/remotes/'): Promise<string[]> {
    const { stdout } = await runGit(root, ['for-each-ref', '--format=%(refname)', prefix])
    return stdout.split('\n').filter((r) => r.startsWith(prefix)).map((r) => r.slice(prefix.length))
  }

  /** Upstream ветки и расхождение с ним по уже полученным refs; нет upstream — `undefined`. */
  async function branchUpstream(root: string, branch: string): Promise<ProjectBranchUpstream | undefined> {
    const { stdout } = await runGit(root, ['for-each-ref', '--format=%(upstream:short)%09%(upstream:track)', `refs/heads/${branch}`])
    const [name, track] = stdout.trim().split('\t')
    if (!name) return undefined
    if (track?.includes('gone')) return { name, ahead: 0, behind: 0, gone: true }
    const counts = (await runGit(root, ['rev-list', '--left-right', '--count', `refs/heads/${branch}...${name}`])).stdout.trim().split(/\s+/)
    return { name, ahead: Number(counts[0]) || 0, behind: Number(counts[1]) || 0, gone: false }
  }

  /** Ветки корня проекта без сети. Не репозиторий — `isGitRepo: false`, без исключения. */
  async function projectBranches(root: string): Promise<ProjectBranchList> {
    const current = await projectBranchInfoAsync(root)
    if (!current.isGitRepo) return { isGitRepo: false, current, local: [], remote: [], dirty: false }
    const [locals, remotes, worktrees, status] = await Promise.all([
      refNames(root, 'refs/heads/'),
      refNames(root, 'refs/remotes/'),
      checkedOutBranches(root),
      runGit(root, ['status', '--porcelain'])
    ])
    const local: ProjectLocalBranch[] = locals.sort().map((name) => {
      const isCurrent = name === current.branch
      return { name, current: isCurrent, busy: !isCurrent && worktrees.has(name) }
    })
    const remote = remotes.filter((r) => r.includes('/') && !r.endsWith('/HEAD')).sort()
    const upstream = current.branch && locals.includes(current.branch) ? await branchUpstream(root, current.branch) : undefined
    return { isGitRepo: true, current, local, remote, ...(upstream ? { upstream } : {}), dirty: status.stdout.trim() !== '' }
  }

  async function gitResult(root: string, out: { stdout: string; stderr: string }): Promise<ProjectGitResult> {
    return { output: tail([out.stdout, out.stderr].filter((t) => t.trim()).join('\n'), OUTPUT_LIMIT), branch: await projectBranchInfoAsync(root) }
  }

  /** `git fetch --all --prune`: HEAD и рабочее дерево не трогает. */
  function projectFetch(root: string, guard: () => void = () => {}): Promise<ProjectGitResult> {
    return serial(root, async () => {
      guard()
      await assertRepo(root, guard)
      const result = await checked(runGit(root, ['fetch', '--all', '--prune'], NET_TIMEOUT_MS), guard)
      return checked(gitResult(root, result), guard)
    })
  }

  /**
   * `pull --ff-only` текущей ветки: `fetch` remote'а upstream, затем `merge --ff-only`. Два шага, а не голый `git pull`,
   * чтобы «ветка разошлась» отличать от сети и правок в дереве по факту (предок ли HEAD у upstream), а не по тексту
   * ошибки git, который зависит от локали.
   */
  function projectPull(root: string, guard: () => void = () => {}): Promise<ProjectGitResult> {
    return serial(root, async () => {
      guard()
      await assertRepo(root, guard)
      const { branch } = await checked(projectBranchInfoAsync(root), guard)
      if (!branch) throw messages.error('git.noUpstream', { branch: 'HEAD' })
      const upstream = await checked(branchUpstream(root, branch).catch(error => { preserveCancellation(error); return undefined }), guard)
      if (!upstream || upstream.gone) throw messages.error('git.noUpstream', { branch })
      const remote = (await checked(runGit(root, ['config', '--get', `branch.${branch}.remote`]).catch(error => { preserveCancellation(error); return { stdout: '' } }), guard)).stdout.trim()
      const fetched = remote && remote !== '.' ? await checked(runGit(root, ['fetch', remote], NET_TIMEOUT_MS), guard) : { stdout: '', stderr: '' }
      let merged: { stdout: string; stderr: string }
      try {
        merged = await runGit(root, ['merge', '--ff-only', `${branch}@{upstream}`])
      } catch (e) {
        preserveCancellation(e); guard()
        // Не fast-forward — если HEAD не предок upstream. Иначе причина другая (правки в дереве мешают): показываем ошибку git.
        const ancestor = await checked(runGit(root, ['merge-base', '--is-ancestor', 'HEAD', `${branch}@{upstream}`]).then(() => true, error => { preserveCancellation(error); return false }), guard)
        if (!ancestor) throw messages.error('git.notFastForward', { branch, upstream: upstream.name })
        throw e
      }
      guard()
      return checked(gitResult(root, { stdout: [fetched.stdout, merged.stdout].join('\n'), stderr: fetched.stderr }), guard)
    })
  }

  /**
   * Переключить корень проекта на ветку. `liveAgents` — сколько живых воркеров и координаторов в проекте: считает
   * вызывающий (host), git о них не знает. Порядок проверок: репозиторий → та же ветка (не ошибка) → ветка
   * существует → живые агенты → ветка в другом worktree → незакоммиченные изменения.
   */
  function checkoutProjectBranch(root: string, branch: string, liveAgents: number | (() => number), guard: () => void = () => {}): Promise<ProjectBranchInfo> {
    return serial(root, async () => {
      guard()
      await assertRepo(root, guard)
      const current = await checked(projectBranchInfoAsync(root), guard)
      if (current.branch === branch) return current
      const locals = await checked(refNames(root, 'refs/heads/'), guard)
      let local: string | undefined
      let track: string | undefined
      if (locals.includes(branch)) {
        local = branch
      } else {
        const remoteRefs = (await checked(refNames(root, 'refs/remotes/'), guard)).filter((r) => !r.endsWith('/HEAD'))
        if (!remoteRefs.includes(branch)) throw messages.error('git.branchNotFound', { branch })
        // Имя remote может содержать «/» — берём самый длинный подходящий.
        const remotes = (await checked(runGit(root, ['remote']), guard)).stdout.split('\n').filter(Boolean)
        const remote = remotes.filter((r) => branch.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0]
        if (!remote) throw messages.error('git.branchNotFound', { branch })
        local = branch.slice(remote.length + 1)
        if (!locals.includes(local)) track = branch
      }
      const assertAgentsIdle = () => {
        const count = typeof liveAgents === 'function' ? liveAgents() : liveAgents
        if (count > 0) throw messages.error('git.workersActive', { count })
      }
      assertAgentsIdle()
      const busyPath = (await checked(checkedOutBranches(root), guard)).get(local)
      // Unborn HEAD тоже указан в worktree list: свой корень не является чужим занятым worktree.
      let ownRoot = busyPath === root
      if (busyPath !== undefined && !ownRoot) {
        try { const paths = await Promise.all([realpath(busyPath), realpath(root)]); ownRoot = paths[0] === paths[1] }
        catch { /* Недоступный чужой worktree остаётся занятым. */ }
        guard()
      }
      if (busyPath !== undefined && !ownRoot) throw messages.error('git.branchBusy', { branch: local, path: busyPath })
      if ((await checked(runGit(root, ['status', '--porcelain']), guard)).stdout.trim() !== '') throw messages.error('git.dirtyTree')
      // Завершающий `--` — имя ветки не должно читаться как путь файла; имя, начинающееся с «-», сюда не дойдёт: такой ветки нет.
      guard(); assertAgentsIdle()
      if (track) await checked(runGit(root, ['checkout', '-q', '--track', '-b', local, track, '--']), guard)
      else await checked(runGit(root, ['checkout', '-q', local, '--']), guard)
      return checked(projectBranchInfoAsync(root), guard)
    })
  }

  const INITIAL_COMMIT_MESSAGE = 'chore: начальный коммит (orca-board)'

  /**
   * Автор начального коммита: `user.name`/`user.email` человека, если заданы оба, иначе orca-board, как в `commitWorktree`.
   * Без этого на машине без настроенной идентичности git отказал бы «Please tell me who you are».
   * `config --get` с кодом 1 — ключ не задан.
   */
  async function identityArgs(root: string): Promise<string[]> {
    const get = (key: string): Promise<string> =>
      runGit(root, ['config', '--get', key]).then((r) => r.stdout.trim(), error => { preserveCancellation(error); return '' })
    const [name, email] = await Promise.all([get('user.name'), get('user.email')])
    return name && email ? [] : ['-c', 'user.name=orca-board', '-c', 'user.email=orca@local']
  }

  /**
   * Начальный коммит в репозитории без коммитов (unborn HEAD) — только по согласию человека (IPC `projects:createInitialCommit`).
   * Идемпотентно: коммиты уже есть (человек успел сам) — ничего не делает. `empty` — plumbing: пустое дерево → `commit-tree` →
   * `update-ref HEAD <c> ""`; пустой старый ref значит «HEAD ещё не должен существовать», так гонка с человеком не перетрёт его
   * коммит. Индекс и рабочее дерево не трогаются; `commit --allow-empty` не годится — он забирает staged-файлы. Хеш пустого
   * дерева не хардкодим: в SHA-256-репозитории он другой. `snapshot` — `add -A` + `commit` с сетевым таймаутом: без
   * `.gitignore` в коммит может попасть `node_modules`.
   */
  function createInitialCommit(root: string, mode: InitialCommitMode, guard: () => void = () => {}): Promise<ProjectBranchInfo> {
    return serial(root, async () => {
      guard()
      await assertRepo(root, guard)
      if (await checked(hasCommitsAsync(root), guard)) return checked(projectBranchInfoAsync(root), guard)
      const identity = await checked(identityArgs(root), guard)
      if (mode === 'snapshot') {
        await checked(runGit(root, ['add', '-A'], NET_TIMEOUT_MS), guard)
        await checked(runGit(root, [...identity, 'commit', '-q', '--allow-empty', '-m', INITIAL_COMMIT_MESSAGE], NET_TIMEOUT_MS), guard)
      } else {
        const tree = (await checked(runGit(root, ['hash-object', '-t', 'tree', '-w', '--stdin'], LOCAL_TIMEOUT_MS, ''), guard)).stdout.trim()
        const commit = (await checked(runGit(root, [...identity, 'commit-tree', tree, '-m', INITIAL_COMMIT_MESSAGE]), guard)).stdout.trim()
        await checked(runGit(root, ['update-ref', '-m', INITIAL_COMMIT_MESSAGE, 'HEAD', commit, '']), guard)
      }
      return checked(projectBranchInfoAsync(root), guard)
    })
  }

  // ---------- игнорируемое git'ом для `files:list` (main/project-files.ts) ----------

  /** Проверка игнора локальная; таймаут — только против зависшего git (сетевой диск, огромный индекс). */
  const CHECK_IGNORE_TIMEOUT_MS = 10_000

  /**
   * Какие из `paths` (относительно `cwd`, папки — с `/` на конце: шаблон `node_modules/` действует только на папки)
   * git игнорирует. Git сам применяет вложенные `.gitignore`, `.git/info/exclude`, глобальные excludes и отрицания `!`;
   * отслеживаемые файлы игнорируемыми не считаются — как в `git status`. Пути идут через stdin, а не argv: в папке
   * тысячи записей, а командная строка Windows ограничена 32 767 знаками.
   * Код выхода 1 — «ничего не игнорируется», для `execFile` это ошибка, но ответ пустой. Прочее (128 — не репозиторий,
   * «dubious ownership», git не найден, таймаут) — `git.opFailed`: вызывающий решает, как жить без фильтра.
   */
  async function gitCheckIgnore(cwd: string, paths: string[]): Promise<Set<string>> {
    if (paths.length === 0) return new Set()
    const args = ['check-ignore', '-z', '--stdin']
    try {
      const { stdout } = await processes.run(cwd, args, { timeoutMs: CHECK_IGNORE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
        input: paths.join('\0') + '\0', acceptedExitCodes: [1] })
      return new Set(stdout.split('\0').filter(Boolean))
    } catch (e) { throw opFailed(args, e, CHECK_IGNORE_TIMEOUT_MS) }
  }

  return {
    currentBranch, hasCommits, assertHasCommits, headBase, addTaskWorktree, projectBranchInfo,
    reviewInfo, commitWorktree, mergeBranch, removeWorktreeKeepBranch, removeWorktree,
    taskWorktreePath, localBranchExists, isBranchNameAcceptedByGit, gitCreateBranch, gitCheckout, gitCommit, gitPush, setupCommand,
    projectBranchInfoAsync, hasCommitsAsync, projectBranches, projectFetch, projectPull, checkoutProjectBranch, createInitialCommit, gitCheckIgnore
  }
}

export type GitOperations = ReturnType<typeof createGitOperations>
