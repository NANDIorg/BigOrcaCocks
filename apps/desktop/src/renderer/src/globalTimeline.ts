import { type AgentSession, type BoardColumn, type ColumnKind, type GlobalTask, type StageChange, type StageDecision, type WfNodeType, type Workflow } from '@orca-board/core'
import { formatDuration } from './duration'
import { STATUS_SOURCE_TITLES, statusDurationLabel } from './statusHistory'
import { t, type TKey } from './i18n'
import { formatDateTime } from './i18n/format'
import { agentTitle, builtinText, nodeTitle } from './defaultTitles'

/**
 * Вид события ленты «История». От порядка зависит разбор записей с одинаковой меткой времени — см. `KIND_RANK`.
 */
export type TimelineKind = 'created' | 'status' | 'return' | 'summary' | 'coordinator' | 'closed' | 'stage'

/** Что лента читает из глобальной задачи. Всё необязательно: снапшот может прийти от старого main. */
export type TimelineSource = Partial<Pick<GlobalTask, 'createdAt' | 'closedAt' | 'statusHistory' | 'returns' | 'summary' | 'stageHistory'>> & {
  /** `Run.coordinatorSessions`: в `GlobalTask` их нет, их отдаёт `App` из снапшота прогонов. */
  coordinatorSessions?: readonly AgentSession[]
  /**
   * Граф прогона (`workflowForRun`): по нему у входов в этапы берётся живое название и отсекаются ноды, на которых
   * задача не стоит (старт, условие). Нет графа — берутся названия из самой записи истории (`StageChange.title`).
   */
  workflow?: Workflow
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
  /** Цитата под строкой: уточнение человека целиком, выдержка сводки, обоснование решения ноды `decision`. */
  text?: string
  /** Вторая цитата: комментарий агента, передавшего решение ноды `decision` человеку (`StageDecision.agentNote`). */
  note?: string
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
 * Порядок событий с одной меткой времени, от причины к следствию: уточнение → вход в этап воркфлоу → переход «В работу» →
 * запуск координатора → сводка → закрытие → переход на «Проверку» / в «Сделано» (карточка уходит туда после закрытия).
 * В ленте новые сверху, так что следствие окажется выше причины.
 */
const KIND_RANK: Record<TimelineKind, number> = { created: 0, return: 1, stage: 2, status: 3, coordinator: 4, summary: 5, closed: 6 }
const FINISH_RANK = 7

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
  const agent = agentTitle(String(s.agent))
  return s.model ? `${agent} · ${s.model}` : agent
}

/** Исходы, которые стоит назвать в ленте: `next`, `ok`, `yes`, `no` — обычное движение вперёд. */
const NOTABLE_OUTCOMES: readonly NonNullable<StageChange['outcome']>[] = ['reject', 'accept', 'restart', 'conflict', 'error']

/** Ноды, на которых глобальная задача не стоит: в истории их не бывает, а в чужом графе — не показываем. */
const PASS_THROUGH: readonly WfNodeType[] = ['start', 'condition']

/** Короткий вид коммита для строки ленты. */
const COMMIT_SHORT = 7

/** Длина обоснования решения в ленте: обоснование до `DECISION_REASON_LIMIT` (4000) символов, целиком — в `workflow show --run`. */
export const DECISION_EXCERPT_LIMIT = 400

/** Текст решения одной строкой (переносы схлопнуты), обрезанный до `DECISION_EXCERPT_LIMIT`; пустой — undefined. */
function decisionExcerpt(text: unknown): string | undefined {
  const line = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  if (!line) return undefined
  return line.length > DECISION_EXCERPT_LIMIT ? `${line.slice(0, DECISION_EXCERPT_LIMIT - 1)}…` : line
}

/**
 * Подпись решения ноды `decision` (`StageChange.decision`): кто выбрал ветку и какую, у человека — почему решал он.
 * Решение пишет новый main; поля читаются осторожно — снапшот может быть неполным.
 */
function decisionLine(d: Partial<StageDecision>): string | undefined {
  const label = typeof d.label === 'string' && d.label ? d.label : d.optionId
  if (!label) return undefined
  if (d.by !== 'human') return t('global.timeline.stageDecision', { label })
  const human = t('global.timeline.stageDecisionHuman', { label })
  return d.fallback ? `${human} · ${t(`global.timeline.stageDecisionFallback.${d.fallback}` as TKey)}` : human
}

/**
 * Входы в этапы воркфлоу глобальной задачи (`Run.stageHistory`): «Этап «Реализация»», заход со второго, чем пришли
 * (возврат на доработку, конфликт), коммит ветки на входе и выдержка сводки, с которой этап закрыт. У ноды `decision` —
 * выбранная ветка, обоснование и комментарий агента, если решал человек. Исход-вариант следующей записи не подписываем:
 * он уже виден в решении. Название — из графа прогона, если он есть (тогда оно и переведено), иначе из записи.
 */
function stageEvents(g: TimelineSource): TimelineEvent[] {
  return (g.stageHistory ?? []).flatMap((h, i): TimelineEvent[] => {
    if (!isTime(h.at)) return []
    const node = g.workflow?.nodes.find((n) => n.id === h.nodeId)
    if (node && PASS_THROUGH.includes(node.type)) return []
    const name = node ? nodeTitle(node) : h.title ? builtinText(h.title) : h.nodeId
    const outcome = h.outcome && NOTABLE_OUTCOMES.includes(h.outcome) ? t(`global.timeline.stageOutcome.${h.outcome}` as TKey) : undefined
    const commit = h.commit ? t('global.timeline.stageCommit', { commit: h.commit.slice(0, COMMIT_SHORT) }) : undefined
    const decision = h.decision && typeof h.decision === 'object' ? h.decision : undefined
    const chosen = decision ? decisionLine(decision) : undefined
    // У ноды `decision` сводки нет: цитата — обоснование того, кто выбрал ветку.
    const excerpt = decision ? decisionExcerpt(decision.reason) : summaryExcerpt(h.summary)
    const note = decision?.by === 'human' ? decisionExcerpt(decision.agentNote) : undefined
    const sub = [chosen, outcome, commit].filter(Boolean)
    return [{
      key: `stage-${i}`,
      kind: 'stage',
      at: h.at,
      title: t('global.timeline.stage', { name }),
      ...(h.visit !== undefined && h.visit > 1 ? { detail: t('global.timeline.stageVisit', { n: h.visit }) } : {}),
      ...(sub.length ? { sub: sub.join(' · ') } : {}),
      ...(excerpt ? { text: excerpt } : {}),
      ...(note ? { note: t('global.timeline.stageDecisionNote', { note }) } : {})
    }]
  })
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

  events.push(...stageEvents(g))

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
