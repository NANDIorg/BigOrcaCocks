/**
 * Время работы задачи: копится только пока задача в колонке kind=in_progress (docs/architecture.md,
 * «Время работы»). Чистые функции без Node — их используют store, `toGlobalTask` и renderer.
 */
import type { Task } from './types'

/** Время работы задачи: закрытые отрезки и начало текущего (есть — задача сейчас в работе, время тикает). */
export interface ActiveTime {
  /** Сумма закрытых отрезков работы, мс. */
  closedMs: number
  /** Начало текущего отрезка; нет — задача стоит, время не растёт. */
  since?: number
}

type ActiveFields = Pick<Task, 'activeMs' | 'activeSince' | 'startedAt' | 'doneAt'>

/**
 * Время работы задачи; не бывала в работе — undefined. Задача без `activeMs`/`activeSince` пришла от
 * старого main (renderer обновляется по HMR раньше main) — тогда прежний расчёт: от первого запуска
 * до done, не done — тикает.
 */
export function taskActiveTime(t: ActiveFields): ActiveTime | undefined {
  if (t.activeMs !== undefined || t.activeSince !== undefined) {
    return { closedMs: t.activeMs ?? 0, ...(t.activeSince !== undefined ? { since: t.activeSince } : {}) }
  }
  if (t.startedAt === undefined) return undefined
  return t.doneAt !== undefined ? { closedMs: t.doneAt - t.startedAt } : { closedMs: 0, since: t.startedAt }
}

/** Длительность на момент now: закрытые отрезки плюс текущий. */
export function activeDuration(a: ActiveTime, now: number): number {
  return a.closedMs + (a.since !== undefined ? Math.max(0, now - a.since) : 0)
}

/**
 * Переход статуса для учёта времени: вошла в in_progress — открыть отрезок, вышла — закрыть и прибавить.
 * Мутирует задачу; вызывается из единственного места смены статуса (`TaskStore.setStatus`).
 */
export function trackActiveTime(t: Pick<Task, 'activeMs' | 'activeSince'>, inProgress: boolean, now: number): void {
  if (inProgress) {
    t.activeMs ??= 0
    t.activeSince ??= now
  } else if (t.activeSince !== undefined) {
    t.activeMs = (t.activeMs ?? 0) + Math.max(0, now - t.activeSince)
    t.activeSince = undefined
  }
}
