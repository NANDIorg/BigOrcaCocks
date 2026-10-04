import type { Task, TaskStore } from '@orca-board/core'
import { createAsyncRunBranchServices, type AsyncRunBranchDeps } from './run-branch-async.ts'
import { executionProject, type ExecutionContext } from './execution-context.ts'
import { createEffectScopeService, type EffectScope } from './effect-scope.ts'

export interface MergeTarget {
  cwd: string
  branch: string
}

export type RunMergeResult =
  /** Слито (или сливать нечего: база уже содержит ветку). `into` — локальная ветка, в которую слито. */
  | { kind: 'ok'; into: string }
  /** git не слил ветку (текст в `error`), база не тронута: конфликт разрешают в ветке глобальной задачи. */
  | { kind: 'conflict'; error: string }
  /** Слить нельзя, и повтор без правки графа или репозитория не поможет: причина по-русски, с подсказкой. */
  | { kind: 'blocked'; reason: string }

export interface RunBranchSyncDeps {
  isAlive(ptyId: string): boolean
}

/** Совместимые trusted сигнатуры; алгоритм и очередь принадлежат единственному async port. */
export function createRunBranchServices(deps: Omit<AsyncRunBranchDeps, 'effects'> & { effects?: AsyncRunBranchDeps['effects'] }) {
  const branches = createAsyncRunBranchServices({ ...deps, effects: deps.effects ?? createEffectScopeService() })
  class RunBranchSync {
    private syncer: InstanceType<typeof branches.RunBranchSync>
    constructor(deps: RunBranchSyncDeps) { this.syncer = new branches.RunBranchSync(deps) }
    sync(store: TaskStore, root: string, context?: ExecutionContext): Promise<void> {
      return this.syncer.sync(executionProject(store, root, context))
    }
  }
  return {
    ensureRunBranch: (store: TaskStore, root: string, runId: string | undefined, context?: ExecutionContext) => branches.ensureRunBranch(executionProject(store, root, context), runId),
    mergeTarget: (store: TaskStore, root: string, task: Pick<Task, 'runId'>, context?: ExecutionContext) => branches.mergeTarget(executionProject(store, root, context), task),
    mergeRunBranch: (store: TaskStore, root: string, runId: string, message: string, context?: ExecutionContext, parent?: EffectScope) => branches.mergeRunBranch(executionProject(store, root, context), runId, message, parent),
    reviewBase: (store: TaskStore, root: string, task: Pick<Task, 'runId'>, context?: ExecutionContext) => branches.reviewBase(executionProject(store, root, context), task),
    removeRunWorktree: (store: TaskStore, root: string, runId: string, context?: ExecutionContext) => branches.removeRunWorktree(executionProject(store, root, context), runId),
    runWorktreePath: branches.runWorktreePath, RunBranchSync
  }
}
export type RunBranchServices = ReturnType<typeof createRunBranchServices>
