import { stableJson } from '@orca-board/core'
import { t } from './i18n'
import type { Workflow, AgentKind } from '@orca-board/core'
import type { OrcaApi } from '../../shared/ipc'
import type { WorkflowAssistantContext } from '../../shared/assistant-workflow'

export interface WorkflowDraft { draft: Workflow; baseline: Workflow }
export interface WorkflowComposerRequest { nonce: number; text: string }
export interface WorkflowAttachment { nonce: number; context: WorkflowAssistantContext }
export type WorkflowSectionRequest = { section: 'updates' | 'assistant'; nonce: number }
  | { section: `type:${string}`; nonce: number; tab: 'workflow'; restore?: Extract<WorkflowAssistantContext, { mode: 'edit' }> }
export function syncWorkflowDraft(state: WorkflowDraft, incoming: Workflow): WorkflowDraft & { conflict: boolean; replaced: boolean } {
  if (stableJson(state.baseline) === stableJson(incoming)) return { ...state, conflict: false, replaced: false }
  if (stableJson(state.draft) !== stableJson(state.baseline)) return { ...state, conflict: true, replaced: false }
  return { draft: incoming, baseline: incoming, conflict: false, replaced: true }
}
export function consumeWorkflowAttachment(current: WorkflowAttachment | null, sent: WorkflowAttachment, session: string, currentSession: string | null): WorkflowAttachment | null {
  return session === currentSession && current?.nonce === sent.nonce ? null : current
}
export function workflowAssistantApi(api: Partial<OrcaApi>): OrcaApi['workflowAssistant'] {
  if (typeof api.workflowAssistant?.save !== 'function') throw new Error(t('shell.assistant.chatStaleApp'))
  return api.workflowAssistant
}
export function sendWorkflowApi(api: Partial<OrcaApi>): NonNullable<OrcaApi['assistantChat']['sendWithWorkflow']> {
  if (typeof api.assistantChat?.sendWithWorkflow !== 'function') throw new Error(t('shell.assistant.chatStaleApp'))
  return api.assistantChat.sendWithWorkflow
}
export function requestedWorkflowTypeExists(ids: readonly string[], id: string): boolean { return ids.includes(id) }

/** Старый main при новом preload тоже требует перезапуска. */
export function workflowAssistantError(message: string): string {
  return /No handler registered for '(workflowAssistant:|assistantChat:sendWithWorkflow|taskTypes:patch|taskTypes:rename)/.test(message)
    ? t('shell.assistant.chatStaleApp') : message
}

/** Поздний ответ не стирает следующий текст, новое вложение или compose другого диалога. */
export function settledWorkflowDraft(current: string, submitted: string, sentSession: string, currentSession: string | null, sentNonce: number | undefined, currentNonce: number | undefined): string {
  return sentSession === currentSession && sentNonce === currentNonce && current === submitted ? '' : current
}


export interface WorkflowAgentChoice {
  sessionId: string
  attachmentNonce: number
  sourceAgent: 'amp' | 'shell'
  selectedAgent?: AgentKind
}

/** Завершение выбора агента в настройках: действие вызовет только подходящий handoff. */
export function applyWorkflowAgentChoice(choice: WorkflowAgentChoice | null, nextAgent: AgentKind, sessionId: string | null, attachment: WorkflowAttachment | null, restart: () => void): boolean {
  if (!choice || !attachment || choice.sessionId !== sessionId || choice.attachmentNonce !== attachment.nonce
    || (choice.sourceAgent !== 'amp' && choice.sourceAgent !== 'shell')
    || choice.selectedAgent !== nextAgent || nextAgent === 'amp' || nextAgent === 'shell') return false
  restart()
  return true
}
