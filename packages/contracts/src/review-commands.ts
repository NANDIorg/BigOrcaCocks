import type { AttachmentInput, Task } from '@orca-board/core'
import type { ReviewInfo } from './tasks.ts'
import type { ProjectCommandContext } from './project-commands.ts'

export type ReviewCommandName = 'review.info' | 'review.accept' | 'review.reject'

/** Проверки и Git-эффекты выполняет owner выбранного проекта. */
export interface ReviewCommands {
  info(context: ProjectCommandContext, taskId: string): Promise<ReviewInfo>
  accept(context: ProjectCommandContext, taskId: string, text?: string): Promise<Task | undefined>
  reject(context: ProjectCommandContext, taskId: string, feedback: string, images?: AttachmentInput[]): Promise<Task | undefined>
}
