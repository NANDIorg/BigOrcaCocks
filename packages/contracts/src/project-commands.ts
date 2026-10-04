/** Host устанавливает автора после проверки соединения; JSON клиента не доказывает полномочия. */
export interface ClientCommandContext {
  clientId: string
  actor: { kind: 'operator' | 'agent' | 'system'; id: string }
}

export interface ProjectCommandContext extends ClientCommandContext {
  projectId: string
}

export type CommandErrorCode = 'command.invalidContext' | 'command.forbidden' | 'command.invalidInput'
  | 'command.projectNotFound' | 'command.taskNotFound' | 'command.globalTaskNotFound'
  | 'command.requestNotFound' | 'command.questionNotFound' | 'command.stale' | 'command.rejected' | 'command.conflict'

export interface CommandErrorData {
  code: CommandErrorCode
  details: { field?: string; projectId?: string; taskId?: string; globalTaskId?: string; requestId?: string; questionId?: string; reason?: string }
}
