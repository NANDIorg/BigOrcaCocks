import { isTaskPriority, type TaskPriority } from '@orca-board/core'
import { t, translate } from './i18n'

/**
 * Название приоритета на языке интерфейса. `PRIORITY_TITLES` из core — только русские, для CLI и промптов;
 * в renderer — эта функция.
 */
export function priorityTitle(priority: TaskPriority): string {
  return t(`board.priority.${priority}`)
}

/**
 * Приоритет задачи для показа. У задачи от старого main поля нет — считаем normal
 * (новый main проставляет его всем задачам миграцией при загрузке).
 */
export function taskPriorityOf(t: { priority?: unknown }): TaskPriority {
  return isTaskPriority(t.priority) ? t.priority : 'normal'
}

/** Бейдж карточки: normal не показываем, чтобы не шуметь. */
export function priorityBadge(t: { priority?: unknown }): { priority: TaskPriority; title: string } | null {
  const priority = taskPriorityOf(t)
  return priority === 'normal' ? null : { priority, title: priorityTitle(priority) }
}

/** Приоритет можно править, только если main его знает: у задач от старого main поля нет. */
export function priorityEditable(t: { priority?: unknown }): boolean {
  return isTaskPriority(t.priority)
}

/**
 * @deprecated Только русский текст — для ещё не переведённых модулей (GlobalTaskModal). Свои — `stalePriorityMessage()`.
 */
export const STALE_PRIORITY_MESSAGE = translate('ru', 'board.priority.stale')

/** Подсказка у приоритета, когда main старее приоритетов. */
export function stalePriorityMessage(): string {
  return t('board.priority.stale')
}

/**
 * Знает ли main приоритет глобальных задач. Новый main проставляет `Run.priority` всем прогонам (миграция),
 * старый — никому; по нему и судим. Прогонов нет — считаем, что знает: старый main просто создаст normal.
 */
export function runsKnowPriority(runs: readonly { priority?: unknown }[]): boolean {
  return runs.length === 0 || runs.some(priorityEditable)
}

/**
 * Короткая метка приоритета перед заголовком карточки локальной доски: «!!», «выс», «низ». Полное название —
 * в подсказке и `aria-label`. normal и старые без поля — без метки.
 */
export function priorityMark(task: { priority?: unknown }): { priority: TaskPriority; mark: string; title: string } | null {
  const badge = priorityBadge(task)
  if (!badge) return null
  const mark = badge.priority === 'urgent' ? '!!' : t(`board.priority.mark.${badge.priority}`)
  return { ...badge, mark }
}
