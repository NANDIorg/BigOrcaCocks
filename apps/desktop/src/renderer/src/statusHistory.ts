import type { BoardColumn, StatusChange, StatusSource } from '@orca-board/core'
import { formatDuration } from './duration'
import { t } from './i18n'

const STATUS_SOURCES: StatusSource[] = ['human', 'cli', 'worker', 'workflow', 'app']

/**
 * Подписи источника перехода (`StatusChange.by`, docs/architecture.md, «История статусов»). Геттеры — чтобы текст
 * был на текущем языке и у модулей, которые берут таблицу как есть (globalTimeline.ts). У `cli` в подписи и
 * координатор, и CLI: сокет не различает координатора и человека в терминале.
 */
export const STATUS_SOURCE_TITLES: Readonly<Record<StatusSource, string>> = Object.defineProperties(
  {} as Record<StatusSource, string>,
  Object.fromEntries(STATUS_SOURCES.map((s) => [s, { enumerable: true, get: () => t(`board.source.${s}`) }]))
)

/** Сколько последних переходов видно в свёрнутом блоке. */
export const STATUS_HISTORY_COLLAPSED = 5

/** Строка блока «История статуса»: переход, склеенный с колонкой доски, и сколько задача в нём пробыла. */
export interface StatusHistoryRow {
  /** Порядковый номер записи в истории — ключ React. */
  index: number
  status: string
  /** Название колонки; колонку удалили — её id. */
  title: string
  /** Цвет колонки; колонки нет — undefined, бейдж без цвета. */
  color?: string
  at: number
  source: string
  /** До следующего перехода, у текущего — до now. */
  durationMs: number
  /** Последняя запись — статус сейчас. */
  current: boolean
  /** Стартовая запись миграции: `at` — последняя правка задачи, а не момент входа в колонку. */
  migrated: boolean
}

/**
 * Строки истории от старых к новым. Нет поля (снапшот от старого main) или оно пустое — пустой список:
 * блок показывает только текущий статус. Неизвестный источник (новый main, старый renderer) — как есть.
 */
export function statusHistoryRows(
  history: readonly StatusChange[] | undefined,
  columns: readonly BoardColumn[],
  now: number
): StatusHistoryRow[] {
  if (!history) return []
  const byId = new Map(columns.map((c) => [c.id, c]))
  return history.map((h, i) => {
    const next = history[i + 1]
    const column = byId.get(h.status)
    return {
      index: i,
      status: h.status,
      title: column?.title ?? h.status,
      color: column?.color,
      at: h.at,
      source: STATUS_SOURCE_TITLES[h.by] ?? String(h.by),
      durationMs: Math.max(0, (next ? next.at : now) - h.at),
      current: next === undefined,
      migrated: h.migrated === true
    }
  })
}

/** Видимые строки: свёрнутый блок — последние `STATUS_HISTORY_COLLAPSED`, развёрнутый — все. */
export function visibleStatusRows(rows: readonly StatusHistoryRow[], expanded: boolean): StatusHistoryRow[] {
  return expanded || rows.length <= STATUS_HISTORY_COLLAPSED ? [...rows] : rows.slice(-STATUS_HISTORY_COLLAPSED)
}

/**
 * Подпись длительности: «2 ч 15 мин», у текущего — «сейчас · ⏱ 2 ч 15 мин». У стартовой записи миграции
 * момент входа неизвестен — длительность приблизительная, «≈».
 */
export function statusDurationLabel(row: Pick<StatusHistoryRow, 'durationMs' | 'current' | 'migrated'>): string {
  const value = `${row.migrated ? '≈ ' : ''}${formatDuration(row.durationMs)}`
  return row.current ? t('board.history.now', { value }) : value
}
