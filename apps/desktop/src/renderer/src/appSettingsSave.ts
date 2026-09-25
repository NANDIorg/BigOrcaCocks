import type { AppSettings, AppSettingsPatch, OrcaApi } from '../../shared/ipc'
import { ipcErrorMessage } from './ipcError'
import { setLocale, t } from './i18n'

/** Итог записи настроек: свежие настройки (если записались) и ошибка для показа человеку. */
export interface AppSettingsSave {
  settings: AppSettings | null
  error: string | null
}

/**
 * Патч не дошёл до main: старый main не знает поля `language` и молча его отбросит (выбор не переживёт
 * перезапуск); так же с `updates` — без поля в ответе main патч не сохранил.
 */
export function droppedPatch(patch: AppSettingsPatch, next: Pick<AppSettings, 'language' | 'updates'>): boolean {
  return Boolean((patch.language && next.language !== patch.language) || (patch.updates && !next.updates))
}

/**
 * Записать патч настроек приложения. Общий для «Настроек» и мастера первого запуска. Язык меняется сразу, не
 * дожидаясь main: окно переводится мгновенно. Сбой не бросает — возвращается `error`.
 */
export async function saveAppSettings(api: Pick<OrcaApi['app'], 'setSettings'>, patch: AppSettingsPatch): Promise<AppSettingsSave> {
  if (patch.language) setLocale(patch.language)
  try {
    const next = await api.setSettings(patch)
    return { settings: next, error: droppedPatch(patch, next) ? t('common.staleApp') : null }
  } catch (e) {
    return { settings: null, error: ipcErrorMessage(e) }
  }
}
