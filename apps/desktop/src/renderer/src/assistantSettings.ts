import { DEFAULT_ASSISTANT_SETTINGS, type AgentInfo, type AgentKind, type AssistantSettings } from '@orca-board/core'
import type { AppSettings } from '../../shared/ipc'
import { agentChangePatch, modelChangePatch } from './roleEdit'
import { libraryAgents } from './taskTypeEdit'

// Логика раздела «Настройки → Ассистент» без React — чтобы тестировать node --test (assistantSettings.test.ts).

/**
 * Что показывать в разделе: настройки ещё грузятся, старый main без `assistant` (записать их нельзя — просим
 * перезапустить приложение) или сами настройки.
 */
export type AssistantView =
  | { kind: 'loading' }
  | { kind: 'stale' }
  | { kind: 'ready'; assistant: AssistantSettings }

export function assistantView(settings: Pick<AppSettings, 'assistant'> | null): AssistantView {
  if (!settings) return { kind: 'loading' }
  return settings.assistant ? { kind: 'ready', assistant: settings.assistant } : { kind: 'stale' }
}

/** Настройки с правкой; пустые model/effort/systemPrompt/extraArgs не храним (undefined — «по умолчанию»), как `withPatch` у ролей. */
export function withAssistantPatch(s: AssistantSettings, p: Partial<AssistantSettings>): AssistantSettings {
  const next: AssistantSettings = { ...s, ...p }
  if (!next.model) delete next.model
  if (!next.effort) delete next.effort
  if (!next.systemPrompt?.trim()) delete next.systemPrompt
  if (!next.extraArgs?.trim()) delete next.extraArgs
  return next
}

/** Смена агента: модель, effort и флаги запуска прошлого агента сбрасываются — тем же `agentChangePatch`, что у ролей. */
export function assistantAgentPatch(agent: AgentKind): Partial<AssistantSettings> {
  const { model, effort, extraArgs } = agentChangePatch(agent)
  return { agent, model, effort, extraArgs }
}

/** Смена модели: effort, которого нет у новой модели (`efforts`), сбрасывается. */
export function assistantModelPatch(s: AssistantSettings, model: string, efforts: readonly string[]): Partial<AssistantSettings> {
  return modelChangePatch(s.effort, model, efforts)
}

/**
 * Патч для `app:setSettings` из черновика целиком: пустое поле уходит пустой строкой — main его очищает
 * (`mergedAssistantSettings`), а не оставляет прежнее значение. `withExtraArgs` — main умеет флаги
 * (`extraArgsSupported`): старому main поле не отправляем вовсе.
 */
export function assistantSavePatch(s: AssistantSettings, withExtraArgs: boolean): Partial<AssistantSettings> {
  return {
    agent: s.agent, model: s.model ?? '', effort: s.effort ?? '', systemPrompt: s.systemPrompt ?? '',
    ...(withExtraArgs ? { extraArgs: s.extraArgs ?? '' } : {})
  }
}

/** Агенты для выбора: у ассистента, как у типов библиотеки, доступны все установленные (`libraryAgents`). */
export function assistantAgents(agents: readonly AgentInfo[]): AgentInfo[] {
  return libraryAgents(agents)
}

/** Агент для подписи терминала ассистента: из настроек; старый main или настройки не загружены — агент по умолчанию. */
export function assistantAgentOf(settings: Pick<AppSettings, 'assistant'> | null | undefined): AgentKind {
  return settings?.assistant?.agent ?? DEFAULT_ASSISTANT_SETTINGS.agent
}
