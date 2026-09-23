import { activeDuration, globalActiveDuration, taskActiveTime, type GlobalTask, type Task } from '@orca-board/core'

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

/**
 * Время работы подзадачи: копится только в kind=in_progress (`Task.activeMs` + текущий отрезок до now).
 * Не бывала в работе — undefined. Задача от старого main — прежний расчёт от первого запуска (`taskActiveTime`).
 */
export function taskDuration(t: Pick<Task, 'activeMs' | 'activeSince' | 'startedAt' | 'doneAt'>, now: number): number | undefined {
  const a = taskActiveTime(t)
  return a && activeDuration(a, now)
}

/** Время сейчас тикает: задача в работе (открыт отрезок). */
export function taskTicking(t: Pick<Task, 'activeMs' | 'activeSince' | 'startedAt' | 'doneAt'>): boolean {
  return taskActiveTime(t)?.since !== undefined
}

/** Время работы глобальной задачи: сумма времени её подзадач; тикает, пока хоть одна в работе. */
export function globalTaskDuration(g: Pick<GlobalTask, 'activeMs' | 'activeSince'>, now: number): number {
  return globalActiveDuration(g, now)
}
