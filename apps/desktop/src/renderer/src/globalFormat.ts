import { t } from './i18n'
import { formatDateTime } from './i18n/format'

/**
 * Подписи глобальной доски, которые берут и другие экраны (лента «Ждут вас» — `relativeTime`). Вынесены из
 * `GlobalBoard.tsx`, чтобы тестировать без React; компоненты перерисовываются при смене языка (`Root` в `main.tsx`).
 */

/** «только что», «5 мин назад», «3 ч назад», иначе дата и время. */
export function relativeTime(ts: number, now = Date.now()): string {
  const min = Math.floor((now - ts) / 60000)
  if (min < 1) return t('global.time.justNow')
  if (min < 60) return t('global.time.minAgo', { n: min })
  const h = Math.floor(min / 60)
  if (h < 24) return t('global.time.hourAgo', { n: h })
  return formatDateTime(ts, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** «1 подзадача», «3 подзадачи», «5 подзадач» / «1 subtask», «3 subtasks». */
export function subtasksLabel(n: number): string {
  return t('global.progress.subtasks', { count: n })
}

/** Полная дата и время для подсказки (`title`): «25.09.2026, 14:05:33». */
export function fullStamp(ts: number): string {
  return formatDateTime(ts, { dateStyle: 'short', timeStyle: 'medium' })
}

/** Кусок шаблона: обычный текст или место под элемент (`{name}`). */
export type RichPart = { text: string } | { slot: string }

/**
 * Разбить переведённую строку на текст и места под JSX-элементы: «В работе в среднем {time}» → текст и слот `time`,
 * куда компонент ставит `<b>`. Порядок слов в языках разный, поэтому элементы не склеиваются из кусков фраз.
 */
export function richParts(template: string): RichPart[] {
  const out: RichPart[] = []
  const re = /\{(\w+)\}/g
  let last = 0
  for (let m = re.exec(template); m; m = re.exec(template)) {
    if (m.index > last) out.push({ text: template.slice(last, m.index) })
    out.push({ slot: m[1] })
    last = m.index + m[0].length
  }
  if (last < template.length) out.push({ text: template.slice(last) })
  return out
}
