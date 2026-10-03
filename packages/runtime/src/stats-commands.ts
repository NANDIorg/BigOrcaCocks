import { STATS_RANGES, type TaskStore, type Workflow } from '@orca-board/core'
import type { Project, StatsCommands, StatsCommandName } from '@orca-board/contracts'
import { createAsyncProjectCommandExecutor, type AsyncProjectCommandHost } from './async-project-commands.ts'
import { commandString } from './command-input.ts'
import type { createStatsServices, StatsDeps, StatsMessages } from './stats.ts'
import type { RuntimeProjectManager } from './projects.ts'

export interface StatsProject { id: string; root: string; store: TaskStore; registration: Project }
type StatsManager = Pick<RuntimeProjectManager, 'get' | 'store' | 'loadedStores'>

export function statsProject(manager: StatsManager, id: string): StatsProject | undefined {
  const registration = manager.get(id)
  return registration ? { id, root: registration.root, store: manager.store(id), registration } : undefined
}
export function isStatsProjectCurrent(manager: StatsManager, project: StatsProject): boolean {
  // Id проекта — hash пути: remove + add даёт тот же id и может сохранить старый store.
  return manager.get(project.id) === project.registration && project.registration.root === project.root
    && manager.loadedStores().some(([id, store]) => id === project.id && store === project.store)
}
export interface StatsCommandHost extends AsyncProjectCommandHost<StatsProject, StatsCommandName> {
  stats: ReturnType<typeof createStatsServices>
  messages: StatsMessages
  deps(project: StatsProject): StatsDeps
  workflow(project: StatsProject, taskId: string): Workflow | undefined
}
export function createStatsCommands(host: StatsCommandHost): StatsCommands {
  const execute = createAsyncProjectCommandExecutor(host)
  return {
    project: (ctx, range) => execute(ctx, 'stats.project', () => {
      if (!STATS_RANGES.includes(range)) throw new host.messages.Error('stats.badRange', { range: String(range), expected: STATS_RANGES.join(' | ') })
      return (project, _ctx, scope) => host.stats.projectStats({ ...host.deps(project),
        projectId: project.id, range, isCurrent: scope.isCurrent, commit: scope.commit })
    }),
    task: (ctx, rawId) => execute(ctx, 'stats.task', () => {
      const taskId = commandString(rawId, 'taskId')
      return (project, _ctx, scope) => host.stats.taskStats({ ...host.deps(project), taskId,
        workflow: structuredClone(host.workflow(project, taskId)), isCurrent: scope.isCurrent, commit: scope.commit })
    }),
    global: (ctx, rawId) => execute(ctx, 'stats.global', () => {
      const runId = commandString(rawId, 'runId')
      return (project, _ctx, scope) => host.stats.globalTaskStats({ ...host.deps(project), runId,
        isCurrent: scope.isCurrent, commit: scope.commit })
    })
  }
}
