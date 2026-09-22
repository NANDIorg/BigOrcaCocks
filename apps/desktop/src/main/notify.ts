import type { OrcaEvent, Task } from '@orca-board/core'
import type { NotifyEvent, NotifyKind } from '../shared/notifications'

/** Роль, от имени которой уведомляет прогон (у run_done нет задачи). */
export const RUN_ROLE_ID = 'coordinator'

/**
 * Вид уведомления по событию стора; null — событие человека не касается (task_ready, ответ на вопрос,
 * принятый ответ — их делает сам человек или координатор).
 */
export function notifyKind(e: OrcaEvent): NotifyKind | null {
  switch (e.type) {
    case 'question': return 'question'
    case 'escalation': return 'escalation'
    case 'worker_done': return e.payload.answerFor === 'human' ? 'answerReady' : 'workerDone'
    case 'run_done': return 'runDone'
    default: return null
  }
}

export interface NotificationContent extends NotifyEvent {
  title: string
  body: string
}

/**
 * Заголовок и текст уведомления. `preview` — показывать текст события и название задачи;
 * без него — только вид события и проект (для чужих глаз на экране).
 */
export function describeEvent(e: OrcaEvent, task: Task | undefined, projectName: string, preview: boolean): NotificationContent | null {
  const kind = notifyKind(e)
  if (!kind) return null
  const roleId = task?.roleId ?? RUN_ROLE_ID
  const title = preview && task ? `${task.title} · ${projectName}` : projectName
  const detail = (key: string): string => (preview && e.payload[key] ? String(e.payload[key]) : '')
  const withDetail = (label: string, text: string): string => (text ? `${label}: ${text}` : label)
  let body: string
  switch (kind) {
    case 'question': body = withDetail('Вопрос', detail('question')); break
    case 'escalation': body = withDetail('Эскалация', detail('reason')); break
    case 'answerReady': body = withDetail('Ответ готов', detail('summary')); break
    case 'workerDone': body = withDetail('Готово к ревью', detail('summary')); break
    case 'runDone': body = withDetail('Прогон завершён', detail('objective')); break
  }
  return { kind, roleId, title, body: body.slice(0, 200) }
}
