import { priorityRank, type GlobalTask, type Task, type TaskPriority } from '@orca-board/core'

/** Порядок карточек внутри колонок. */
export type BoardSort = 'created' | 'done' | 'updated' | 'priority'

/** Ключи localStorage: у локального и глобального канбана выбор хранится отдельно. */
export const BOARD_SORT_KEY = 'orca.board.sort'
export const GLOBAL_BOARD_SORT_KEY = 'orca.globalBoard.sort'

/** Сортировки по датам — у глобального канбана (приоритета у глобальных задач пока нет). */
export const SORT_OPTIONS: { value: BoardSort; title: string }[] = [
  { value: 'created', title: 'по созданию' },
  { value: 'done', title: 'по завершению' },
  { value: 'updated', title: 'по обновлению' }
]

/** Сортировки локального канбана: даты и приоритет. */
export const BOARD_SORT_OPTIONS: { value: BoardSort; title: string }[] = [
  ...SORT_OPTIONS,
  { value: 'priority', title: 'по приоритету' }
]

export function isBoardSort(v: unknown): v is BoardSort {
  return BOARD_SORT_OPTIONS.some((o) => o.value === v)
}

/** Сохранённая сортировка; при любой ошибке localStorage — дефолт. */
export function readSort(key: string): BoardSort {
  try {
    const v = localStorage.getItem(key)
    return isBoardSort(v) ? v : 'created'
  } catch {
    return 'created'
  }
}

export function writeSort(key: string, sort: BoardSort): void {
  try {
    localStorage.setItem(key, sort)
  } catch {
    // localStorage недоступен — сортировка просто не переживёт перезапуск
  }
}

/** Даты карточки, по которым сортируем. */
export interface SortDates {
  createdAt: number
  updatedAt: number
  doneAt?: number
}

/**
 * Компаратор: created — старые сверху; done/updated — свежие сверху, без doneAt — в конец.
 * priority по датам — как created: это порядок при равном приоритете.
 */
export function compareByDates(sort: BoardSort, a: SortDates, b: SortDates): number {
  switch (sort) {
    case 'created':
    case 'priority':
      return a.createdAt - b.createdAt
    case 'done':
      if (a.doneAt !== undefined && b.doneAt !== undefined) return b.doneAt - a.doneAt
      if (a.doneAt !== undefined) return -1
      if (b.doneAt !== undefined) return 1
      return b.updatedAt - a.updatedAt
    case 'updated':
      return b.updatedAt - a.updatedAt
  }
}

/** Всё, у чего может быть приоритет: Task, а позже и GlobalTask. */
export interface Prioritized {
  priority?: TaskPriority
}

/** Выше приоритет — раньше. Нет поля (задача от старого main) — как normal. */
export function compareByPriority(a: Prioritized, b: Prioritized): number {
  return priorityRank(a.priority) - priorityRank(b.priority)
}

/** Сначала приоритет (только в режиме priority), при равном — даты. */
export function compareSorted(sort: BoardSort, a: Prioritized & SortDates, b: Prioritized & SortDates): number {
  return (sort === 'priority' ? compareByPriority(a, b) : 0) || compareByDates(sort, a, b)
}

export function compareTasks(sort: BoardSort, a: Task, b: Task): number {
  return compareSorted(sort, a, b)
}

/** Даты глобальной задачи: обновление — активность карточки или подзадач, завершение — закрытие прогона. */
export function globalSortDates(g: GlobalTask): SortDates {
  return { createdAt: g.createdAt, updatedAt: g.activityAt, doneAt: g.closedAt }
}

export function compareGlobals(sort: BoardSort, a: GlobalTask, b: GlobalTask): number {
  return compareByDates(sort, globalSortDates(a), globalSortDates(b))
}

export function formatStamp(ts: number): string {
  return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
