import { AGENT_TITLES, type AgentSession, type BoardColumn, type ColumnKind, type GlobalTask } from '@orca-board/core'
import { formatDuration } from './duration'
import { STATUS_SOURCE_TITLES, statusDurationLabel } from './statusHistory'
import { t } from './i18n'
import { formatDateTime } from './i18n/format'

/**
 * Вид события ленты «История». От порядка зависит разбор записей с одинаковой меткой времени — см. `KIND_RANK`.
 */
export type TimelineKind = 'created' | 'status' | 'return' | 'summary' | 'coordinator' | 'closed'

/** Что лента читает из глобальной задачи. Всё необязательно: снапшот может прийти от старого main. */
export type TimelineSource = Partial<Pick<GlobalTask, 'createdAt' | 'closedAt' | 'statusHistory' | 'returns' | 'summary'>> & {
  /** `Run.coordinatorSessions`: в `GlobalTask` их нет, их отдаёт `App` из снапшота прогонов. */
  coordinatorSessions?: readonly AgentSession[]
}

export interface TimelineEvent {
  /** Стабильный ключ React. */
  key: string
  kind: TimelineKind
  at: number
  /** Жирная часть строки: «Создана», «На проверке». */
  title: string
  /** Пояснение после тире. */
  detail?: string
  /** Серая строка под названием: источник перехода, длительность. */
  sub?: string
  /** Цитата под строкой: уточнение человека целиком, выдержка сводки. */
  text?: string
  /** Уточнение после проверки — в ленте выделено. */
  highlight?: boolean
  /** Цвет колонки, в которую перешла задача (`created` и `status`); колонки нет — undefined. */
  color?: string
  /** Вид колонки — для точки нужного цвета, когда у колонки цвета нет. */
  columnKind?: ColumnKind
  /** Время приблизительное: стартовая запись миграции, а не настоящий переход. */
  approx?: boolean
}

export interface TimelineDay {
  /** Локальная дата `ГГГГ-ММ-ДД` — ключ и порядок групп. */
  key: string
  /** «Сегодня», «Вчера», «23 сентября» (с годом, если он не текущий). */
  label: string
  events: TimelineEvent[]
}

/**
 * Порядок событий с одной меткой времени, от причины к следствию: уточнение → переход «В работу» → запуск
 * координатора → сводка → закрытие → переход на «Проверку» / в «Сделано» (карточка уходит туда после закрытия).
 * В ленте новые сверху, так что следствие окажется выше причины.
 */
const KIND_RANK: Record<TimelineKind, number> = { created: 0, return: 1, status: 2, coordinator: 3, summary: 4, closed: 5 }
const FINISH_RANK = 6

function rankOf(e: TimelineEvent): number {
  return e.kind === 'status' && (e.columnKind === 'review' || e.columnKind === 'done') ? FINISH_RANK : KIND_RANK[e.kind]
}

/** Первый переход статуса в пределах этого окна от `createdAt` — это создание, а не отдельное событие. */
const CREATED_WINDOW_MS = 2000

/** Длина выдержки сводки в ленте: целиком сводка — на вкладке «Итог и цель». */
export const SUMMARY_EXCERPT_LIMIT = 200

function isTime(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Выдержка сводки координатора: первая содержательная строка без markdown-разметки, обрезанная до
 * `SUMMARY_EXCERPT_LIMIT`. Заголовки («## Итог») пропускаются, пока есть обычный текст: сам по себе заголовок
 * ничего не говорит. Пустая сводка — undefined.
 */
export function summaryExcerpt(text: string | undefined): string | undefined {
  const lines = (text ?? '').split('\n').map((raw) => ({
    heading: /^\s*#{1,6}\s/.test(raw),
    text: raw.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, '').replace(/[*_`]/g, '').trim()
  })).filter((l) => l.text)
  const line = (lines.find((l) => !l.heading) ?? lines[0])?.text
  if (!line) return undefined
  return line.length > SUMMARY_EXCERPT_LIMIT ? `${line.slice(0, SUMMARY_EXCERPT_LIMIT - 1)}…` : line
}

/** Название запуска координатора: «Claude Opus», без модели — «Claude». */
function agentLabel(s: AgentSession): string {
  const agent = (AGENT_TITLES as Record<string, string>)[s.agent] ?? String(s.agent)
  return s.model ? `${agent} · ${s.model}` : agent
}

/**
 * Единая лента событий глобальной задачи, новые сверху. Источники: `createdAt`, `statusHistory` (переходы),
 * `returns` (уточнения при возврате с проверки), `summary`, `coordinatorSessions`, `closedAt`.
 * Нет поля или оно пустое — событий этого вида нет; записи без корректного времени отбрасываются.
 *
 * Колонки нужны для названий и цветов статусов; удалённая колонка показывается своим id без цвета.
 * `now` — для «сколько задача пробыла в статусе»: у текущего статуса отсчёт идёт до него.
 */
export function globalTimeline(g: TimelineSource, columns: readonly BoardColumn[], now: number): TimelineEvent[] {
  const byId = new Map<string, BoardColumn>()
  for (const c of columns) if (!byId.has(c.id)) byId.set(c.id, c)
  const columnTitle = (status: string): string => byId.get(status)?.title ?? status

  const history = (g.statusHistory ?? []).filter((h) => isTime(h.at))
  const events: TimelineEvent[] = []

  // Первая запись истории при создании — это «Создана в «Бэклог»», отдельным переходом её не показываем.
  // Стартовая запись миграции не считается: её `at` — последняя правка, а не создание.
  const first = history[0]
  const foldFirst = first !== undefined && isTime(g.createdAt) && first.migrated !== true && Math.abs(first.at - g.createdAt) <= CREATED_WINDOW_MS
  if (isTime(g.createdAt)) {
    const column = foldFirst ? byId.get(first.status) : undefined
    events.push({
      key: 'created',
      kind: 'created',
      at: g.createdAt,
      title: t('global.timeline.created'),
      ...(foldFirst ? { detail: t('global.timeline.createdIn', { column: columnTitle(first.status) }) } : {}),
      ...(column ? { color: column.color, columnKind: column.kind } : {})
    })
  }

  history.forEach((h, i) => {
    if (i === 0 && foldFirst) return
    const next = history[i + 1]
    const current = next === undefined
    const migrated = h.migrated === true
    const column = byId.get(h.status)
    const source = STATUS_SOURCE_TITLES[h.by] ?? (h.by ? String(h.by) : undefined)
    const duration = statusDurationLabel({ durationMs: Math.max(0, (next ? next.at : now) - h.at), current, migrated })
    events.push({
      key: `status-${i}`,
      kind: 'status',
      at: h.at,
      title: t(migrated ? 'global.timeline.statusMigrated' : 'global.timeline.status', { column: columnTitle(h.status) }),
      ...(migrated ? { detail: t('global.timeline.migrated') } : {}),
      sub: [source, duration].filter(Boolean).join(' · '),
      ...(column ? { color: column.color, columnKind: column.kind } : {}),
      ...(migrated ? { approx: true } : {})
    })
  })

  ;(g.returns ?? []).forEach((r, i) => {
    if (!isTime(r.at)) return
    events.push({ key: `return-${i}`, kind: 'return', at: r.at, title: t('global.timeline.returned'), detail: t('global.timeline.returnDetail'), text: r.text, highlight: true })
  })

  if (g.summary && isTime(g.summary.at)) {
    const excerpt = summaryExcerpt(g.summary.text)
    events.push({
      key: 'summary',
      kind: 'summary',
      at: g.summary.at,
      title: t('global.timeline.summary'),
      sub: t('global.timeline.summarySub'),
      ...(excerpt ? { text: excerpt } : {})
    })
  }

  const sessions = (g.coordinatorSessions ?? []).filter((s) => isTime(s.startedAt))
  sessions.forEach((s, i) => {
    const worked = isTime(s.endedAt) && s.endedAt >= s.startedAt ? t('global.timeline.worked', { duration: formatDuration(s.endedAt - s.startedAt) }) : undefined
    const nth = sessions.length > 1 ? t('global.run.nth', { n: i + 1 }) : undefined
    events.push({
      key: `coordinator-${i}`,
      kind: 'coordinator',
      at: s.startedAt,
      title: t('global.timeline.coordinator'),
      detail: agentLabel(s),
      sub: [nth, worked].filter(Boolean).join(' · ') || undefined
    })
  })

  if (isTime(g.closedAt)) events.push({ key: 'closed', kind: 'closed', at: g.closedAt, title: t('global.timeline.closed') })

  return events
    .map((e, seq) => ({ e, seq }))
    .sort((a, b) => b.e.at - a.e.at || rankOf(b.e) - rankOf(a.e) || b.seq - a.seq)
    .map(({ e }) => e)
}

/** Сколько последних событий видно в свёрнутой ленте: история статусов может быть до 200 записей. */
export const TIMELINE_COLLAPSED = 40

/** Свёрнутая лента — `TIMELINE_COLLAPSED` новейших событий, развёрнутая — все. Ленту в порядке «новые сверху». */
export function visibleTimeline(events: readonly TimelineEvent[], expanded: boolean): TimelineEvent[] {
  return expanded ? [...events] : events.slice(0, TIMELINE_COLLAPSED)
}

function dayKey(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Подпись дня: «Сегодня», «Вчера», иначе «23 сентября» / «September 23» (с годом, если он не текущий). */
export function dayLabel(at: number, now: number): string {
  const d = new Date(at)
  const today = new Date(now)
  if (dayKey(d) === dayKey(today)) return t('global.history.today')
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (dayKey(d) === dayKey(yesterday)) return t('global.history.yesterday')
  return formatDateTime(d, d.getFullYear() === today.getFullYear()
    ? { day: 'numeric', month: 'long' }
    : { day: 'numeric', month: 'long', year: 'numeric' })
}

/** Время внутри дня: «14:33» / «02:33 PM». */
export function formatClock(at: number): string {
  return formatDateTime(at, { hour: '2-digit', minute: '2-digit' })
}

/** Группы по локальным дням в порядке событий (новые сверху); внутри группы порядок сохраняется. */
export function groupByDay(events: readonly TimelineEvent[], now: number): TimelineDay[] {
  const days: TimelineDay[] = []
  for (const e of events) {
    const key = dayKey(new Date(e.at))
    const last = days[days.length - 1]
    if (last && last.key === key) last.events.push(e)
    else days.push({ key, label: dayLabel(e.at, now), events: [e] })
  }
  return days
}
