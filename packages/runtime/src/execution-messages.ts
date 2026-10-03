/** Сообщения общих ресурсов и запуска; перевод и класс ошибки принадлежат хосту. */
export type ExecutionMessageKey =
  | 'assistant.extraArgsInvalid'
  | 'attachments.invalid'
  | 'attachments.needText'
  | 'attachments.noWorktree'
  | 'attachments.notForAction'
  | 'attachments.saveFailed'
  | 'common.none'
  | 'coordinator.alreadyRunning'
  | 'coordinator.cannotStart'
  | 'coordinator.finishing'
  | 'coordinator.inboxNotTarget'
  | 'coordinator.noObjective'
  | 'extraArgs.control'
  | 'extraArgs.count'
  | 'extraArgs.length'
  | 'extraArgs.notFlag'
  | 'extraArgs.quote'
  | 'extraArgs.separator'
  | 'git.runBranchFailed'
  | 'git.runBranchMissing'
  | 'global.attachmentNotOpenable'
  | 'global.imageFileMissing'
  | 'global.imageNotFound'
  | 'global.imagesEmpty'
  | 'global.imagesSaveFailed'
  | 'global.notAnImage'
  | 'global.notFound'
  | 'role.extraArgsInvalid'
  | 'role.missing'
  | 'role.missing.hint'
  | 'role.missing.systemHint'
  | 'worker.cannotStart'

export interface ExecutionMessage {
  key: ExecutionMessageKey
  params?: ExecutionMessageParams
}
export type ExecutionMessageParams = Record<string, string | number | ExecutionMessage>
export interface ExecutionMessages {
  error(key: ExecutionMessageKey, params?: ExecutionMessageParams): Error
}
export interface ExecutionLogger {
  warn(message: string, detail?: string): void
}
