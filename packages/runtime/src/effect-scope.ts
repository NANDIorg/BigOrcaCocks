import { runPositionAt, runPositions, withStatusSource, type Run, type RunPosition, type StatusSource, type Task, type TaskStore } from '@orca-board/core'
import { CommandError } from './project-commands.ts'
import type { GitWorkflowReadRepository, GitWorkflowRepository, GitWorkflowService } from './git-workflow.ts'

export interface EffectProject { id: string; root: string; store: TaskStore; isCurrent?: () => boolean }
export interface EffectTarget { taskId?: string; runId?: string; nodeId?: string; laneId?: string }
export interface EffectOptions { signal?: AbortSignal; source?: StatusSource }
/** Описание позиции не даёт полномочий: guard принадлежит захватившему её owner scope. */
export interface EffectToken {
  readonly projectId: string
  readonly repoRoot: string
  readonly taskId?: string
  readonly runId?: string
  readonly nodeId?: string
  readonly visit?: number
  readonly laneId?: string
  readonly forkVisit?: number
  readonly dispatchId?: string
}
export interface EffectScope {
  readonly token: EffectToken
  readonly signal: AbortSignal
  guard(): void
  wait<T>(operation: () => Promise<T>): Promise<T>
  commit<T>(operation: () => T): T
  transaction<T>(git: GitWorkflowService, operation: (repo: GitWorkflowRepository) => Promise<T>): Promise<T>
  read<T>(git: GitWorkflowService, operation: (repo: GitWorkflowReadRepository) => Promise<T>): Promise<T>
  close(): void
}
export interface EffectScopeService {
  capture(project: EffectProject, target?: EffectTarget, options?: EffectOptions): EffectScope
  cancelTask(projectId: string, taskId: string): void
  cancelRun(projectId: string, runId: string): void
  stop(): void
}

function taskState(task: Task): string {
  return JSON.stringify([task.status, task.runId, task.dispatchId, task.worktree, task.branch, task.branchForeign,
    task.stage?.nodeId, task.stage ? task.stage.visits[task.stage.nodeId] ?? 1 : undefined,
    task.stageOf?.nodeId, task.stageOf?.visit])
}
function runState(run: Run, position?: RunPosition): string {
  const lane = position?.lane ? run.lanes?.find(l => l.id === position.lane) : undefined
  return JSON.stringify([run.closedAt, run.finishedAt, run.git?.branch, run.git?.base, run.git?.worktree,
    position?.nodeId, position?.visit, position?.lane, position?.arrived,
    lane?.forkId, lane?.branchId, lane?.forkVisit, lane?.arrivedAt])
}
function positionAt(run: Run, lane?: string): RunPosition | undefined {
  return lane === undefined ? runPositionAt(run) : runPositions(run).find(p => p.lane === lane)
}
function selectPosition(run: Run, nodeId?: string, laneId?: string): RunPosition | undefined {
  if (laneId !== undefined) {
    const position = positionAt(run, laneId)
    if (!position || (nodeId !== undefined && position.nodeId !== nodeId)) throw new CommandError('command.conflict', { reason: 'Позиция пути изменилась' })
    return position
  }
  if (nodeId === undefined) return positionAt(run)
  const candidates = runPositions(run).filter(p => p.nodeId === nodeId)
  if (candidates.length !== 1) throw new CommandError('command.conflict', { reason: 'Укажите однозначную позицию и путь воркфлоу' })
  return candidates[0]
}

/** Scope живёт только до завершения effect; ожидания человека и агента сюда не входят. */
export function createEffectScopeService(): EffectScopeService {
  const active = new Set<EffectScope>()
  let stopped = false
  const stale = (projectId?: string): never => { throw new CommandError('command.stale', projectId ? { projectId } : {}) }
  return {
    capture(project, target = {}, options = {}) {
      const { id: projectId, root: repoRoot, store } = project
      if (stopped || options.signal?.aborted || project.isCurrent?.() === false) stale(projectId)
      const task = target.taskId === undefined ? undefined : store.getTask(target.taskId)
      if (target.taskId !== undefined && !task) throw new CommandError('command.taskNotFound', { taskId: target.taskId })
      if (task && target.runId !== undefined && task.runId !== target.runId) throw new CommandError('command.conflict', { reason: 'Задача относится к другому прогону' })
      const runId = target.runId ?? task?.runId
      const run = runId === undefined ? undefined : store.getRun(runId)
      if (runId !== undefined && !run) throw new CommandError('command.globalTaskNotFound', { globalTaskId: runId })
      if (task && target.nodeId !== undefined && task.stage?.nodeId !== target.nodeId) throw new CommandError('command.conflict', { reason: 'Этап задачи изменился' })
      if (!run && target.laneId !== undefined) throw new CommandError('command.conflict', { reason: 'У задачи нет пути прогона' })
      if (!task && !run && target.nodeId !== undefined) throw new CommandError('command.conflict', { reason: 'У эффекта нет этапа' })
      const position = run ? selectPosition(run, task ? task.stageOf?.nodeId : target.nodeId, target.laneId) : undefined
      const lane = position?.lane ? run?.lanes?.find(l => l.id === position.lane) : undefined
      const taskSnapshot = task ? taskState(task) : undefined
      const runSnapshot = run ? runState(run, position) : undefined
      const controller = new AbortController()
      const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
      const source = options.source ?? 'workflow'
      let open = true
      const token: EffectToken = Object.freeze({ projectId, repoRoot,
        ...(task ? { taskId: task.id, dispatchId: task.dispatchId } : {}), ...(runId === undefined ? {} : { runId }),
        ...(task?.stage ? { nodeId: task.stage.nodeId, visit: task.stage.visits[task.stage.nodeId] ?? 1 }
          : position ? { nodeId: position.nodeId, visit: position.visit } : {}),
        ...(lane ? { laneId: lane.id, forkVisit: lane.forkVisit } : {}) })
      const guard = () => {
        if (!open || stopped || signal.aborted || project.id !== projectId || project.root !== repoRoot || project.store !== store
          || project.isCurrent?.() === false) stale(projectId)
        if (task && (store.getTask(task.id) !== task || taskState(task) !== taskSnapshot)) stale(projectId)
        if (run && (store.getRun(run.id) !== run || runState(run, positionAt(run, position?.lane)) !== runSnapshot)) stale(projectId)
      }
      async function wait<T>(operation: () => Promise<T>): Promise<T> {
        guard(); let value!: T; let failure: unknown; let failed = false
        try { value = await operation() } catch (error) { failure = error; failed = true }
        // Проверка после завершения и вне native catch сохраняет причину, пока позиция актуальна.
        guard(); if (failed) throw failure; return value
      }
      const scope: EffectScope = {
        token, signal, guard, wait,
        commit: operation => { guard(); return withStatusSource(source, operation) },
        transaction: (git, operation) => wait(() => git.transaction(repoRoot, operation, { guard, signal })),
        read: (git, operation) => wait(() => git.read(repoRoot, operation, { guard, signal })),
        close: () => {
          if (!open) return
          open = false; active.delete(scope); signal.removeEventListener('abort', scope.close); controller.abort()
        }
      }
      signal.addEventListener('abort', scope.close, { once: true })
      guard(); active.add(scope); return scope
    },
    cancelTask(projectId, taskId) { for (const scope of active) if (scope.token.projectId === projectId && scope.token.taskId === taskId) scope.close() },
    cancelRun(projectId, runId) { for (const scope of active) if (scope.token.projectId === projectId && scope.token.runId === runId) scope.close() },
    stop() { stopped = true; for (const scope of active) scope.close() }
  }
}
