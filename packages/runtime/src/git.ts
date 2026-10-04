import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { InitialCommitMode, ProjectBranchInfo, ProjectBranchList, ProjectBranchUpstream, ProjectGitResult, ProjectLocalBranch } from '@orca-board/contracts'
import { canonicalGitCommonDir, createGitOperationQueue, type GitOperationQueue } from './git-operation-queue.ts'
import { createGitProcessService, GitProcessError, type GitProcessService } from './git-process.ts'

import { GitOpError, type GitMessages } from './git-errors.ts'
import { createGitWorkflowService } from './git-workflow.ts'
import { gitNativeEffect, nativeOnlyGitObserver } from './git-effects.ts'
import type { EffectJournal } from './effect-journal.ts'
export * from './git-errors.ts'

/** Один экземпляр операций на owner; callbacks не привязывают runtime к глобальному языку Desktop. */
export function createGitOperations(messages: GitMessages, operationQueue: GitOperationQueue = createGitOperationQueue(), processes: GitProcessService = createGitProcessService(), journal?: () => EffectJournal | undefined) {
  const workflowGit = createGitWorkflowService(messages, operationQueue, processes, root => nativeOnlyGitObserver(journal, root))

  /** Совместимые именованные методы; алгоритмы существуют только в scoped async port. */
  const currentBranch = (root: string) => workflowGit.read(root, repo => repo.currentBranch())
  const hasCommits = (root: string) => workflowGit.read(root, repo => repo.hasCommits())
  const assertHasCommits = (root: string) => workflowGit.read(root, repo => repo.assertHasCommits())
  const headBase = (root: string) => workflowGit.read(root, repo => repo.headBase())
  const localBranchExists = (root: string, branch: string) => workflowGit.read(root, repo => repo.localBranchExists(branch))
  const isBranchNameAcceptedByGit = (root: string, branch: string) => workflowGit.read(root, repo => repo.isBranchNameAcceptedByGit(branch))
  const reviewInfo = (root: string, worktree: string, branch: string, base?: string) =>
    workflowGit.read(root, repo => repo.reviewInfo(worktree, branch, base))
  const addTaskWorktree = (root: string, worktree: string, branch: string, base?: string) =>
    workflowGit.transaction(root, repo => repo.addTaskWorktree(worktree, branch, base))
  const commitWorktree = (worktree: string, message: string) =>
    workflowGit.transaction(worktree, repo => repo.commitWorktree(worktree, message))
  const mergeBranch = (cwd: string, branch: string, message: string) =>
    workflowGit.transaction(cwd, repo => repo.mergeBranch(cwd, branch, message))
  const removeWorktreeKeepBranch = (root: string, worktree: string) =>
    workflowGit.transaction(root, repo => repo.removeWorktreeKeepBranch(worktree))
  const removeWorktree = (root: string, worktree: string, branch: string, foreign = false) =>
    workflowGit.transaction(root, repo => repo.removeWorktree(worktree, branch, foreign))
  const gitCreateBranch = (root: string, worktree: string, branch: string, base: string | undefined, own: boolean) =>
    workflowGit.transaction(root, repo => repo.gitCreateBranch(worktree, branch, base, own))
  const gitCheckout = (root: string, worktree: string, branch: string) =>
    workflowGit.transaction(root, repo => repo.gitCheckout(worktree, branch))
  async function gitCommit(worktree: string, message: string): Promise<void> {
    // Без worktree нельзя определить commonDir; сохраняем прежний отказ до входа в очередь.
    if (!existsSync(worktree)) throw new GitOpError('у задачи нет worktree — коммитить нечего')
    await workflowGit.transaction(worktree, repo => repo.gitCommit(worktree, message))
  }
  const gitPush = (root: string, worktree: string | undefined, remote: string, branch: string) =>
    workflowGit.transaction(root, repo => repo.gitPush(worktree, remote, branch))

  /** Папка worktree задачи рядом с репозиторием. */
  function taskWorktreePath(repoRoot: string, taskId: string): string {
    return join(repoRoot, '..', '.orca-worktrees', taskId)
  }

  /** Команду подготовки по lock-файлу запускает launcher платформы. */
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
    const effect = gitNativeEffect(cwd, args); const tracker = effect ? nativeOnlyGitObserver(journal, cwd)(effect) : undefined
    let result: { stdout: string; stderr: string }
    try { result = await processes.run(cwd, args, { timeoutMs, input }) }
    catch (e) { tracker?.failed(); throw opFailed(args, e, timeoutMs) }
    tracker?.completed(); return result
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
    workflowGit,
    currentBranch, hasCommits, assertHasCommits, headBase, addTaskWorktree, projectBranchInfo: projectBranchInfoAsync,
    reviewInfo, commitWorktree, mergeBranch, removeWorktreeKeepBranch, removeWorktree,
    taskWorktreePath, localBranchExists, isBranchNameAcceptedByGit, gitCreateBranch, gitCheckout, gitCommit, gitPush, setupCommand,
    projectBranchInfoAsync, hasCommitsAsync, projectBranches, projectFetch, projectPull, checkoutProjectBranch, createInitialCommit, gitCheckIgnore
  }
}

export type GitOperations = ReturnType<typeof createGitOperations>
