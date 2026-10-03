import type { GlobalTask, Task, AttachmentInput } from '@orca-board/core'
import type { GlobalTaskInput, GlobalTaskPatch, SubtaskInput } from './tasks.ts'
import type { ProjectCommandContext } from './project-commands.ts'

export type GlobalTaskCommandName = 'globalTasks.list' | 'globalTasks.get' | 'globalTasks.create' | 'globalTasks.update'
  | 'globalTasks.changeType' | 'globalTasks.move' | 'globalTasks.remove' | 'globalTasks.tasks' | 'globalTasks.createTask'
  | 'globalTasks.addImages' | 'globalTasks.removeImage' | 'globalTasks.image'

/** Owner API: project/client/actor устанавливает transport host; DTO не открывают persistence. */
export interface GlobalTaskCommands {
  list(context: ProjectCommandContext): GlobalTask[]
  get(context: ProjectCommandContext, globalTaskId: string): GlobalTask
  create(context: ProjectCommandContext, input: GlobalTaskInput, images?: AttachmentInput[] | null): GlobalTask
  update(context: ProjectCommandContext, globalTaskId: string, patch: GlobalTaskPatch): GlobalTask
  changeType(context: ProjectCommandContext, globalTaskId: string, typeId: string): GlobalTask
  move(context: ProjectCommandContext, globalTaskId: string, status: string): GlobalTask
  remove(context: ProjectCommandContext, globalTaskId: string, options?: { cascade?: boolean }): { deleted: string; tasks: string[] }
  tasks(context: ProjectCommandContext, globalTaskId: string): Task[]
  createTask(context: ProjectCommandContext, globalTaskId: string, input: SubtaskInput): Task
  addImages(context: ProjectCommandContext, globalTaskId: string, images?: AttachmentInput[] | null): GlobalTask
  removeImage(context: ProjectCommandContext, globalTaskId: string, imageId: string): GlobalTask
  image(context: ProjectCommandContext, globalTaskId: string, imageId: string): { mime: string; data: Uint8Array }
}
