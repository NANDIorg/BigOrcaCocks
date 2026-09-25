import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { globalTaskTitle, runBranchName, type RunGit, type Task, type TaskStore } from '@orca-board/core'
import { currentBranch } from './git'
import { OrcaError } from './i18n'

// Ветка глобальной задачи (docs/architecture.md → «Ветка глобальной задачи»). Раньше подзадачи ответвлялись от HEAD
// корня и сливались в его текущую ветку: открыли проект на master — вся работа Orca попала в master, а две фичи
// одного проекта смешались в одной ветке. Теперь у глобальной задачи своя ветка и свой worktree: подзадачи
// ответвляются от неё и сливаются в неё, корень не меняется, несколько глобальных задач идут параллельно.
// Что делать с веткой после «Проверки» (push, PR, мерж в основную) — решает человек: приложение её не отправляет.

// git только массивом аргументов без shell (CLAUDE.md).
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim()
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
 * Ветка глобальной задачи с worktree на диске: есть — вернуть (восстановив worktree), нет — завести от ветки,
 * открытой в проекте (`git worktree add --no-track -b`: без upstream на базу, иначе голый `git push` ушёл бы в неё).
 * `undefined` — работать по-старому, в текущую ветку корня: «Входящие» или прогон, начатый без ветки.
 * Вызывают запуск координатора и воркера — до того, как кто-то начнёт работать.
 */
export function ensureRunBranch(store: TaskStore, repoRoot: string, runId: string | undefined): RunGit | undefined {
  const run = runId ? store.getRun(runId) : undefined
  if (!run || run.inbox) return undefined
  if (run.git) return ensureWorktree(store, repoRoot, run.id, run.git)
  if (startedWithoutBranch(store, run.id)) return undefined
  const branch = runBranchName({ id: run.id, title: globalTaskTitle(run) })
  const base = headRef(repoRoot)
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
 * Цель мержа подзадачи: ветка её глобальной задачи (worktree восстанавливается, если убран) или — «Входящие» и
 * прогон без ветки — текущая ветка корня.
 */
export function mergeTarget(store: TaskStore, repoRoot: string, task: Pick<Task, 'runId'>): MergeTarget {
  const run = task.runId ? store.getRun(task.runId) : undefined
  if (run?.git) {
    const g = ensureWorktree(store, repoRoot, run.id, run.git)
    return { cwd: g.worktree!, branch: g.branch }
  }
  return { cwd: repoRoot, branch: currentBranch(repoRoot) }
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
 * Уборка worktree ветки глобальной задачи, по любому изменению доски (`projects.onChange`): карточка в «Сделано»,
 * координатора и воркеров нет — worktree убирается, ветка остаётся. Неудачная уборка (незакоммиченное в worktree)
 * не повторяется до перезапуска.
 */
export class RunBranchSync {
  private keepWorktree = new Set<string>()

  constructor(private deps: RunBranchSyncDeps) {}

  sync(store: TaskStore, repoRoot: string): void {
    for (const run of store.listRuns()) {
      const g = run.git
      if (!g?.worktree || this.keepWorktree.has(g.worktree) || !this.idleDone(store, run.id)) continue
      if (removeRunWorktree(repoRoot, g.worktree)) store.setRunGit(run.id, { worktree: undefined })
      else this.keepWorktree.add(g.worktree)
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
}
