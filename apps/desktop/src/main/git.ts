import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { mt } from './i18n'

// git вызывается только массивом аргументов без shell: на Windows execFileSync находит git.exe через PATH,
// сами команды (worktree, merge, branch, status, diff) одинаковы на всех платформах.
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim()
}

export function currentBranch(repoRoot: string): string {
  return git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
}

export interface ReviewInfo {
  base: string
  branch: string
  stat: string
  commits: string[]
  dirty: boolean
}

/** Что накопилось в ветке задачи относительно базовой ветки. */
export function reviewInfo(repoRoot: string, worktree: string, branch: string): ReviewInfo {
  const base = currentBranch(repoRoot)
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
    stat = [stat, wtStat, untracked ? `${mt('review.untracked')}\n${untracked}` : ''].filter(Boolean).join('\n')
  }
  return { base, branch, stat, commits, dirty }
}

/** Незакоммиченное в worktree — коммитим от имени orca, чтобы не потерять при мерже. */
export function commitWorktree(worktree: string, message: string): void {
  if (git(worktree, ['status', '--porcelain']) === '') return
  git(worktree, ['add', '-A'])
  execFileSync('git', ['-c', 'user.name=orca-board', '-c', 'user.email=orca@local', 'commit', '-q', '-m', message], {
    cwd: worktree,
    stdio: 'pipe',
    encoding: 'utf8'
  })
}

/** Слить ветку задачи в текущую ветку репозитория. Бросает с текстом конфликта. */
export function mergeBranch(repoRoot: string, branch: string, message: string): void {
  try {
    execFileSync('git', ['merge', '--no-ff', '-m', message, branch], { cwd: repoRoot, stdio: 'pipe', encoding: 'utf8' })
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    try {
      execFileSync('git', ['merge', '--abort'], { cwd: repoRoot, stdio: 'pipe', encoding: 'utf8' })
    } catch {
      /* нечего отменять */
    }
    throw new Error(`мерж не удался:\n${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`.trim())
  }
}

/** Убрать только worktree, ветку оставить: работа не слита, но и не потеряна (воркфлоу закончился без мержа). */
export function removeWorktreeKeepBranch(repoRoot: string, worktree: string): void {
  if (existsSync(worktree)) git(repoRoot, ['worktree', 'remove', '--force', worktree])
}

/**
 * Убрать worktree и ветку. `foreign` — ветку создал не orca (нода `git` переключила worktree на существующую,
 * `Task.branchForeign`): её удалять нельзя, снимается только worktree.
 */
export function removeWorktree(repoRoot: string, worktree: string, branch: string, foreign = false): void {
  if (foreign) {
    removeWorktreeKeepBranch(repoRoot, worktree)
    return
  }
  if (existsSync(worktree)) git(repoRoot, ['worktree', 'remove', '--force', worktree])
  try {
    git(repoRoot, ['branch', '-D', branch])
  } catch {
    /* уже удалена */
  }
}

// ---------- git-операции ноды воркфлоу «Git» (docs/workflow.md → «Нода Git») ----------

/** Отказ git-операции ноды: текст `git <команда>: <причина>` уходит в `task.feedback` и исход `error`. */
export class GitOpError extends Error {}

/** Сколько ждать сеть (`push`): git выполняется синхронно в main, зависший remote не должен вешать приложение насовсем. */
const PUSH_TIMEOUT_MS = 120_000

/** Папка worktree задачи по умолчанию — та же, что создаёт `startWorker`: рядом с репозиторием. */
export function taskWorktreePath(repoRoot: string, taskId: string): string {
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
export function isBranchNameAcceptedByGit(repoRoot: string, name: string): boolean {
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

/**
 * Точка отсчёта новой ветки по умолчанию — текущая ветка корня репозитория (та, куда сольёт `merge`). Detached HEAD
 * корня — хеш коммита: слово `HEAD` в worktree означало бы уже его собственный HEAD.
 */
function defaultBase(repoRoot: string): string {
  const branch = currentBranch(repoRoot)
  return branch === 'HEAD' ? opGit(repoRoot, ['rev-parse', 'HEAD']) : branch
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
export function gitCreateBranch(repoRoot: string, worktree: string, branch: string, base: string | undefined, own: boolean): void {
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
  const start = base ?? defaultBase(repoRoot)
  verify(start)
  opGit(repoRoot, ['worktree', 'add', '-q', '--no-track', '-b', branch, worktree, start])
}

/** Операция `checkout`: worktree — на существующую локальную ветку; worktree нет — создаётся на ней. */
export function gitCheckout(repoRoot: string, worktree: string, branch: string): void {
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
export function gitCommit(worktree: string, message: string): void {
  if (!existsSync(worktree)) throw new GitOpError('у задачи нет worktree — коммитить нечего')
  if (opGit(worktree, ['status', '--porcelain']) === '') return
  opGit(worktree, ['add', '-A'])
  opGit(worktree, ['-c', 'user.name=orca-board', '-c', 'user.email=orca@local', 'commit', '-q', '-m', message])
}

/** Операция `push`: ветка задачи в `remote` с upstream, без force. */
export function gitPush(repoRoot: string, worktree: string | undefined, remote: string, branch: string): void {
  const cwd = worktree && existsSync(worktree) ? worktree : repoRoot
  opGit(cwd, ['push', '-u', remote, branch], PUSH_TIMEOUT_MS)
}

/**
 * Команда подготовки нового worktree по lock-файлу.
 * Это строка для shell платформы (на Windows pnpm/npm/yarn — .cmd-шимы, нужен cmd.exe),
 * запуском занимается worker.ts.
 */
export function setupCommand(worktree: string): string | null {
  if (existsSync(join(worktree, 'pnpm-lock.yaml'))) return 'pnpm install --prefer-offline'
  if (existsSync(join(worktree, 'package-lock.json'))) return 'npm ci'
  if (existsSync(join(worktree, 'yarn.lock'))) return 'yarn install'
  if (existsSync(join(worktree, 'poetry.lock'))) return 'poetry install'
  return null
}
