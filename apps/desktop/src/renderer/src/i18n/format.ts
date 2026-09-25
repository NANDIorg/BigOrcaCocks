import { getLocale, t } from './index'
import type { Locale } from './types'

/**
 * Форматирование чисел, дат и длительностей по текущему языку (`Intl`). Модули логики (`duration.ts`,
 * `statsFormat.ts`) зовут эти функции, а не `toLocaleString('ru-RU')`, чтобы формат менялся вместе с языком.
 */

/** Тег `Intl` для языка интерфейса. */
export function intlLocale(locale: Locale = getLocale()): string {
  return locale === 'en' ? 'en-US' : 'ru-RU'
}

/** Целое с разделителями разрядов: «1 234» / «1,234». */
export function formatInteger(n: number): string {
  return Math.round(n).toLocaleString(intlLocale(), { maximumFractionDigits: 0 })
}

/** Ровно `digits` знаков после запятой, без разделителей разрядов: «12,40» / «12.40». */
export function formatFixed(n: number, digits: number): string {
  return n.toLocaleString(intlLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false })
}

/** До `digits` знаков, лишние нули отбрасываются: «1,5» / «1.5», «2». */
export function formatShort(n: number, digits = 2): string {
  return n.toLocaleString(intlLocale(), { maximumFractionDigits: digits, useGrouping: false })
}

/** Процент из числа 0–100 («42 %» / «42%»); вне диапазона обрезается. */
export function formatPercent(percent: number): string {
  const fraction = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0)) / 100
  return new Intl.NumberFormat(intlLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(fraction)
}

/** Дата и/или время по текущему языку; по умолчанию — «25.09.2026, 14:05» / «9/25/2026, 2:05 PM». */
export function formatDateTime(ts: number | Date, opts: Intl.DateTimeFormatOptions = { dateStyle: 'short', timeStyle: 'short' }): string {
  return new Intl.DateTimeFormat(intlLocale(), opts).format(ts)
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Компактная длительность: «<1 мин», «5 мин», «2 ч 15 мин», «3 д 4 ч» / «<1 min», «2 h 15 min», «3 d 4 h». */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < MIN) return t('common.unit.lessThanMinute')
  const days = Math.floor(ms / DAY)
  const hours = Math.floor((ms % DAY) / HOUR)
  const mins = Math.floor((ms % HOUR) / MIN)
  if (days > 0) return joinUnits(t('common.unit.day', { n: days }), hours > 0 ? t('common.unit.hour', { n: hours }) : '')
  if (hours > 0) return joinUnits(t('common.unit.hour', { n: hours }), mins > 0 ? t('common.unit.min', { n: mins }) : '')
  return t('common.unit.min', { n: mins })
}

/** «3 ч» + «12 мин» → «3 ч 12 мин»; пустая часть отбрасывается. */
export function joinUnits(...parts: string[]): string {
  return parts.filter(Boolean).join(' ')
}
