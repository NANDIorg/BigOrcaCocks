import { activeDuration, globalOwnDuration, globalSubtasksDuration, taskActiveTime, type GlobalTask, type Task } from '@orca-board/core'
import { formatDuration } from './i18n/format'

/** Компактная длительность на языке интерфейса; реализация — в i18n/format.ts. */
export { formatDuration } from './i18n/format'

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

/**
 * Поля времени глобальной задачи, которые может прислать main. От старого main (до основного времени)
 * приходят только `activeMs`/`activeSince` — сумма подзадач под прежними именами.
 */
export type GlobalTimeFields = Partial<Pick<GlobalTask, 'ownActiveMs' | 'ownActiveSince' | 'subtasksActiveMs' | 'subtasksActiveSince' | 'closedAt'>> & {
  activeMs?: number
  activeSince?: number[]
}

/** Какое из двух времён глобальной задачи: основное (сама была в работе) или сумма подзадач. */
export type GlobalTimePart = 'own' | 'subtasks'

function subtasksTime(g: GlobalTimeFields): Pick<GlobalTask, 'subtasksActiveMs' | 'subtasksActiveSince'> {
  return { subtasksActiveMs: g.subtasksActiveMs ?? g.activeMs ?? 0, subtasksActiveSince: g.subtasksActiveSince ?? g.activeSince ?? [] }
}

/**
 * Длительность на момент now: основное — пока карточка в kind=in_progress (нет полей — неизвестно, undefined),
 * сумма подзадач — трудозатраты агентов, тикает идущими отрезками подзадач.
 */
export function globalTaskDuration(g: GlobalTimeFields, part: GlobalTimePart, now: number): number | undefined {
  return part === 'own' ? globalOwnDuration(g, now) : globalSubtasksDuration(subtasksTime(g), now)
}

/** Время сейчас тикает: основное — открыт отрезок глобальной, сумма — хоть одна подзадача в работе. */
export function globalTaskTicking(g: GlobalTimeFields, part: GlobalTimePart): boolean {
  return part === 'own' ? g.ownActiveSince !== undefined : subtasksTime(g).subtasksActiveSince.length > 0
}

/**
 * Какие времена показывать. chip — карточка глобального канбана: только своё время в работе, а если оно
 * неизвестно (старый main, прогон от кода до этих полей) — сумма подзадач, как раньше, чтобы карточка не пустела.
 * line — внутри глобальной задачи (шапка экрана подзадач, модалка): оба; неизвестное своё отсеет `globalTimeLabel`.
 */
export function globalTimeParts(g: GlobalTimeFields, variant: 'chip' | 'line'): GlobalTimePart[] {
  if (variant === 'line') return ['own', 'subtasks']
  return globalTaskDuration(g, 'own', 0) !== undefined ? ['own'] : ['subtasks']
}

/**
 * Подпись одного из времён: chip — на карточке («⏱ 1 ч», «⏸ 1 ч», у закрытой «за 1 ч»; сумма — «Σ ⏱ 3 ч»),
 * line — внутри задачи («В работе: ⏱ 1 ч», «Сумма подзадач: ⏸ 3 ч»). Основное неизвестно — undefined.
 */
export function globalTimeLabel(g: GlobalTimeFields, part: GlobalTimePart, now: number, variant: 'chip' | 'line'): string | undefined {
  const ms = globalTaskDuration(g, part, now)
  if (ms === undefined) return undefined
  const ticking = globalTaskTicking(g, part)
  const value = `${ticking ? '⏱' : g.closedAt !== undefined ? '' : '⏸'} ${formatDuration(ms)}`.trim()
  if (part === 'own') return variant === 'line' ? `В работе: ${value}` : g.closedAt !== undefined && !ticking ? `за ${value}` : value
  return variant === 'line' ? `Сумма подзадач: ${value}` : `Σ ${value}`
}

/** Всплывающая подсказка к времени: что считается и идёт ли оно сейчас. */
export function globalTimeTitle(g: GlobalTimeFields, part: GlobalTimePart): string {
  const ticking = globalTaskTicking(g, part)
  if (part === 'own') {
    return `Время, пока сама глобальная задача в работе; ${ticking ? 'идёт' : 'стоит: не «В работе» (бэклог, «Нужен ответ», сделано)'}`
  }
  return `Сумма времени работы подзадач (параллельные складываются); ${ticking ? 'идёт, пока хоть одна в работе' : 'сейчас ни одна не в работе'}`
}
