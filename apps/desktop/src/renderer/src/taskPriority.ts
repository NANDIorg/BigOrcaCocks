import { PRIORITY_TITLES, isTaskPriority, type TaskPriority } from '@orca-board/core'

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
  return priority === 'normal' ? null : { priority, title: PRIORITY_TITLES[priority] }
}

/** Приоритет можно править, только если main его знает: у задач от старого main поля нет. */
export function priorityEditable(t: { priority?: unknown }): boolean {
  return isTaskPriority(t.priority)
}
