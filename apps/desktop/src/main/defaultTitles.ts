import { DEFAULT_COLUMNS, type BoardColumn } from '@orca-board/core'
import { mt, type MKey } from './i18n'

/**
 * Название колонки для текстов main (подзаголовок уведомления). Колонки — данные проекта, но встроенные
 * «Бэклог», «В работе»… лежат по-русски: пока человек не переименовал колонку, показываем их на языке
 * интерфейса по id. Сохранённые данные не меняются (то же делает renderer — `defaultTitles.ts`).
 */
export function columnTitle(c: Pick<BoardColumn, 'id' | 'title'>): string {
  const key = COLUMN_KEYS[c.id]
  const builtin = DEFAULT_COLUMNS.find((d) => d.id === c.id)
  return key && builtin && builtin.title === c.title ? mt(key) : c.title
}

const COLUMN_KEYS: Partial<Record<string, MKey>> = {
  backlog: 'column.backlog',
  ready: 'column.ready',
  in_progress: 'column.in_progress',
  needs_input: 'column.needs_input',
  review: 'column.review',
  done: 'column.done'
}
