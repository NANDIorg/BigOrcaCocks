import { STATS_RANGES, type Workflow } from '@orca-board/core'
import type { StatsCommands, StatsCommandName } from '@orca-board/contracts'
import { createAsyncProjectCommandExecutor, type AsyncProjectCommandHost } from './async-project-commands.ts'
import { commandString } from './command-input.ts'
import type { createStatsServices, StatsDeps, StatsMessages } from './stats.ts'
import type { RuntimeProjectManager } from './projects.ts'

import type { RegisteredProject } from './project-scope.ts'
export { registeredProject as statsProject, isRegisteredProjectCurrent as isStatsProjectCurrent } from './project-scope.ts'
export type StatsProject = RegisteredProject

export function statsProjectDeps(manager: Pick<RuntimeProjectManager, 'roles' | 'columns'>, project: StatsProject,
  host: Pick<StatsDeps, 'isAlive' | 'now' | 'env' | 'cache'>): StatsDeps {
  const titles = new Map<string, string>()
  const addRoles = (runId?: string) => {
    for (const role of manager.roles(project.id, runId)) if (!titles.has(role.id)) titles.set(role.id, role.title)
  }
  addRoles()
  for (const run of project.store.snapshot().runs) addRoles(run.id)
  return { ...host, store: project.store, repoRoot: project.root, columns: structuredClone(manager.columns(project.id)),
    roleTitle: id => titles.get(id) }
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
