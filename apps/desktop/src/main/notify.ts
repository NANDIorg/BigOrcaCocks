import type { OrcaEvent, Task } from '@orca-board/core'
import type { NotifyEvent, NotifyKind } from '../shared/notifications'
import { mt } from './i18n'

/** Роль, от имени которой уведомляет прогон (у run_done нет задачи). */
export const RUN_ROLE_ID = 'coordinator'

/**
 * Вид уведомления по событию стора; null — событие человека не касается (task_ready, ответ на вопрос,
 * принятый ответ — их делает сам человек или координатор).
 * Всё, что ждёт человека, приходит одним событием request_created (вопрос, сданный ответ, упавший воркер):
 * `question`, пока на него отвечает координатор, человека не дёргает, а escalation без запроса
 * (упал прошлый запуск, старт после «Уточнить») — дело координатора. Исключение — «нет вывода» (`stuck`).
 */
export function notifyKind(e: OrcaEvent): NotifyKind | null {
  switch (e.type) {
    case 'request_created':
      switch (e.payload.kind) {
        case 'question': return 'question'
        case 'answer': return 'answerReady'
        case 'escalation': return 'escalation'
        // Этап воркфлоу «человек» — то же «готово к ревью», только решает человек.
        case 'approval': return 'workerDone'
        // Агент не выбрал ветку «Решения ИИ» — выбирает человек, как отвечает на вопрос.
        case 'decision': return 'question'
        default: return null
      }
    case 'escalation': return e.payload.stuck === true ? 'escalation' : null
    // Проверка воркфлоу сдана — её исход уже у рабочей задачи, человеку тут делать нечего.
    case 'worker_done': return e.payload.answerFor === 'human' || e.payload.gateFor !== undefined ? null : 'workerDone'
    // Воркфлоу остановился (воркер или проверка не запустились, нет перехода) — без человека задача не пойдёт.
    case 'workflow_blocked': return 'escalation'
    case 'run_done': return 'runDone'
    default: return null
  }
}

export interface NotificationContent extends NotifyEvent {
  title: string
  body: string
  /** Уведомление о запросе к человеку: клик открывает Инбокс на нём. */
  requestId?: string
}

/**
 * Короткий «пинок» в терминал воркера, чей `orca-board ask` уже не ждёт: сам ответ воркер забирает
 * командой (многострочный текст в TUI не вписываем — он сплющивается и склеивается с вводом).
 */
export function answerNudge(questionId: string, requestId?: string): string {
  const cmd = requestId ? `orca-board request get --request ${requestId}` : `orca-board question get --question ${questionId}`
  return `[orca] на вопрос ${questionId} ответили: ${cmd}`
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
  const requestId = e.type === 'request_created' && typeof e.payload.requestId === 'string' ? e.payload.requestId : undefined
  // У request_created текст — в title (вопрос / summary ответа / причина эскалации).
  const text = (key: string): string => detail(requestId ? 'title' : key)
  let body: string
  switch (kind) {
    case 'question': body = withDetail(mt('notify.question'), text('question')); break
    case 'escalation': body = withDetail(mt(e.type === 'workflow_blocked' ? 'notify.workflowBlocked' : 'notify.escalation'), text('reason')); break
    case 'answerReady': body = withDetail(mt('notify.answerReady'), text('summary')); break
    case 'workerDone': body = requestId ? withDetail(mt('notify.awaitingDecision'), text('summary')) : withDetail(mt('notify.readyForReview'), detail('summary')); break
    // Автозакрытие ставит глобальную задачу на «Проверку» — человеку её принимать; ручной перенос сделал он сам.
    case 'runDone': body = withDetail(mt(e.payload.manual === true ? 'notify.runDone' : 'notify.runSubtasksDone'), detail('objective')); break
  }
  return { kind, roleId, title, body: body.slice(0, 200), ...(requestId ? { requestId } : {}) }
}
