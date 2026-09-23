const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Компактная длительность по-русски: «<1 мин», «5 мин», «2 ч 15 мин», «3 д 4 ч». Секунды не показываем. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < MIN) return '<1 мин'
  const days = Math.floor(ms / DAY)
  const hours = Math.floor((ms % DAY) / HOUR)
  const mins = Math.floor((ms % HOUR) / MIN)
  if (days > 0) return hours > 0 ? `${days} д ${hours} ч` : `${days} д`
  if (hours > 0) return mins > 0 ? `${hours} ч ${mins} мин` : `${hours} ч`
  return `${mins} мин`
}

/** Длительность подзадачи: от первого запуска воркера до done (не done — до now). Не запускалась — undefined. */
export function taskDuration(t: { startedAt?: number; doneAt?: number }, now: number): number | undefined {
  if (t.startedAt === undefined) return undefined
  return (t.doneAt ?? now) - t.startedAt
}

/** Длительность глобальной задачи: от создания до закрытия прогона (не закрыт — до now). */
export function globalTaskDuration(g: { createdAt: number; closedAt?: number }, now: number): number {
  return (g.closedAt ?? now) - g.createdAt
}
