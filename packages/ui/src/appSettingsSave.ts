import type { AppSettings, AppSettingsPatch, OrcaApi } from '../shared/ipc'
import { ipcErrorMessage } from './ipcError'
import { setLocale, t } from './i18n'
import { appearance } from './appearance'

/** Итог записи настроек: свежие настройки (если записались) и ошибка для показа человеку. */
export interface AppSettingsSave {
  settings: AppSettings | null
  error: string | null
}

/**
 * Патч не дошёл до main: старый main не знает поля `language` и молча его отбросит (выбор не переживёт
 * перезапуск); так же с `updates` и `assistant`. У оформления проверяется каждое изменённое поле ответа.
 */
export function droppedPatch(patch: AppSettingsPatch, next: Partial<Pick<AppSettings, 'language' | 'updates' | 'appearance' | 'assistant'>>): boolean {
  return Boolean(
    (patch.language && next.language !== patch.language) ||
    (patch.updates && !next.updates) ||
    (patch.assistant && !next.assistant) ||
    (patch.appearance && Object.entries(patch.appearance).some(([key, value]) => value !== undefined && next.appearance?.[key as keyof NonNullable<AppSettings['appearance']>] !== value))
  )
}

/**
 * Записать патч настроек приложения. Общий для «Настроек» и мастера первого запуска. Язык меняется сразу, не
 * дожидаясь main: окно переводится мгновенно. Сбой не бросает — возвращается `error`.
 */
export async function saveAppSettings(api: Pick<OrcaApi['app'], 'setSettings'>, patch: AppSettingsPatch): Promise<AppSettingsSave> {
  if (patch.language) setLocale(patch.language)
  try {
    const next = await api.setSettings(patch)
    const stale = droppedPatch(patch, next)
    // Тема применяется только после подтверждения main: сбой записи не оставляет несохранённый вид.
    if (patch.appearance && !stale) appearance.apply(next.appearance)
    return { settings: next, error: stale ? t('common.staleApp') : null }
  } catch (e) {
    return { settings: null, error: ipcErrorMessage(e) }
  }
}
