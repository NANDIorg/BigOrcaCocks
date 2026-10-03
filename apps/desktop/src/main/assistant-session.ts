import { AssistantSession as RuntimeAssistantSession } from '@orca-board/runtime'
import type { AssistantSessionDependencies } from '@orca-board/runtime'
import { OrcaError } from './i18n'

/** Desktop сохраняет прежний constructor и ошибки для IPC/socket. */
export class AssistantSession extends RuntimeAssistantSession {
  constructor(deps: Omit<AssistantSessionDependencies, 'errors'>) {
    super({ ...deps, errors: {
      unknownPty: () => new OrcaError('assistantChat.unknownPty'),
      emptyText: () => new OrcaError('assistantChat.emptyText')
    } })
  }
}
