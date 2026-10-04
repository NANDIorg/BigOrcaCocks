import type { Dispatch, HumanRequest } from '@orca-board/core'
import { t } from './i18n'
import { formatDateTime } from './i18n/format'

// Тексты модалки задачи (TaskModal.tsx), которые считаются из данных: исход запуска, итог запроса, дата.
// Без React — чтобы тестировать на обоих языках.

/** Дата и время в модалке: «25.09.2026, 14:05» / «09/25/2026, 2:05 PM». */
export function formatTaskDate(ts: number): string {
  return formatDateTime(ts, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Подпись исхода dispatch'а. Без outcome: ещё работает, если не завершён, иначе неизвестно. */
export function outcomeLabel(d: Pick<Dispatch, 'outcome' | 'endedAt'>): { text: string; cls: string } {
  switch (d.outcome) {
    case 'done':
      return { text: t('board.outcome.done'), cls: 'ok' }
    case 'failed':
      return { text: t('board.outcome.failed'), cls: 'warn' }
    case 'unknown':
      return { text: t('board.outcome.unknown'), cls: 'warn' }
    default:
      return d.endedAt ? { text: t('board.outcome.none'), cls: '' } : { text: t('board.outcome.running'), cls: 'live' }
  }
}

/** Подпись задачи-ответа: кто читает ответ. */
export function answerForTitle(answerFor: 'human' | 'coordinator'): string {
  return answerFor === 'human' ? t('board.task.answerForHuman') : t('board.task.answerForCoordinator')
}

/** Чем закончился запрос: выбранный вариант / текст ответа, «принят» с решением, уточнение, отмена. */
export function resolutionText(r: Pick<HumanRequest, 'status' | 'resolution' | 'options'>): string {
  if (r.status === 'cancelled') return t('board.resolution.cancelled')
  const res = r.resolution
  if (!res) return t('board.resolution.resolved')
  switch (res.action) {
    case 'answer': {
      const option = res.optionId ? r.options.find((o) => o.id === res.optionId)?.label ?? res.optionId : undefined
      return [option, res.text].filter(Boolean).join(' — ') || t('board.resolution.answered')
    }
    case 'accept':
      return res.text ? t('board.resolution.acceptedWith', { text: res.text }) : t('board.resolution.accepted')
    case 'clarify':
      return t('board.resolution.clarify', { text: res.text ?? '' })
    case 'restart':
      return t('board.resolution.restart')
    case 'dismiss':
      return t('board.resolution.dismiss')
    case 'reject':
      return res.text ? t('board.resolution.rejectedWith', { text: res.text }) : t('board.resolution.rejected')
  }
}
