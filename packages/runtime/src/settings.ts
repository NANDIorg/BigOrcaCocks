import {
  mergeAppearance, normalizeAppearance, mergeNotificationSettings, normalizeNotificationSettings,
  type AppLanguage, type RuntimeSettings, type RuntimeSettingsPatch
} from '@orca-board/contracts'
import { DEFAULT_ASSISTANT_SETTINGS, isAgentKind, type AssistantSettings } from '@orca-board/core'
import { extraArgsProblem } from './extra-args.ts'
import type { ProjectMessages } from './project-messages.ts'

export type { RuntimeSettings, RuntimeSettingsPatch } from '@orca-board/contracts'

/** Неизвестные поля хоста сохраняются при записи общих настроек. */
export type StoredRuntimeSettings = Partial<RuntimeSettings> & Record<string, unknown>

export interface ProjectSettingsCodec<S extends RuntimeSettings, P extends RuntimeSettingsPatch> {
  load(raw: StoredRuntimeSettings): S
  merge(raw: StoredRuntimeSettings, patch: P): StoredRuntimeSettings
}

function isAppLanguage(v: unknown): v is AppLanguage {
  return v === 'ru' || v === 'en'
}

const ASSISTANT_TEXT_FIELDS = ['model', 'effort', 'systemPrompt', 'extraArgs'] as const

/** Поля, которые хранятся как введены (без trim — иначе автосохранение съедало бы ввод), как у ролей. */
function keptAsTyped(field: (typeof ASSISTANT_TEXT_FIELDS)[number]): boolean {
  return field === 'systemPrompt' || field === 'extraArgs'
}

/** Битое поле не мешает загрузке остальных настроек и запуску ассистента. */
export function loadedAssistantSettings(raw: unknown): AssistantSettings {
  const r = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const agent = typeof r.agent === 'string' && isAgentKind(r.agent) ? r.agent : DEFAULT_ASSISTANT_SETTINGS.agent
  const out: AssistantSettings = { agent }
  for (const k of ASSISTANT_TEXT_FIELDS) {
    const v = r[k]
    if (typeof v !== 'string' || !v.trim()) continue
    if (k === 'extraArgs' && extraArgsProblem(v)) continue
    out[k] = keptAsTyped(k) ? v : v.trim()
  }
  return out
}

export function normalizeRuntimeSettings(raw: StoredRuntimeSettings): RuntimeSettings {
  return {
    ...(isAppLanguage(raw.language) ? { language: raw.language } : {}),
    appearance: normalizeAppearance(raw.appearance),
    notifications: normalizeNotificationSettings(raw.notifications),
    assistant: loadedAssistantSettings(raw.assistant)
  }
}

/** Общая часть патча отдельно от ассистента: хост сохраняет свой порядок валидации. */
export function mergeRuntimePreferences(raw: StoredRuntimeSettings, patch: RuntimeSettingsPatch): StoredRuntimeSettings {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new Error('настройки приложения: ожидается объект')
  const next = { ...raw }
  if (patch.language !== undefined) {
    if (!isAppLanguage(patch.language)) throw new Error(`language: неизвестный язык «${String(patch.language)}», ожидается ru или en`)
    next.language = patch.language
  }
  if (patch.notifications !== undefined) next.notifications = mergeNotificationSettings(normalizeNotificationSettings(raw.notifications), patch.notifications)
  if (patch.appearance !== undefined) next.appearance = mergeAppearance(normalizeAppearance(next.appearance), patch.appearance)
  return next
}

/** Ошибки локализует хост; codec не выбирает глобальный язык интерфейса. */
export function createRuntimeSettings(messages: ProjectMessages) {
  function mergedAssistantSettings(current: AssistantSettings, patch: unknown): AssistantSettings {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new messages.Error('assistant.notObject')
    const p = patch as Record<string, unknown>
    const next: AssistantSettings = { ...current }
    if (p.agent !== undefined) {
      if (typeof p.agent !== 'string' || !isAgentKind(p.agent)) throw new messages.Error('assistant.unknownAgent', { agent: String(p.agent) })
      if (p.agent !== current.agent) {
        delete next.model
        delete next.effort
        delete next.extraArgs
      }
      next.agent = p.agent
    }
    for (const k of ASSISTANT_TEXT_FIELDS) {
      const v = p[k]
      if (v === undefined) continue
      if (typeof v !== 'string') throw new messages.Error('assistant.notString', { field: k })
      if (!v.trim()) {
        delete next[k]
        continue
      }
      const reason = k === 'extraArgs' ? extraArgsProblem(v) : undefined
      if (reason) throw new messages.Error('assistant.extraArgsInvalid', { reason })
      next[k] = keptAsTyped(k) ? v : v.trim()
    }
    return next
  }

  const codec: ProjectSettingsCodec<RuntimeSettings, RuntimeSettingsPatch> = {
    load: normalizeRuntimeSettings,
    merge(raw, patch) {
      const next = mergeRuntimePreferences(raw, patch)
      if (patch.assistant !== undefined) next.assistant = mergedAssistantSettings(loadedAssistantSettings(raw.assistant), patch.assistant)
      return next
    }
  }
  return { ...codec, mergedAssistantSettings }
}
