import { DEFAULT_APP_THEME, isAppTheme, type AppTheme } from './theme'

export type MotionPreference = 'system' | 'reduced'
export interface AppearanceSettings {
  theme: AppTheme
  motion: MotionPreference
  highSaturation: boolean
}

export const DEFAULT_APPEARANCE: Readonly<AppearanceSettings> = { theme: DEFAULT_APP_THEME, motion: 'system', highSaturation: false }

function isMotion(value: unknown): value is MotionPreference {
  return value === 'system' || value === 'reduced'
}

/** Старый/повреждённый файл не меняет привычный интерфейс и не роняет запуск. */
export function normalizeAppearance(raw: unknown): AppearanceSettings {
  const value = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  return {
    theme: isAppTheme(value.theme) ? value.theme : DEFAULT_APPEARANCE.theme,
    motion: isMotion(value.motion) ? value.motion : DEFAULT_APPEARANCE.motion,
    highSaturation: typeof value.highSaturation === 'boolean' ? value.highSaturation : DEFAULT_APPEARANCE.highSaturation
  }
}

/** Запись строже чтения: неверный патч целиком отклоняется до сохранения файла. */
export function mergeAppearance(current: AppearanceSettings, raw: unknown): AppearanceSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('appearance: ожидается объект')
  const patch = raw as Record<string, unknown>
  if (patch.theme !== undefined && !isAppTheme(patch.theme)) throw new Error('appearance.theme: неизвестная тема')
  if (patch.motion !== undefined && !isMotion(patch.motion)) throw new Error('appearance.motion: ожидается system или reduced')
  if (patch.highSaturation !== undefined && typeof patch.highSaturation !== 'boolean') throw new Error('appearance.highSaturation: ожидается boolean')
  return normalizeAppearance({
    theme: patch.theme ?? current.theme,
    motion: patch.motion ?? current.motion,
    highSaturation: patch.highSaturation ?? current.highSaturation
  })
}
