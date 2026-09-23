import type React from 'react'
import { PRIORITY_TITLES, TASK_PRIORITIES } from '@orca-board/core'
import { priorityBadge } from './taskPriority'

/** Бейдж приоритета для карточек обычных и глобальных задач; normal и старые без поля — без бейджа. */
export function PriorityBadge({ item, className = 'chip' }: { item: { priority?: unknown }; className?: string }): React.JSX.Element | null {
  const badge = priorityBadge(item)
  if (!badge) return null
  return (
    <span className={`${className} priority ${badge.priority}`} title={`Приоритет: ${badge.title}`}>
      {badge.title}
    </span>
  )
}

/** Варианты приоритета для `<select>` — от высшего к низшему, как в TASK_PRIORITIES. */
export function PriorityOptions(): React.JSX.Element {
  return (
    <>
      {TASK_PRIORITIES.map((p) => (
        <option key={p} value={p}>{PRIORITY_TITLES[p]}</option>
      ))}
    </>
  )
}
