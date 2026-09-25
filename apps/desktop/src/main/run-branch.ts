import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  globalTaskTitle, isProtectedBranch, runBranchName, runBranchSettingsProblems,
  type RunBranchSettings, type RunGit, type Task, type TaskStore
} from '@orca-board/core'
import { currentBranch } from './git'
import { OrcaError } from './i18n'

// Ветка глобальной задачи (docs/architecture.md → «Ветка глобальной задачи»). Раньше подзадачи ответвлялись от HEAD
// корня и сливались в его текущую ветку: открыли проект на master — вся работа Orca попала в master, а две фичи
// одного проекта смешались в одной ветке. Теперь у глобальной задачи своя ветка и свой worktree: подзадачи
// ответвляются от неё и сливаются в неё, корень не меняется, несколько глобальных задач идут параллельно.

// git только массивом аргументов без shell (CLAUDE.md). Сеть (fetch, push) — без интерактивного запроса пароля:
// приложение не может его показать, git завис бы.
const NET_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
const FETCH_TIMEOUT_MS = 20_000
const PUSH_TIMEOUT_MS = 120_000

function git(cwd: string, args: string[], opts: { timeout?: number } = {}): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: NET_ENV, ...opts }).trim()
}

function gitError(e: unknown): string {
  const err = e as { stderr?: string | Buffer; message?: string }
  return (err.stderr?.toString().trim() || err.message || String(e)).trim()
}

/** Worktree глобальной задачи — рядом с worktree подзадач: `<repo>/../.orca-worktrees/<runId>`. */
export function runWorktreePath(repoRoot: string, runId: string): string {
  return join(repoRoot, '..', '.orca-worktrees', runId)
}

function branchExists(repoRoot: string, branch: string): boolean {
  try {
    git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

/** Текущая ветка корня; detached HEAD — коммит, иначе ветвиться было бы не от чего. */
function headRef(repoRoot: string): string {
  const branch = currentBranch(repoRoot)
  return branch === 'HEAD' ? git(repoRoot, ['rev-parse', 'HEAD']) : branch
}

/**
 * База вида `<remote>/<ветка>` — сначала `git fetch`, чтобы фича ответвилась от свежей базы, а не от того, что
 * лежит в клоне с прошлой недели. Нет сети или прав — ветвимся от того, что есть: запуск важнее свежести.
 */
function fetchBase(repoRoot: string, base: string, remote: string): void {
  if (!base.startsWith(`${remote}/`)) return
  try {
    if (!git(repoRoot, ['remote']).split('\n').includes(remote)) return
    git(repoRoot, ['fetch', '--quiet', remote, base.slice(remote.length + 1)], { timeout: FETCH_TIMEOUT_MS })
  } catch {
    /* офлайн или нет такой ветки на remote — git worktree add ниже скажет, если базы нет совсем */
  }
}

/**
 * Прогон уже работал без своей ветки: воркеры запускались и сливали результат в корень. Заводить ветку посреди
 * работы нельзя — половина фичи оказалась бы в корне, половина в новой ветке. Такой прогон доживает по-старому.
 */
function startedWithoutBranch(store: TaskStore, runId: string): boolean {
  const ids = new Set(store.listSubtasks(runId).map((t) => t.id))
  return store.snapshot().dispatches.some((d) => ids.has(d.taskId))
}

/**
 * Worktree ветки есть на диске; убран (после «Сделано») или удалён руками — вернуть на существующую ветку.
 * `worktree prune` снимает запись об удалённой руками папке, иначе `worktree add` откажет.
 */
function ensureWorktree(store: TaskStore, repoRoot: string, runId: string, g: RunGit): RunGit {
  if (g.worktree && existsSync(g.worktree)) return g
  if (!branchExists(repoRoot, g.branch)) throw new OrcaError('git.runBranchMissing', { branch: g.branch })
  const worktree = runWorktreePath(repoRoot, runId)
  try {
    git(repoRoot, ['worktree', 'prune'])
    git(repoRoot, ['worktree', 'add', worktree, g.branch])
  } catch (e) {
    throw new OrcaError('git.runBranchFailed', { branch: g.branch, base: g.branch, error: gitError(e) })
  }
  return store.setRunGit(runId, { worktree }).git!
}

/**
 * Ветка глобальной задачи с worktree на диске: есть — вернуть (восстановив worktree), нет — завести от базы
 * настроек (`git worktree add --no-track -b`: без upstream на базу, иначе голый `git push` ушёл бы в неё).
 * `undefined` — работать по-старому, в текущую ветку корня: «Входящие», настройка выключена, прогон начат без ветки.
 * Вызывают запуск координатора и воркера — до того, как кто-то начнёт работать.
 */
export function ensureRunBranch(store: TaskStore, repoRoot: string, runId: string | undefined, settings: RunBranchSettings): RunGit | undefined {
  const run = runId ? store.getRun(runId) : undefined
  if (!run || run.inbox) return undefined
  if (run.git) return ensureWorktree(store, repoRoot, run.id, run.git)
  if (!settings.enabled || startedWithoutBranch(store, run.id)) return undefined
  const problems = runBranchSettingsProblems(settings)
  if (problems.length > 0) throw new OrcaError('git.badSettings', { problems: problems.map((x) => x.text).join('; ') })
  const branch = runBranchName(settings.template, { id: run.id, title: globalTaskTitle(run) })
  const base = settings.base || headRef(repoRoot)
  fetchBase(repoRoot, base, settings.remote)
  const worktree = runWorktreePath(repoRoot, run.id)
  try {
    git(repoRoot, ['worktree', 'add', '--no-track', '-b', branch, worktree, base])
  } catch (e) {
    throw new OrcaError('git.runBranchFailed', { branch, base, error: gitError(e) })
  }
  return store.setRunGit(run.id, { branch, base, worktree }).git
}

/** Куда сливать ветку подзадачи: каталог, где выполнить `git merge`, и ветка в нём. */
export interface MergeTarget {
  cwd: string
  branch: string
}

/**
 * Цель мержа подзадачи: ветка её глобальной задачи (worktree восстанавливается, если убран) или — прогон без
 * ветки — текущая ветка корня. Во вторую приложение не сливает, если она защищённая (`master`, `develop`…):
 * так Orca, открытый на общей ветке, больше не пишет в неё молча. Ошибка — исключение: это не конфликт мержа,
 * повтор без смены настройки или ветки корня не поможет.
 */
export function mergeTarget(store: TaskStore, repoRoot: string, task: Pick<Task, 'runId'>, settings: RunBranchSettings): MergeTarget {
  const run = task.runId ? store.getRun(task.runId) : undefined
  if (run?.git) {
    const g = ensureWorktree(store, repoRoot, run.id, run.git)
    return { cwd: g.worktree!, branch: g.branch }
  }
  const branch = currentBranch(repoRoot)
  if (isProtectedBranch(branch, settings.protected)) throw new OrcaError('git.protectedBranch', { branch })
  return { cwd: repoRoot, branch }
}

/** База для «что накопилось в ветке задачи» (ревью): ветка глобальной задачи или текущая ветка корня. */
export function reviewBase(store: TaskStore, repoRoot: string, task: Pick<Task, 'runId'>): string {
  const run = task.runId ? store.getRun(task.runId) : undefined
  return run?.git?.branch ?? currentBranch(repoRoot)
}

/**
 * Убрать worktree глобальной задачи, ветку оставить. Без `--force`: незакоммиченное в нём (кто-то правил руками)
 * не теряем — worktree остаётся, `false`.
 */
export function removeRunWorktree(repoRoot: string, worktree: string): boolean {
  if (!existsSync(worktree)) return true
  try {
    git(repoRoot, ['worktree', 'remove', worktree])
    return true
  } catch {
    return false
  }
}

export interface RunBranchSyncDeps {
  isAlive(ptyId: string): boolean
}

/**
 * Хвост жизни ветки глобальной задачи, по любому изменению доски (`projects.onChange`):
 * - прогон закрыт (карточка на «Проверке») и включён push — `git push -u <remote> <ветка>` в фоне, итог в `Run.git`;
 * - карточка в «Сделано», координатора и воркеров нет — worktree убирается, ветка остаётся.
 * Состояние попыток — в памяти: неудачный push не повторяется на каждом изменении доски (только после нового
 * закрытия или перезапуска), неудачная уборка — до перезапуска.
 */
export class RunBranchSync {
  private pushTried = new Map<string, number>()
  private pushing = new Set<string>()
  private keepWorktree = new Set<string>()

  constructor(private deps: RunBranchSyncDeps) {}

  sync(store: TaskStore, repoRoot: string, settings: RunBranchSettings): void {
    for (const run of store.listRuns()) {
      const g = run.git
      if (!g) continue
      if (settings.push && run.closedAt !== undefined && (g.pushedAt ?? 0) < run.closedAt &&
          this.pushTried.get(run.id) !== run.closedAt && !this.pushing.has(run.id)) {
        this.pushTried.set(run.id, run.closedAt)
        this.push(store, repoRoot, run.id, g.branch, settings.remote)
      }
      if (g.worktree && !this.keepWorktree.has(g.worktree) && this.idleDone(store, run.id)) {
        if (removeRunWorktree(repoRoot, g.worktree)) store.setRunGit(run.id, { worktree: undefined })
        else this.keepWorktree.add(g.worktree)
      }
    }
  }

  /** Карточка в «Сделано», и в прогоне никто не работает: ни координатор, ни воркеры подзадач. */
  private idleDone(store: TaskStore, runId: string): boolean {
    const run = store.getRun(runId)
    if (!run?.status || store.columnKind(run.status) !== 'done') return false
    if (run.coordinatorPtyId && this.deps.isAlive(run.coordinatorPtyId)) return false
    const ids = new Set(store.listSubtasks(runId).map((t) => t.id))
    return !store.snapshot().dispatches.some((d) => ids.has(d.taskId) && this.deps.isAlive(d.ptyId))
  }

  /** Явный refspec: результат не зависит от `push.default` и upstream ветки у человека. */
  private push(store: TaskStore, repoRoot: string, runId: string, branch: string, remote: string): void {
    this.pushing.add(runId)
    const ref = `refs/heads/${branch}`
    execFile('git', ['push', '--quiet', '-u', remote, `${ref}:${ref}`], { cwd: repoRoot, env: NET_ENV, timeout: PUSH_TIMEOUT_MS }, (err, _out, stderr) => {
      this.pushing.delete(runId)
      // Глобальную задачу могли удалить, пока шёл push.
      if (!store.getRun(runId)?.git) return
      if (err) store.setRunGit(runId, { pushError: (stderr?.toString().trim() || err.message).slice(0, 2000) })
      else store.setRunGit(runId, { pushedAt: Date.now(), pushError: undefined })
    })
  }
}
