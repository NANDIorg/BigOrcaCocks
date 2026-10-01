// Вкладки проекта в шапке (App.tsx) и их восстановление после перезапуска. Чистый модуль: localStorage читает App.

/** Вкладка проекта. Бывшая «Файлы» (`files`) убрана: все файлы проекта — в окне «Документы». */
export type Tab = 'board' | 'terminals' | 'stats' | 'info'

export const TABS: readonly Tab[] = ['board', 'terminals', 'stats', 'info']

export const tabKey = (projectId: string): string => `orca.tab.${projectId}`

/**
 * Сохранённое значение → вкладка. Неизвестное — «Канбан»: так проект, где до обновления была открыта «Файлы»
 * (`files`), открывается на доске, без миграции состояния.
 */
export function parseTab(value: string | null | undefined): Tab {
  return TABS.find((tab) => tab === value) ?? 'board'
}
