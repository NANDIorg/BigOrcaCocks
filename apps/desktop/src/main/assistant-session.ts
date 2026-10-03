import { AssistantSession as RuntimeAssistantSession } from '@orca-board/runtime'
import type { AssistantSessionDependencies } from '@orca-board/runtime'
import { mt, OrcaError } from './i18n'
import type { AssistantChatSnapshot } from '@orca-board/contracts'

function localized(snapshot: AssistantChatSnapshot): AssistantChatSnapshot {
  return snapshot.storageFailed ? { ...snapshot, error: mt('assistantChat.historyStorage') } : snapshot
}

/** Desktop сохраняет прежний constructor и ошибки для IPC/socket. */
export class AssistantSession extends RuntimeAssistantSession {
  constructor(deps: Omit<AssistantSessionDependencies, 'errors'>) {
    super({ ...deps, onUpdate: update => {
      if (!update.snapshot?.storageFailed) { deps.onUpdate(update); return }
      const snapshot = localized(update.snapshot)
      deps.onUpdate({ ...update, snapshot, ...('status' in update ? { error: snapshot.error } : {}) })
    }, errors: {
      unknownPty: () => new OrcaError('assistantChat.unknownPty'),
      emptyText: () => new OrcaError('assistantChat.emptyText'),
      readOnly: () => new OrcaError('assistantChat.historyOnly'),
      storage: cause => Object.assign(new OrcaError('assistantChat.historyStorage'), { cause }),
      historyLoad: cause => Object.assign(new OrcaError('assistantChat.historyLoad'), { cause })
    } })
  }
  override snapshot(id: string): AssistantChatSnapshot { return localized(super.snapshot(id)) }
}
