import type { BoardColumn, ColumnKind, Task } from '@orca-board/core'

/**
 * Колонка локальной доски в том виде, как её показываем: сама колонка проекта (заголовок, цвет, куда ставить
 * брошенную карточку) и статусы (id колонок), чьи карточки в ней лежат.
 */
export interface DisplayColumn {
  column: BoardColumn
  statuses: string[]
}

/**
 * Колонки локальной доски подзадач: «Готовы» (kind ready) не показывается отдельно, её карточки лежат в «Бэклоге»
 * (kind backlog). Статус ready в модели остаётся — это только вид: для человека «ещё не начата» одна стопка,
 * а готовые к запуску поднимаются в ней наверх (`compareInColumn`). Бэклога нет — ready показываем как есть,
 * чтобы карточки не пропали.
 */
export function localBoardColumns(columns: BoardColumn[]): DisplayColumn[] {
  const backlog = columns.find((c) => c.kind === 'backlog')
  if (!backlog) return columns.map((c) => ({ column: c, statuses: [c.id] }))
  const ready = columns.filter((c) => c.kind === 'ready').map((c) => c.id)
  return columns
    .filter((c) => c.kind !== 'ready')
    .map((c) => ({ column: c, statuses: c === backlog ? [c.id, ...ready] : [c.id] }))
}

/**
 * Куда перевести карточку со статусом `status`, брошенную в колонку `target`; undefined — никуда.
 * Внутри объединённой колонки статус не трогаем: ready ↔ backlog решает core по зависимостям.
 * Из других колонок — в саму колонку (для объединённой — backlog; `promoteReady` в core сам поднимет в ready).
 */
export function dropStatus(target: DisplayColumn, status: string): string | undefined {
  return target.statuses.includes(status) ? undefined : target.column.id
}

/** Порядок внутри объединённой колонки: готовые к запуску выше ждущих; остальные виды — вровень. */
const KIND_RANK: Partial<Record<ColumnKind, number>> = { ready: 0, backlog: 1 }

/** Сначала готовые (ready) над ждущими (backlog), дальше — обычная сортировка доски `compare`. */
export function compareInColumn(
  kindOf: (status: string) => ColumnKind | undefined,
  compare: (a: Task, b: Task) => number
): (a: Task, b: Task) => number {
  const rank = (t: Task): number => KIND_RANK[kindOf(t.status) ?? 'custom'] ?? 0
  return (a, b) => rank(a) - rank(b) || compare(a, b)
}

/**
 * Сколько зависимостей задачи ещё не закрыто (не в колонке kind done). Неизвестная зависимость — не закрыта:
 * так же считает `promoteReady` в core, и задача из-за неё в ready не поднимется.
 */
export function pendingDeps(
  task: Pick<Task, 'deps'>,
  statusOf: (id: string) => string | undefined,
  kindOf: (status: string) => ColumnKind | undefined
): number {
  return task.deps.filter((d) => {
    const status = statusOf(d)
    return status === undefined || kindOf(status) !== 'done'
  }).length
}
