import type { BoardColumn, ProjectStats, StatsDay, StatsRange, StatsRow, StatsUsage, TokenUsage } from '@orca-board/core'
import type { OrcaApi } from '../../shared/ipc'
import { LOCALES, t, translate } from './i18n'
import { formatDateTime, formatFixed, formatInteger, formatShort, joinUnits } from './i18n/format'

/**
 * Логика вкладки «Статистика» (вариант B, docs/architecture.md → «Статистика → Интерфейс»): форматирование чисел
 * и агрегации для графика. Вынесена из `StatsView.tsx`, чтобы тестировать без React.
 */

/** Как `STALE_APP_MESSAGE` в docLinks.ts, но про статистику: renderer пришёл по HMR, а main/preload старые. */
export function statsStaleMessage(): string {
  return t('global.stats.stale')
}

/**
 * Русский текст той же ошибки — для `isStatsStale` в `taskStatsFormat.ts`, который сверяет сообщение с константой.
 * Показывать — `statsStaleMessage()`: она на языке интерфейса.
 */
export const STATS_STALE_MESSAGE = translate('ru', 'global.stats.stale')

/** `window.orca.stats` или понятная ошибка вместо «Cannot read properties of undefined». */
export function statsApi(api: Partial<OrcaApi> | undefined): OrcaApi['stats'] {
  if (!api?.stats) throw new Error(statsStaleMessage())
  return api.stats
}

/**
 * main/preload старые: preload новый, а main старый — invoke падает с «No handler registered for 'stats:…'»;
 * нет `window.orca.stats` — наша же ошибка `statsStaleMessage()` на любом языке (язык могли сменить после запроса).
 */
export function isStaleStatsError(message: string): boolean {
  return /No handler registered for 'stats:/.test(message) || LOCALES.some((l) => message === translate(l, 'global.stats.stale'))
}

/** Порядок кнопок периода — как в макете: от короткого к длинному. */
export const RANGE_OPTIONS: readonly StatsRange[] = ['7d', '30d', 'all']

/** Подпись кнопки периода: «7 дней», «Всё время». */
export function rangeLabel(range: StatsRange): string {
  return t(`global.stats.range.${range}`)
}

/** Период внутри фразы: «Потрачено за …», «За … агенты не запускались». */
export function rangePhrase(range: StatsRange): string {
  return t(`global.stats.phrase.${range}`)
}

/** Дробная часть — по языку интерфейса: «1,2» / «1.2». */
const fixed = formatFixed

/** Токены: «950», «12 тыс», «1,2 млн», «2,15 млрд». Отрицательное и NaN — «0». */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1e9) return t('common.unit.billion', { n: fixed(n / 1e9, 2) })
  // 999 950 округлилось бы до «1000 тыс» — сразу в миллионы.
  if (n >= 999_500) return t('common.unit.million', { n: fixed(n / 1e6, 1) })
  if (n >= 1000) return t('common.unit.thousand', { n: Math.round(n / 1000) })
  return String(Math.round(n))
}

/** Деньги: от $100 — целые с разрядами («$1 234»), меньше — с центами («$12,40»), копейки — «<$0,01». */
export function formatUsd(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '$0'
  if (v < 0.01) return `<$${fixed(0.01, 2)}`
  if (v >= 100) return `$${formatInteger(v)}`
  return `$${fixed(v, 2)}`
}

const MIN = 60_000
const HOUR = 60 * MIN

/**
 * Время агентов: сумма сессий, поэтому в часах, а не в днях (`formatDuration` дал бы «6 д», хотя это 144 часа
 * работы). «<1 мин», «45 мин», «3 ч 12 мин», от 100 ч — только часы.
 */
export function formatAgentTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < MIN) return t('common.unit.lessThanMinute')
  const h = Math.floor(ms / HOUR)
  const m = Math.floor((ms % HOUR) / MIN)
  const hours = t('common.unit.hour', { n: h })
  if (h >= 100) return hours
  if (h > 0) return joinUnits(hours, m > 0 ? t('common.unit.min', { n: m }) : '')
  return t('common.unit.min', { n: m })
}

/** Все виды токенов вместе; нет данных — undefined («неизвестно», не 0). */
export function totalTokens(t: TokenUsage | undefined): number | undefined {
  return t && t.input + t.output + t.cacheRead + t.cacheWrite
}

/** Разбивка токенов для подписи под итогом: «вход 2,1 млн · ответ 5,8 млн · кэш: чтение 219 млн, запись 17 млн». */
export function tokenBreakdown(u: TokenUsage): string {
  return t('global.stats.breakdown', {
    input: formatTokens(u.input), output: formatTokens(u.output), read: formatTokens(u.cacheRead), write: formatTokens(u.cacheWrite)
  })
}

/** Есть ли в периоде хоть одна сессия с токенами. Нет — метрики «Стоимость» и «Токены» скрыты (docs). */
export function hasUsage(s: ProjectStats): boolean {
  return s.totals.tokens !== undefined
}

/** Сессии без данных о токенах: «нет данных по N сессиям». */
export function missingSessions(u: StatsUsage): number {
  return Math.max(0, u.sessions - u.sessionsWithUsage)
}

/** Пусто: за период агенты не запускались и с задачами ничего не происходило — вместо дашборда заглушка. */
export function isEmptyStats(s: ProjectStats): boolean {
  return s.totals.sessions === 0 && s.tasks.created === 0 && s.tasks.done === 0 && s.byDay.length === 0
}

/** Стоимость среза для ячейки: сумма, «не менее» (часть токенов без цены), «без цены» или «нет данных». */
export type CostCell =
  | { kind: 'cost'; text: string; atLeast: boolean }
  | { kind: 'unpriced' }
  | { kind: 'unknown' }

export function costCell(u: StatsUsage): CostCell {
  if (u.costUsd !== undefined) return { kind: 'cost', text: formatUsd(u.costUsd), atLeast: u.unpricedTokens > 0 }
  if (u.tokens !== undefined && u.unpricedTokens > 0) return { kind: 'unpriced' }
  return { kind: 'unknown' }
}

/** Цена задачи = стоимость / задач завершено; нет стоимости или ни одной завершённой — неизвестно. */
export function taskCost(s: ProjectStats): number | undefined {
  if (s.totals.costUsd === undefined || s.tasks.done <= 0) return undefined
  return s.totals.costUsd / s.tasks.done
}

/** «5 сессий», «1 сессия» — для подписей. */
export function sessionsLabel(n: number): string {
  return t('global.stats.sessions', { count: n })
}

/** «нет данных по 3 сессиям», «по 1 сессии». */
export function missingLabel(n: number): string {
  return t('global.stats.missing', { count: n })
}

// ---------- цвета серий ----------

/** Серий с собственным цветом (`--s1`…`--s5`), остальные — серые «прочие». */
export const SERIES_COUNT = 5

/**
 * Цвет строки разбивки по её месту в `ProjectStats.byModel` / `byRole` (main уже отсортировал по расходу):
 * так цвет модели на графике совпадает с блоком «Модели». Модель `unknown` и строки за пятой — серые.
 */
export function seriesColor(rows: Pick<StatsRow, 'key'>[], key: string): string {
  if (key === 'unknown') return 'var(--s-unknown)'
  const i = rows.findIndex((r) => r.key === key)
  return i >= 0 && i < SERIES_COUNT ? `var(--s${i + 1})` : 'var(--s-other)'
}

/** Строка блока долей («Модели», «Роли»): значение и доля от самой большой строки, 0..1. */
export interface ShareItem {
  row: StatsRow
  share: number
}

/**
 * Первые `limit` строк с долей: по стоимости, а без токенов в периоде — по времени агентов (docs).
 * Строки уже отсортированы main — порядок не меняем.
 */
export function shareItems(rows: StatsRow[], byCost: boolean, limit = SERIES_COUNT): ShareItem[] {
  const top = rows.slice(0, limit)
  const value = (r: StatsRow): number => (byCost ? r.costUsd ?? 0 : r.agentMs)
  const max = Math.max(0, ...top.map(value))
  return top.map((row) => ({ row, share: max > 0 ? value(row) / max : 0 }))
}

// ---------- задачи по колонкам ----------

export interface StatusPart {
  id: string
  title: string
  color: string
  count: number
}

/**
 * Полоса «Задачи на доске»: колонки в порядке доски, затем статусы, которых на доске уже нет (колонку удалили) —
 * одной серой частью «Другие». Пустые колонки остаются в легенде с нулём, чтобы она не прыгала.
 */
export function statusParts(byStatus: Record<string, number>, columns: Pick<BoardColumn, 'id' | 'title' | 'color'>[]): StatusPart[] {
  const known = new Set(columns.map((c) => c.id))
  const parts = columns.map((c) => ({ id: c.id, title: c.title, color: c.color, count: byStatus[c.id] ?? 0 }))
  const other = Object.entries(byStatus).reduce((sum, [id, n]) => (known.has(id) ? sum : sum + n), 0)
  if (other > 0) parts.push({ id: '', title: t('global.stats.other'), color: 'var(--s-other)', count: other })
  return parts
}

// ---------- график по дням ----------

export type ChartMetric = 'cost' | 'tokens' | 'time' | 'done'

export const CHART_METRICS: readonly ChartMetric[] = ['cost', 'tokens', 'time', 'done']

/** Подпись метрики: вкладка над графиком, подсказка столбца. */
export function metricLabel(metric: ChartMetric): string {
  return t(`global.stats.metric.${metric}`)
}

/** Метрики графика для периода: без токенов «Стоимость» и «Токены» скрыты. */
export function chartMetrics(usage: boolean): ChartMetric[] {
  return CHART_METRICS.filter((m) => usage || (m !== 'cost' && m !== 'tokens'))
}

/** Выбранная метрика, если она доступна, иначе первая доступная (без токенов «Стоимость» → «Время агентов»). */
export function effectiveMetric(metric: ChartMetric, usage: boolean): ChartMetric {
  const list = chartMetrics(usage)
  return list.includes(metric) ? metric : list[0]
}

/** Шаг столбца: день; у «всего времени» длинной истории — неделя или месяц, чтобы столбцы не стали нитками. */
export type Bucket = 'day' | 'week' | 'month'

export interface ChartSegment {
  /** Ключ модели (`ProjectStats.byModel`) — для цвета; у одиночной серии — ''. */
  key: string
  value: number
}

export interface ChartColumn {
  /** `YYYY-MM-DD` первого дня столбца. */
  date: string
  /** Подпись оси: «24.09», у месяца — «09.26». */
  label: string
  /** Подпись подсказки: «24.09», «21.09–27.09», «сентябрь 2026». */
  title: string
  /** Была ли активность (запись в `byDay`). Нет — пустой столбец, а не ноль. */
  active: boolean
  total: number
  segments: ChartSegment[]
  /** Дни столбца из `byDay` — для подсказки. */
  days: StatsDay[]
}

export interface Chart {
  bucket: Bucket
  columns: ChartColumn[]
  /** Верх шкалы (кратен `step`) и шаг сетки. */
  top: number
  step: number
}

const DAY_MS = 24 * HOUR
/** Дольше — столбцы по неделям, ещё дольше — по месяцам. */
const DAILY_MAX = 62
const WEEKLY_MAX = 7 * 60

/** Локальная дата `YYYY-MM-DD` — как у main (`byDay` — по локальной дате main, а renderer на той же машине). */
export function localDateKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** `YYYY-MM-DD` → локальная полночь. Сдвиг дат — через `new Date(y, m, d + i)`, чтобы переход на летнее время не терял день. */
function parseDate(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function addDays(key: string, n: number): string {
  const d = parseDate(key)
  return localDateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime())
}

/** Понедельник недели дня. */
function weekStart(key: string): string {
  const wd = (parseDate(key).getDay() + 6) % 7
  return addDays(key, -wd)
}

/** Месяц столбца: «сентябрь 2026» / «September 2026». Месяц отдельно от года — у `Intl` в ru это именительный падеж. */
function monthTitle(key: string): string {
  return `${formatDateTime(parseDate(key), { month: 'long' })} ${key.slice(0, 4)}`
}

const dm = (key: string): string => `${key.slice(8)}.${key.slice(5, 7)}`

/** Значение дня по метрике; стоимость — сумма сегментов по моделям (как столбец стопкой). */
export function dayValue(d: StatsDay, metric: ChartMetric): number {
  if (metric === 'cost') return d.byModel.reduce((s, m) => s + (m.costUsd ?? 0), 0)
  if (metric === 'tokens') return totalTokens(d.tokens) ?? 0
  if (metric === 'time') return d.agentMs
  return d.tasksDone
}

function daySegments(d: StatsDay, metric: ChartMetric): ChartSegment[] {
  if (metric === 'cost') return d.byModel.filter((m) => (m.costUsd ?? 0) > 0).map((m) => ({ key: m.key, value: m.costUsd ?? 0 }))
  const v = dayValue(d, metric)
  return v > 0 ? [{ key: '', value: v }] : []
}

/** Сегменты одного ключа складываются; порядок — первого появления (он же порядок `byModel`). */
function mergeSegments(list: ChartSegment[]): ChartSegment[] {
  const out: ChartSegment[] = []
  for (const s of list) {
    const same = out.find((o) => o.key === s.key)
    if (same) same.value += s.value
    else out.push({ ...s })
  }
  return out
}

/** «Круглый» шаг сетки: 1, 2, 2.5, 5 × 10ⁿ — не меньше `raw`. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  const f = raw / p
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p
}

/**
 * Столбцы графика за период. 7 / 30 дней — ровно столько дней до даты `generatedAt`; всё время — от первого дня
 * с активностью, длинная история — по неделям или месяцам. Дни без записи в `byDay` — пустые столбцы.
 */
export function buildChart(s: Pick<ProjectStats, 'range' | 'generatedAt' | 'byDay'>, metric: ChartMetric): Chart {
  const last = localDateKey(s.generatedAt)
  const first =
    s.range === '7d' ? addDays(last, -6)
      : s.range === '30d' ? addDays(last, -29)
        : s.byDay.length > 0 && s.byDay[0].date < last ? s.byDay[0].date : last
  const span = Math.round((parseDate(last).getTime() - parseDate(first).getTime()) / DAY_MS) + 1
  const bucket: Bucket = s.range !== 'all' || span <= DAILY_MAX ? 'day' : span <= WEEKLY_MAX ? 'week' : 'month'
  const keyOf = (date: string): string => (bucket === 'day' ? date : bucket === 'week' ? weekStart(date) : `${date.slice(0, 7)}-01`)

  const columns: ChartColumn[] = []
  const byKey = new Map<string, ChartColumn>()
  for (let date = first; date <= last; date = addDays(date, 1)) {
    const key = keyOf(date)
    if (byKey.has(key)) continue
    const col: ChartColumn = {
      date: key,
      label: bucket === 'month' ? `${key.slice(5, 7)}.${key.slice(2, 4)}` : dm(key),
      title: bucket === 'day' ? dm(key)
        : bucket === 'week' ? `${dm(key)}–${dm(addDays(key, 6))}`
          : monthTitle(key),
      active: false,
      total: 0,
      segments: [],
      days: []
    }
    byKey.set(key, col)
    columns.push(col)
  }
  for (const d of s.byDay) {
    if (d.date < first || d.date > last) continue
    const col = byKey.get(keyOf(d.date))
    if (!col) continue
    col.active = true
    col.days.push(d)
    col.segments = mergeSegments([...col.segments, ...daySegments(d, metric)])
    col.total += dayValue(d, metric)
  }
  const max = Math.max(0, ...columns.map((c) => c.total))
  // Время — шагом в круглых часах или минутах, а не в «круглых» миллисекундах (33,3 мин).
  const unit = metric === 'time' ? (max >= HOUR ? HOUR : MIN) : 1
  const step = niceStep(max / 4 / unit) * unit
  const top = max > 0 ? Math.ceil(max / step - 1e-9) * step : step * 4
  return { bucket, columns, top, step }
}

/** Индексы столбцов с подписью оси: не больше ~8 подписей, последний столбец подписан всегда. */
export function axisLabelIndexes(count: number, maxLabels = 8): number[] {
  if (count <= 0) return []
  const every = Math.max(1, Math.ceil(count / maxLabels))
  const out: number[] = []
  for (let i = count - 1; i >= 0; i -= every) out.unshift(i)
  return out
}

/**
 * Сколько подписей дат влезет под графиком шириной `plotWidth` px: подпись «24.09» — около 40px, между ними
 * нужен зазор. Не больше 7 для недели и 8 для длинных периодов — иначе ось рябит даже на широком окне.
 */
export function axisLabelBudget(count: number, plotWidth: number): number {
  const cap = count <= 7 ? 7 : 8
  return Math.max(2, Math.min(cap, Math.floor(plotWidth / 56)))
}

/** Подпись значения по метрике — для оси и подсказки. */
export function formatMetric(v: number, metric: ChartMetric): string {
  if (metric === 'cost') return formatUsd(v)
  if (metric === 'tokens') return formatTokens(v)
  if (metric === 'time') return formatAgentTime(v)
  return String(Math.round(v))
}

/** Подпись деления оси: коротко, без «<1 мин» у нуля. */
export function formatAxis(v: number, metric: ChartMetric): string {
  if (v === 0) return '0'
  const short = (x: number): string => formatShort(x, 2)
  if (metric === 'cost') return `$${short(v)}`
  if (metric === 'tokens') return formatTokens(v)
  if (metric === 'time') return v >= HOUR ? t('common.unit.hour', { n: short(v / HOUR) }) : t('common.unit.min', { n: Math.round(v / MIN) })
  return String(v)
}
