import {
  createRuntimeSettings, mergeRuntimePreferences, normalizeRuntimeSettings,
  type ProjectSettingsCodec, type StoredRuntimeSettings
} from '@orca-board/runtime'
import { DEFAULT_APPEARANCE, DEFAULT_NOTIFICATION_SETTINGS } from '@orca-board/contracts'
import { DEFAULT_ASSISTANT_SETTINGS } from '@orca-board/core'
import { DEFAULT_UPDATE_SETTINGS, type AppSettings, type AppSettingsPatch, type UpdateSettings } from '../shared/ipc'
import { OrcaError, mt } from './i18n'

export const DEFAULT_APP_SETTINGS: AppSettings = {
  keepInBackground: true,
  appearance: { ...DEFAULT_APPEARANCE },
  notifications: DEFAULT_NOTIFICATION_SETTINGS,
  updates: DEFAULT_UPDATE_SETTINGS,
  assistant: DEFAULT_ASSISTANT_SETTINGS
}

const UPDATE_SETTING_KEYS = Object.keys(DEFAULT_UPDATE_SETTINGS) as (keyof UpdateSettings)[]

function normalizeUpdateSettings(raw: unknown): UpdateSettings {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const out = { ...DEFAULT_UPDATE_SETTINGS }
  for (const k of UPDATE_SETTING_KEYS) if (typeof r[k] === 'boolean') out[k] = r[k] as boolean
  return out
}

export const { mergedAssistantSettings } = createRuntimeSettings({ Error: OrcaError, text: mt })

/** Общие настройки + управление окном и обновлениями только в Desktop. */
export const desktopProjectSettings: ProjectSettingsCodec<AppSettings, AppSettingsPatch> = {
  load(raw) {
    return {
      keepInBackground: typeof raw.keepInBackground === 'boolean' ? raw.keepInBackground : DEFAULT_APP_SETTINGS.keepInBackground,
      ...normalizeRuntimeSettings(raw),
      updates: normalizeUpdateSettings(raw.updates)
    }
  },
  merge(raw, patch) {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new Error('настройки приложения: ожидается объект')
    let next: StoredRuntimeSettings = { ...raw }
    if (patch.keepInBackground !== undefined) {
      if (typeof patch.keepInBackground !== 'boolean') throw new Error('keepInBackground должен быть boolean')
      next.keepInBackground = patch.keepInBackground
    }
    next = mergeRuntimePreferences(next, patch)
    if (patch.updates !== undefined) {
      if (typeof patch.updates !== 'object' || patch.updates === null || Array.isArray(patch.updates)) throw new Error('updates: ожидается объект')
      const merged = normalizeUpdateSettings(raw.updates)
      for (const k of UPDATE_SETTING_KEYS) {
        const v = patch.updates[k]
        if (v === undefined) continue
        if (typeof v !== 'boolean') throw new Error(`updates.${k} должен быть boolean`)
        merged[k] = v
      }
      next.updates = merged
    }
    if (patch.assistant !== undefined) next.assistant = mergedAssistantSettings(normalizeRuntimeSettings(raw).assistant, patch.assistant)
    return next
  }
}
