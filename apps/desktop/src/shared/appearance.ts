import { DEFAULT_APP_THEME, isAppTheme, type AppTheme } from './theme'

export type MotionPreference = 'system' | 'reduced'
export interface AppearanceSettings {
  theme: AppTheme
  motion: MotionPreference
}

export const DEFAULT_APPEARANCE: Readonly<AppearanceSettings> = { theme: DEFAULT_APP_THEME, motion: 'system' }

function isMotion(value: unknown): value is MotionPreference {
  return value === 'system' || value === 'reduced'
}

/** Старый/повреждённый файл не меняет привычный интерфейс и не роняет запуск. */
export function normalizeAppearance(raw: unknown): AppearanceSettings {
  const value = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  return {
    theme: isAppTheme(value.theme) ? value.theme : DEFAULT_APPEARANCE.theme,
    motion: isMotion(value.motion) ? value.motion : DEFAULT_APPEARANCE.motion
  }
}

/** Запись строже чтения: неверный патч целиком отклоняется до сохранения файла. */
export function mergeAppearance(current: AppearanceSettings, raw: unknown): AppearanceSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('appearance: ожидается объект')
  const patch = raw as Record<string, unknown>
  if (patch.theme !== undefined && !isAppTheme(patch.theme)) throw new Error('appearance.theme: неизвестная тема')
  if (patch.motion !== undefined && !isMotion(patch.motion)) throw new Error('appearance.motion: ожидается system или reduced')
  return normalizeAppearance({
    theme: patch.theme ?? current.theme,
    motion: patch.motion ?? current.motion
  })
}
