/**
 * Клавиши окна «Настройки» (`settings/SettingsModal.tsx`). В полноэкранном режиме первый Escape только
 * сворачивает окно к обычному размеру — иначе одно нажатие закрывало бы настройки целиком, и человек терял бы
 * место, где был. Повторный Escape закрывает окно, как без полноэкранного режима.
 */

/** Что сделать по клавише: `exitFullscreen` — свернуть окно, `close` — закрыть настройки. */
export type SettingsKeyAction = 'exitFullscreen' | 'close'

export function settingsKeyAction(key: string, fullscreen: boolean): SettingsKeyAction | undefined {
  if (key !== 'Escape') return undefined
  return fullscreen ? 'exitFullscreen' : 'close'
}
