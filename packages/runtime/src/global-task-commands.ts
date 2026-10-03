import { isTaskPriority, validateAttachments, type TaskStore, type RunTypeInput, type AgentInfo } from '@orca-board/core'
import type { GlobalTaskCommands, GlobalTaskCommandName, GlobalTaskInput, GlobalTaskPatch, SubtaskInput } from '@orca-board/contracts'
import type { AgentSelectionServices } from './agent-selection.ts'
import type { RoleSource } from './launch-policy.ts'
import { CommandError, createProjectCommandExecutor, type ProjectCommandHost } from './project-commands.ts'
import { commandFields, commandString, commandInputError, taskCreateFrom } from './command-input.ts'
import { createGlobalTaskRemoval, type GlobalTaskRemovalDeps } from './global-task-removal.ts'

export interface GlobalTaskCommandProject {
  store: TaskStore
  root: string
  runType(typeId?: string): RunTypeInput
  roles(globalTaskId: string): RoleSource
  agents(): AgentInfo[]
}

export interface GlobalTaskCommandHost extends ProjectCommandHost<GlobalTaskCommandProject, GlobalTaskCommandName>, GlobalTaskRemovalDeps {
  selection: AgentSelectionServices
}

function patchFrom(raw: unknown): GlobalTaskPatch {
  const input = commandFields(raw, ['title', 'description', 'priority'])
  const patch: GlobalTaskPatch = {}
  if (input.title !== undefined) patch.title = commandString(input.title, 'title')
  if (input.description !== undefined) {
    if (typeof input.description !== 'string') commandInputError('description')
    patch.description = input.description
  }
  if (input.priority !== undefined) {
    if (!isTaskPriority(input.priority)) commandInputError('priority')
    patch.priority = input.priority
  }
  return patch
}

function createFrom(raw: unknown): GlobalTaskInput {
  const input = commandFields(raw, ['title', 'description', 'priority', 'status', 'typeId'])
  const result: GlobalTaskInput = patchFrom({ title: input.title, description: input.description, priority: input.priority })
  if (input.status !== undefined) result.status = commandString(input.status, 'status')
  if (input.typeId !== undefined) result.typeId = commandString(input.typeId, 'typeId')
  return result
}

function subtaskFrom(raw: unknown): SubtaskInput {
  const input = commandFields(raw, ['title', 'spec', 'priority', 'roleId', 'deps', 'answerFor'])
  const result: SubtaskInput = taskCreateFrom({ title: input.title, spec: input.spec, priority: input.priority, roleId: input.roleId, deps: input.deps })
  if (input.answerFor !== undefined) {
    if (input.answerFor !== 'human' && input.answerFor !== 'coordinator') commandInputError('answerFor')
    result.answerFor = input.answerFor
  }
  return result
}

function imagesFrom(raw: unknown) {
  try {
    // Core map не посещает holes; на transport границе они равнозначны отсутствующим bytes.
    if (Array.isArray(raw)) for (let i = 0; i < raw.length; i++) if (!(i in raw)) commandInputError('images')
    return validateAttachments(raw)
  } catch (error) {
    if (error instanceof CommandError) throw error
    throw new CommandError('command.invalidInput', { field: 'images' }, error)
  }
}

/** CRUD и вложения одной глобальной задачи; workflow/PTY запуск живёт в отдельных services. */
export function createGlobalTaskCommands(host: GlobalTaskCommandHost): GlobalTaskCommands {
  const execute = createProjectCommandExecutor(host)
  const remove = createGlobalTaskRemoval(host)
  const root = host.resources.runImagesRoot(host.dataDir)

  function existing(project: GlobalTaskCommandProject, id: string): TaskStore {
    if (!project.store.getRun(id)) throw new CommandError('command.globalTaskNotFound', { globalTaskId: id })
    return project.store
  }

  function scoped<T>(rawId: unknown, operation: (project: GlobalTaskCommandProject, id: string) => T) {
    const id = commandString(rawId, 'globalTaskId')
    return (project: GlobalTaskCommandProject) => { existing(project, id); return operation(project, id) }
  }

  return {
    list: context => execute(context, 'globalTasks.list', () => project => project.store.listGlobalTasks()),
    get: (context, id) => execute(context, 'globalTasks.get', () => scoped(id, (p, runId) => p.store.getGlobalTask(runId))),
    create: (context, raw, rawImages) => execute(context, 'globalTasks.create', () => {
      const { typeId, ...input } = createFrom(raw); const images = imagesFrom(rawImages)
      return (project, ctx) => host.resources.createTaskWithImages(project.store, root, ctx.projectId,
        { ...input, type: project.runType(typeId) }, images)
    }),
    update: (context, id, raw) => execute(context, 'globalTasks.update', () => {
      const patch = patchFrom(raw)
      return scoped(id, (p, runId) => p.store.updateGlobalTask(runId, patch))
    }),
    changeType: (context, id, raw) => execute(context, 'globalTasks.changeType', () => {
      const typeId = commandString(raw, 'typeId')
      return scoped(id, (p, runId) => p.store.changeGlobalTaskType(runId, p.runType(typeId)))
    }),
    move: (context, id, raw) => execute(context, 'globalTasks.move', () => {
      const status = commandString(raw, 'status')
      return scoped(id, (p, runId) => p.store.moveGlobalTask(runId, status))
    }),
    remove: (context, rawId, rawOptions) => execute(context, 'globalTasks.remove', () => {
      const options = rawOptions === undefined ? {} : commandFields(rawOptions, ['cascade'])
      if (options.cascade !== undefined && typeof options.cascade !== 'boolean') commandInputError('cascade')
      const cascade = options.cascade === true; const id = commandString(rawId, 'globalTaskId')
      return (project, ctx) => { existing(project, id); return remove({ ...project, id: ctx.projectId }, id, cascade) }
    }),
    tasks: (context, id) => execute(context, 'globalTasks.tasks', () => scoped(id, (p, runId) => p.store.listSubtasks(runId))),
    createTask: (context, id, raw) => execute(context, 'globalTasks.createTask', () => {
      const input = subtaskFrom(raw)
      return scoped(id, (p, runId) => {
        const role = host.selection.pickRole(p.roles(runId), p.agents(), input.roleId ?? p.store.stageDefaultRole(runId))
        return p.store.createTask({ ...input, roleId: role.id, agent: role.agent, runId })
      })
    }),
    addImages: (context, rawId, rawImages) => execute(context, 'globalTasks.addImages', () => {
      const images = imagesFrom(rawImages); const id = commandString(rawId, 'globalTaskId')
      return (p, ctx) => host.resources.addTaskImages(existing(p, id), root, ctx.projectId, id, images)
    }),
    removeImage: (context, rawId, rawImageId) => execute(context, 'globalTasks.removeImage', () => {
      const id = commandString(rawId, 'globalTaskId'); const imageId = commandString(rawImageId, 'imageId')
      return (p, ctx) => host.resources.removeTaskImage(existing(p, id), root, ctx.projectId, id, imageId)
    }),
    image: (context, rawId, rawImageId) => execute(context, 'globalTasks.image', () => {
      const id = commandString(rawId, 'globalTaskId'); const imageId = commandString(rawImageId, 'imageId')
      return (p, ctx) => host.resources.loadTaskImage(existing(p, id), root, ctx.projectId, id, imageId)
    })
  }
}
