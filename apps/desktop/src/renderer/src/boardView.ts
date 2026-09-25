import type { ColumnKind } from '@orca-board/core'
import type { CardState } from './cardState'

/**
 * Вид локальной доски подзадач, который человек настраивает сам: фильтр тулбара, свёрнутое «Сделано» и «мои роли».
 * Хранится в localStorage, как сортировка (`boardSort.ts`): при любой ошибке хранилища — значения по умолчанию.
 */
export type BoardFilter = 'all' | 'wait' | 'bad' | 'roles'

export const BOARD_FILTER_KEY = 'orca.board.filter'
export const BOARD_DONE_COLLAPSED_KEY = 'orca.board.doneCollapsed'
export const BOARD_ROLES_KEY = 'orca.board.roles'

export const BOARD_FILTERS: readonly BoardFilter[] = ['all', 'wait', 'bad', 'roles']

export function isBoardFilter(v: unknown): v is BoardFilter {
  return BOARD_FILTERS.includes(v as BoardFilter)
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // localStorage недоступен — настройка просто не переживёт перезапуск
  }
}

export function readFilter(): BoardFilter {
  const v = read(BOARD_FILTER_KEY)
  return isBoardFilter(v) ? v : 'all'
}

export function writeFilter(filter: BoardFilter): void {
  write(BOARD_FILTER_KEY, filter)
}

/** «Сделано» свёрнуто по умолчанию: закрытые задачи растут без конца и не должны отнимать место у живых. */
export function readDoneCollapsed(): boolean {
  return read(BOARD_DONE_COLLAPSED_KEY) !== '0'
}

export function writeDoneCollapsed(collapsed: boolean): void {
  write(BOARD_DONE_COLLAPSED_KEY, collapsed ? '1' : '0')
}

/** Выбранные «мои роли» (id ролей); битое значение — пусто. */
export function readRoles(): string[] {
  const raw = read(BOARD_ROLES_KEY)
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function writeRoles(roleIds: readonly string[]): void {
  write(BOARD_ROLES_KEY, JSON.stringify(roleIds))
}

/** Что фильтр знает о карточке. */
export interface FilterSubject {
  state: CardState
  /** Ждёт человека — задача есть в ленте «Ждут вас» (`attentionTaskIds`). */
  waits: boolean
  roleId: string
}

/**
 * Проходит ли карточка фильтр. «Мои роли» без выбранных ролей ничего не отсекает: пустой выбор не должен
 * превращать доску в пустую.
 */
export function matchesFilter(filter: BoardFilter, s: FilterSubject, roleIds: readonly string[]): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'wait':
      return s.waits
    case 'bad':
      return s.state === 'bad'
    case 'roles':
      return roleIds.length === 0 || roleIds.includes(s.roleId)
  }
}

/** Части полосы прогресса в тулбаре: сколько задач в done, на ревью, в «Нужен ответ» и в работе. */
export interface ProgressPart {
  key: 'done' | 'review' | 'input' | 'progress'
  count: number
}

export interface BoardProgress {
  total: number
  done: number
  parts: ProgressPart[]
}

const PROGRESS_KEY: Partial<Record<ColumnKind, ProgressPart['key']>> = {
  done: 'done',
  review: 'review',
  needs_input: 'input',
  in_progress: 'progress'
}

/** Прогресс по видам колонок задач; бэклог и пользовательские колонки в полосе не окрашиваются. */
export function boardProgress(kinds: readonly (ColumnKind | undefined)[]): BoardProgress {
  const counts: Record<ProgressPart['key'], number> = { done: 0, review: 0, input: 0, progress: 0 }
  for (const kind of kinds) {
    const key = kind ? PROGRESS_KEY[kind] : undefined
    if (key) counts[key]++
  }
  const order: ProgressPart['key'][] = ['done', 'review', 'input', 'progress']
  return {
    total: kinds.length,
    done: counts.done,
    parts: order.filter((k) => counts[k] > 0).map((key) => ({ key, count: counts[key] }))
  }
}
