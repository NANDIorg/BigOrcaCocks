import type { TaskStore } from '@orca-board/core'
import type { RunCommands, RunCommandName, RunSummary } from '@orca-board/contracts'
import { createProjectCommandExecutor, type ProjectCommandHost } from './project-commands.ts'
import { commandString } from './command-input.ts'

export function listRunsWithCounts(store: Pick<TaskStore, 'listTasks' | 'listRuns' | 'columnKind'>): RunSummary[] {
  const counts = new Map<string, { tasks: number; done: number }>()
  for (const task of store.listTasks()) {
    if (!task.runId) continue
    const count = counts.get(task.runId) ?? { tasks: 0, done: 0 }
    count.tasks++; if (store.columnKind(task.status) === 'done') count.done++
    counts.set(task.runId, count)
  }
  return structuredClone(store.listRuns().map(run => ({ ...run, ...(counts.get(run.id) ?? { tasks: 0, done: 0 }) })))
}
export interface RunCommandProject { store: TaskStore }
export function createRunCommands(host: ProjectCommandHost<RunCommandProject, RunCommandName>): RunCommands {
  const execute = createProjectCommandExecutor(host)
  return {
    list: context => execute(context, 'runs.list', () => project => project.store.listRuns()),
    listWithCounts: context => execute(context, 'runs.listWithCounts', () => project => listRunsWithCounts(project.store)),
    close: (context, runId) => execute(context, 'runs.close', () => { const id = commandString(runId, 'runId'); return project => project.store.closeRun(id) })
  }
}
