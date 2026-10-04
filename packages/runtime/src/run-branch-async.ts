import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { globalTaskTitle, runBranchName, type Run, type RunGit, type Task } from '@orca-board/core'
import { GitOpError, MergeError } from './git-errors.ts'
import { GitProcessError } from './git-process.ts'
import type { createGitOperations } from './git.ts'
import type { EffectProject, EffectScopeService } from './effect-scope.ts'
import type { ExecutionMessages } from './execution-messages.ts'
import type { MergeTarget, RunMergeResult, RunBranchSyncDeps } from './run-branch.ts'

export interface AsyncRunBranchDeps {
  messages: ExecutionMessages
  git: Pick<ReturnType<typeof createGitOperations>, 'workflowGit'>
  effects: EffectScopeService
}

/** Git metadata проверяется отдельно от позиции: подготовка общей ветки не отменяет соседний lane. */
export function createAsyncRunBranchServices({ messages, git, effects }: AsyncRunBranchDeps) {
  const metadata = (run: Run) => JSON.stringify([run.git?.branch, run.git?.base, run.git?.worktree])
  const reason = (error: unknown) => error instanceof GitProcessError ? error.stderr.trim() || error.message : error instanceof Error ? error.message : String(error)
  const native = (error: unknown) => error instanceof GitProcessError && !error.cancelled || error instanceof GitOpError
  const runWorktreePath = (root: string, runId: string) => join(root, '..', '.orca-worktrees', runId)
  function capture(project: EffectProject, runId?: string, extra: () => boolean = () => true) {
    const { id, root, store } = project; const run = runId === undefined ? undefined : store.getRun(runId)
    const before = run ? metadata(run) : undefined
    return effects.capture({ id, root, store, isCurrent: () => project.id === id && project.root === root && project.store === store
      && (project.isCurrent?.() ?? true) && (!run || store.getRun(run.id) === run && metadata(run) === before) && extra() },
    runId === undefined ? {} : { runId })
  }
  function startedWithoutBranch(project: EffectProject, runId: string): boolean {
    const ids = new Set(project.store.listSubtasks(runId).map(t => t.id))
    return project.store.snapshot().dispatches.some(d => ids.has(d.taskId))
  }
  async function prepare(project: EffectProject, runId: string): Promise<RunGit | undefined> {
    const scope = capture(project, runId)
    try {
      const run = project.store.getRun(runId)!
      if (run.inbox || !run.git && startedWithoutBranch(project, run.id)) return undefined
      const before = run.git ? { ...run.git } : undefined
      if (before?.worktree && existsSync(before.worktree)) return before
      const branch = before?.branch ?? runBranchName({ id: run.id, title: globalTaskTitle(run) })
      const worktree = runWorktreePath(project.root, run.id)
      const result = await scope.transaction(git.workflowGit, async repo => {
        if (before) {
          if (!await repo.localBranchExists(branch)) throw messages.error('git.runBranchMissing', { branch })
          try { await repo.pruneWorktrees(); await repo.addTaskWorktree(worktree, branch) }
          catch (error) { if (!native(error)) throw error; throw messages.error('git.runBranchFailed', { branch, base: branch, error: reason(error) }) }
          return { ...before, worktree }
        }
        await repo.assertHasCommits(); const base = await repo.headBase()
        try { await repo.addRunWorktree(worktree, branch, base) }
        catch (error) { if (!native(error)) throw error; throw messages.error('git.runBranchFailed', { branch, base, error: reason(error) }) }
        return { branch, base, worktree }
      })
      return scope.commit(() => project.store.setRunGit(run.id, result).git)
    } finally { scope.close() }
  }
  const preparations = new WeakMap<EffectProject['store'], Map<string, Promise<RunGit | undefined>>>()
  async function ensureRunBranch(project: EffectProject, runId: string | undefined): Promise<RunGit | undefined> {
    const scope = effects.capture(project, runId === undefined ? {} : { runId })
    try {
      if (runId === undefined) return undefined
      let jobs = preparations.get(project.store)
      if (!jobs) { jobs = new Map(); preparations.set(project.store, jobs) }
      const key = JSON.stringify([project.id, project.root, runId]); let pending = jobs.get(key)
      if (!pending) {
        pending = prepare(project, runId); jobs.set(key, pending)
        const clear = () => { if (jobs.get(key) === pending) jobs.delete(key) }
        pending.then(clear, clear)
      }
      return await scope.wait(() => pending!)
    } finally { scope.close() }
  }
  async function mergeTarget(project: EffectProject, task: Pick<Task, 'runId'>): Promise<MergeTarget> {
    const scope = effects.capture(project, task.runId === undefined ? {} : { runId: task.runId })
    try {
      if (task.runId && project.store.getRun(task.runId)?.git) {
        const g = await scope.wait(() => ensureRunBranch(project, task.runId))
        return { cwd: g!.worktree!, branch: g!.branch }
      }
      return { cwd: project.root, branch: await scope.read(git.workflowGit, repo => repo.currentBranch()) }
    } finally { scope.close() }
  }
  async function reviewBase(project: EffectProject, task: Pick<Task, 'runId'>): Promise<string> {
    const scope = capture(project, task.runId)
    try { return project.store.getRun(task.runId ?? '')?.git?.branch ?? await scope.read(git.workflowGit, repo => repo.currentBranch()) }
    finally { scope.close() }
  }
  async function mergeRunBranch(project: EffectProject, runId: string, message: string): Promise<RunMergeResult> {
    const scope = capture(project, runId)
    try {
      const g = project.store.getRun(runId)!.git
      if (!g) return { kind: 'blocked', reason: 'у глобальной задачи нет ветки — сливать нечего' }
      return await scope.transaction(git.workflowGit, async repo => {
        let target = await repo.localBranchExists(g.base) ? g.base : undefined
        if (!target) { const [remote, ...rest] = g.base.split('/'); if (rest.length && (await repo.remotes()).includes(remote)) target = rest.join('/') }
        if (!target) return { kind: 'blocked', reason: `база «${g.base}» — не ветка (коммит или неизвестное имя): слить в неё нельзя. Замените merge в воркфлоу на git push и создайте PR` }
        if (!await repo.localBranchExists(target)) return { kind: 'blocked', reason: `локальной ветки «${target}» нет: создайте её (git branch ${target} ${g.base}) и повторите` }
        if (!await repo.localBranchExists(g.branch)) return { kind: 'blocked', reason: `ветки глобальной задачи «${g.branch}» нет — сливать нечего` }
        const merge = async (cwd: string): Promise<RunMergeResult> => {
          try { await repo.mergeBranch(cwd, g.branch, message); return { kind: 'ok', into: target! } }
          catch (error) { if (!(error instanceof MergeError)) throw error; return { kind: 'conflict', error: error.message } }
        }
        const at = await repo.checkedOutAt(target)
        if (at) {
          if (await repo.isDirty(at)) return { kind: 'blocked', reason: `ветка «${target}» выгружена в ${at} с незакоммиченными изменениями: закоммитьте или уберите их и повторите слияние` }
          return merge(at)
        }
        scope.guard(); const dir = mkdtempSync(join(tmpdir(), 'orca-merge-')); const worktree = join(dir, 'base')
        try { await repo.addTaskWorktree(worktree, target); return await merge(worktree) }
        catch (error) { if (!native(error)) throw error; return { kind: 'blocked', reason: `не удалось подготовить временный worktree ветки «${target}»: ${reason(error)}` } }
        finally {
          // Сбой/отмена уборки оставляет зарегистрированный временный worktree для восстановления.
          let removed = false
          try { await repo.removeWorktreeKeepBranch(worktree); removed = true }
          catch (error) { if (!native(error)) throw error }
          if (removed) rmSync(dir, { recursive: true, force: true })
        }
      })
    } finally { scope.close() }
  }
  async function removeRunWorktree(project: EffectProject, runId: string): Promise<boolean> {
    const scope = capture(project, runId)
    try {
      const worktree = project.store.getRun(runId)!.git?.worktree
      return worktree === undefined || await scope.transaction(git.workflowGit, repo => repo.removeCleanWorktree(worktree))
    } finally { scope.close() }
  }
  class RunBranchSync {
    private keepWorktree = new Set<string>()
    private pending = new Set<string>()
    private deps: RunBranchSyncDeps
    constructor(deps: RunBranchSyncDeps) { this.deps = deps }
    private idleDone(project: EffectProject, runId: string): boolean {
      const run = project.store.getRun(runId)
      if (!run?.status || project.store.columnKind(run.status) !== 'done') return false
      if (run.coordinatorPtyId && this.deps.isAlive(run.coordinatorPtyId)) return false
      const ids = new Set(project.store.listSubtasks(runId).map(t => t.id))
      return !project.store.snapshot().dispatches.some(d => ids.has(d.taskId) && this.deps.isAlive(d.ptyId))
    }
    async sync(project: EffectProject): Promise<void> {
      for (const run of project.store.listRuns()) {
        const worktree = run.git?.worktree
        if (!worktree || this.keepWorktree.has(worktree) || this.pending.has(worktree) || !this.idleDone(project, run.id)) continue
        const scope = capture(project, run.id, () => this.idleDone(project, run.id)); this.pending.add(worktree)
        try {
          const removed = await scope.transaction(git.workflowGit, repo => repo.removeCleanWorktree(worktree))
          scope.commit(() => { if (removed) project.store.setRunGit(run.id, { worktree: undefined }); else this.keepWorktree.add(worktree) })
        } finally { scope.close(); this.pending.delete(worktree) }
      }
    }
  }
  return { ensureRunBranch, runWorktreePath, mergeTarget, mergeRunBranch, reviewBase, removeRunWorktree, RunBranchSync }
}
export type AsyncRunBranchServices = ReturnType<typeof createAsyncRunBranchServices>
