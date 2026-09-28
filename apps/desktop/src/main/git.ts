import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { mt, OrcaError } from './i18n'
import type { ProjectBranchInfo, ProjectBranchList, ProjectBranchUpstream, ProjectGitResult, ProjectLocalBranch } from '../shared/ipc'

// git вызывается только массивом аргументов без shell: на Windows execFileSync находит git.exe через PATH,
// сами команды (worktree, merge, branch, status, diff) одинаковы на всех платформах.
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim()
}

export function currentBranch(repoRoot: string): string {
  return git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
}

/** Состояние HEAD корня проекта для UI; см. `ProjectBranchInfo` в `shared/ipc.ts`. */
export function projectBranchInfo(repoRoot: string): ProjectBranchInfo {
  try {
    if (git(repoRoot, ['rev-parse', '--is-inside-work-tree']) !== 'true') return { isGitRepo: false, branch: null, detached: false }
  } catch {
    return { isGitRepo: false, branch: null, detached: false }
  }
  try {
    // symbolic-ref, а не `rev-parse --abbrev-ref`: в репозитории без коммитов последний падает, а этот отдаёт имя ветки.
    return { isGitRepo: true, branch: git(repoRoot, ['symbolic-ref', '--short', '-q', 'HEAD']), detached: false }
  } catch {
    // код 1 у symbolic-ref — HEAD не на ветке (detached)
    try {
      return { isGitRepo: true, branch: null, detached: true, sha: git(repoRoot, ['rev-parse', '--short', 'HEAD']) }
    } catch {
      return { isGitRepo: true, branch: null, detached: true }
    }
  }
}

export interface ReviewInfo {
  base: string
  branch: string
  stat: string
  commits: string[]
  dirty: boolean
}

/**
 * Что накопилось в ветке задачи относительно базовой ветки: ветки глобальной задачи (`reviewBase`) или, без неё,
 * текущей ветки корня. Refs у всех worktree общие, поэтому diff считается из корня.
 */
export function reviewInfo(repoRoot: string, worktree: string, branch: string, base = currentBranch(repoRoot)): ReviewInfo {
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

/**
 * Слить ветку задачи в ветку, выбранную в каталоге `cwd`: worktree глобальной задачи или корень (`mergeTarget`).
 * Бросает с текстом конфликта.
 */
export function mergeBranch(cwd: string, branch: string, message: string): void {
  try {
    execFileSync('git', ['merge', '--no-ff', '-m', message, branch], { cwd, stdio: 'pipe', encoding: 'utf8' })
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    try {
      execFileSync('git', ['merge', '--abort'], { cwd, stdio: 'pipe', encoding: 'utf8' })
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

// ---------- git корня проекта: ветки, fetch, pull, checkout (IPC `projects:branches` и др.) ----------

const execFileAsync = promisify(execFile)

/** Сколько ждать сеть (`fetch`/`pull`): зависший remote не должен держать кнопку в UI бесконечно. */
const NET_TIMEOUT_MS = 120_000
/** Локальные операции (список веток, checkout) — секунды; таймаут только против зависшего git. */
const LOCAL_TIMEOUT_MS = 30_000
const OUTPUT_LIMIT = 4000

/** Асинхронно, а не `execFileSync`: `fetch` идёт до двух минут, синхронный вызов заморозил бы окно и терминалы. */
async function runGit(cwd: string, args: string[], timeoutMs = LOCAL_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
      // GIT_TERMINAL_PROMPT=0 — без запроса пароля в терминале, которого у main нет; NO_COLOR/GIT_PAGER — чистый вывод для UI.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', GIT_PAGER: 'cat' }
    })
    return { stdout, stderr }
  } catch (e) {
    throw opFailed(args, e, timeoutMs)
  }
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

function tail(text: string, limit: number): string {
  const clean = text.replace(ANSI, '').trim()
  return clean.length > limit ? `…${clean.slice(clean.length - limit)}` : clean
}

/** `git.opFailed` с командой без `-c` и stderr git; таймаут — отдельным текстом. */
function opFailed(args: string[], e: unknown, timeoutMs: number): OrcaError {
  const err = e as { stderr?: string; stdout?: string; message?: string; killed?: boolean; code?: string | number }
  const shown: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-c') i += 1
    else shown.push(args[i])
  }
  const error = err.killed
    ? { key: 'git.timeout' as const, params: { seconds: Math.round(timeoutMs / 1000) } }
    : tail(err.stderr?.toString() || err.stdout?.toString() || err.message || '', 1000) || String(err.code ?? '?')
  return new OrcaError('git.opFailed', { command: shown.join(' '), error })
}

/** Операции над одним корнем идут по очереди: двойной клик «fetch» или checkout во время pull не должны драться за index.lock. */
const rootQueues = new Map<string, Promise<unknown>>()

function serial<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const next = (rootQueues.get(root) ?? Promise.resolve()).catch(() => undefined).then(fn)
  rootQueues.set(root, next)
  const cleanup = (): void => {
    if (rootQueues.get(root) === next) rootQueues.delete(root)
  }
  next.then(cleanup, cleanup)
  return next
}

function assertRepo(root: string): void {
  if (!projectBranchInfo(root).isGitRepo) throw new OrcaError('git.notRepo', { path: root })
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
export async function projectBranches(root: string): Promise<ProjectBranchList> {
  const current = projectBranchInfo(root)
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

function gitResult(root: string, out: { stdout: string; stderr: string }): ProjectGitResult {
  return { output: tail([out.stdout, out.stderr].filter((t) => t.trim()).join('\n'), OUTPUT_LIMIT), branch: projectBranchInfo(root) }
}

/** `git fetch --all --prune`: HEAD и рабочее дерево не трогает. */
export function projectFetch(root: string): Promise<ProjectGitResult> {
  return serial(root, async () => {
    assertRepo(root)
    return gitResult(root, await runGit(root, ['fetch', '--all', '--prune'], NET_TIMEOUT_MS))
  })
}

/**
 * `pull --ff-only` текущей ветки: `fetch` remote'а upstream, затем `merge --ff-only`. Два шага, а не голый `git pull`,
 * чтобы «ветка разошлась» отличать от сети и правок в дереве по факту (предок ли HEAD у upstream), а не по тексту
 * ошибки git, который зависит от локали.
 */
export function projectPull(root: string): Promise<ProjectGitResult> {
  return serial(root, async () => {
    assertRepo(root)
    const { branch } = projectBranchInfo(root)
    if (!branch) throw new OrcaError('git.noUpstream', { branch: 'HEAD' })
    const upstream = await branchUpstream(root, branch).catch(() => undefined)
    if (!upstream || upstream.gone) throw new OrcaError('git.noUpstream', { branch })
    const remote = (await runGit(root, ['config', '--get', `branch.${branch}.remote`]).catch(() => ({ stdout: '' }))).stdout.trim()
    const fetched = remote && remote !== '.' ? await runGit(root, ['fetch', remote], NET_TIMEOUT_MS) : { stdout: '', stderr: '' }
    try {
      const merged = await runGit(root, ['merge', '--ff-only', `${branch}@{upstream}`])
      return gitResult(root, { stdout: [fetched.stdout, merged.stdout].join('\n'), stderr: fetched.stderr })
    } catch (e) {
      // Не fast-forward — если HEAD не предок upstream. Иначе причина другая (правки в дереве мешают): показываем ошибку git.
      const ancestor = await runGit(root, ['merge-base', '--is-ancestor', 'HEAD', `${branch}@{upstream}`]).then(() => true, () => false)
      if (!ancestor) throw new OrcaError('git.notFastForward', { branch, upstream: upstream.name })
      throw e
    }
  })
}

/**
 * Переключить корень проекта на ветку. `liveAgents` — сколько живых воркеров и координаторов в проекте: считает
 * вызывающий (`index.ts`), git о них не знает. Порядок проверок: репозиторий → та же ветка (не ошибка) → ветка
 * существует → живые агенты → ветка в другом worktree → незакоммиченные изменения.
 */
export function checkoutProjectBranch(root: string, branch: string, liveAgents: number): Promise<ProjectBranchInfo> {
  return serial(root, async () => {
    assertRepo(root)
    const current = projectBranchInfo(root)
    if (current.branch === branch) return current
    const locals = await refNames(root, 'refs/heads/')
    let local: string | undefined
    let track: string | undefined
    if (locals.includes(branch)) {
      local = branch
    } else {
      const remoteRefs = (await refNames(root, 'refs/remotes/')).filter((r) => !r.endsWith('/HEAD'))
      if (!remoteRefs.includes(branch)) throw new OrcaError('git.branchNotFound', { branch })
      // Имя remote может содержать «/» — берём самый длинный подходящий.
      const remotes = (await runGit(root, ['remote'])).stdout.split('\n').filter(Boolean)
      const remote = remotes.filter((r) => branch.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0]
      if (!remote) throw new OrcaError('git.branchNotFound', { branch })
      local = branch.slice(remote.length + 1)
      if (!locals.includes(local)) track = branch
    }
    if (liveAgents > 0) throw new OrcaError('git.workersActive', { count: liveAgents })
    const busyPath = (await checkedOutBranches(root)).get(local)
    if (busyPath !== undefined) throw new OrcaError('git.branchBusy', { branch: local, path: busyPath })
    if ((await runGit(root, ['status', '--porcelain'])).stdout.trim() !== '') throw new OrcaError('git.dirtyTree')
    // Завершающий `--` — имя ветки не должно читаться как путь файла; имя, начинающееся с «-», сюда не дойдёт: такой ветки нет.
    if (track) await runGit(root, ['checkout', '-q', '--track', '-b', local, track, '--'])
    else await runGit(root, ['checkout', '-q', local, '--'])
    return projectBranchInfo(root)
  })
}
