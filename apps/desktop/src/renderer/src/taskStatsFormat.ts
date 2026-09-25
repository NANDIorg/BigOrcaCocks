import {
  HUMAN_REQUEST_KINDS, buildGlobalTaskStats, buildTaskStats,
  type BoardColumn, type Dispatch, type GlobalTaskStats, type HumanRequest, type HumanRequestKind, type Question, type Run,
  type StatsRow, type StatsSpan, type StatsUsage, type Task, type TaskColumnTime, type TaskStageTime, type TaskStats, type TaskWaitStats
} from '@orca-board/core'
import type { OrcaApi } from '../../shared/ipc'
import { formatDuration } from './duration'
import { t } from './i18n'
import {
  costCell, formatAgentTime, formatTokens, isStaleStatsError, statsStaleMessage, missingLabel, missingSessions, sessionsLabel, statsApi, totalTokens
} from './statsFormat'

/**
 * Секция «Статистика» задачи и вкладка «Статистика» глобальной задачи (docs/architecture.md, «Статистика задачи →
 * Интерфейс»): форматирование, «бегущие» значения и запасной расчёт при старом main. Без React — чтобы тестировать.
 */

// ---------- доступ к API и старый main ----------

/** Подсказка вместо токенов и стоимости, когда main/preload старее `stats:task` / `stats:global`. */
export function taskStatsStaleHint(): string {
  return t('board.stats.staleHint')
}

export type TaskStatsApi = Pick<OrcaApi['stats'], 'task' | 'global'>

/**
 * `window.orca.stats.task` / `.global` или ошибка `statsStaleMessage()` (на языке интерфейса). Старый preload может быть уже со `stats`
 * (проектная статистика), но без задачи — тогда `stats.task` не функция.
 */
export function taskStatsApi(api: Partial<OrcaApi> | undefined): TaskStatsApi {
  const stats = statsApi(api)
  if (typeof stats.task !== 'function' || typeof stats.global !== 'function') throw new Error(statsStaleMessage())
  return stats
}

/** Ошибка «main/preload устарели»: нет API в preload или нет обработчика в main. Тогда считаем время сами. */
export function isStatsStale(message: string): boolean {
  return isStaleStatsError(message)
}

/** То, что renderer знает о проекте: этого хватает `buildTaskStats` / `buildGlobalTaskStats` без токенов. */
export interface StatsSnapshot {
  tasks: readonly Task[]
  runs: readonly Run[]
  dispatches: readonly Dispatch[]
  requests: readonly HumanRequest[]
  questions: readonly Question[]
  columns: readonly BoardColumn[]
}

/** Статистика задачи только по времени (старый main): токенов нет — «неизвестно», не ноль. */
export function fallbackTaskStats(snap: StatsSnapshot, taskId: string, now: number): TaskStats {
  return buildTaskStats({ ...snap, tasks: [...snap.tasks], runs: [...snap.runs], dispatches: [...snap.dispatches], requests: [...snap.requests], questions: [...snap.questions], now, taskId })
}

/** То же для глобальной задачи. */
export function fallbackGlobalStats(snap: StatsSnapshot, runId: string, now: number): GlobalTaskStats {
  return buildGlobalTaskStats({ ...snap, tasks: [...snap.tasks], runs: [...snap.runs], dispatches: [...snap.dispatches], requests: [...snap.requests], questions: [...snap.questions], now, runId })
}

// ---------- когда перечитывать ----------

/**
 * Ключ «что важно для статистики задачи»: меняется, когда у задачи (или её проверок) сменился статус, пришёл или
 * закончился запуск, появился или решился запрос. Пока он тот же, статистика не перечитывается — время тикает на клиенте.
 */
export function taskStatsKey(snap: StatsSnapshot, taskId: string): string {
  const mine = snap.tasks.filter((t) => t.id === taskId || t.gateFor?.taskId === taskId)
  const ids = new Set(mine.map((t) => t.id))
  return [
    mine.map((t) => `${t.id}:${t.status}:${t.updatedAt}`).join(','),
    snap.dispatches.filter((d) => ids.has(d.taskId)).map((d) => `${d.id}:${d.endedAt ?? ''}:${d.outcome ?? ''}`).join(','),
    snap.requests.filter((r) => ids.has(r.taskId)).map((r) => `${r.id}:${r.status}`).join(',')
  ].join('|')
}

/** То же для глобальной задачи: её статус, подзадачи, запуски и запросы прогона, запуски координатора. */
export function globalStatsKey(snap: StatsSnapshot, runId: string): string {
  const run = snap.runs.find((r) => r.id === runId)
  const mine = snap.tasks.filter((t) => t.runId === runId)
  const ids = new Set(mine.map((t) => t.id))
  return [
    `${run?.status ?? ''}:${run?.updatedAt ?? ''}:${run?.returns?.length ?? 0}`,
    run?.coordinatorSessions?.map((s) => `${s.ptyId}:${s.endedAt ?? ''}`).join(',') ?? '',
    mine.map((t) => `${t.id}:${t.status}:${t.updatedAt}`).join(','),
    snap.dispatches.filter((d) => ids.has(d.taskId)).map((d) => `${d.id}:${d.endedAt ?? ''}:${d.outcome ?? ''}`).join(','),
    snap.requests.filter((r) => r.runId === runId).map((r) => `${r.id}:${r.status}`).join(',')
  ].join('|')
}

/** Как часто перечитывать статистику, пока что-то идёт: транскрипты растут, а роли и токены тикать на клиенте нечем. */
export const STATS_REFRESH_MS = 60_000

/** Что-то идёт прямо сейчас (задача не в done, идут сессии, ждёт запрос) — есть смысл периодически перечитывать. */
export function isStatsRunning(s: TaskStats | GlobalTaskStats): boolean {
  const dispatches = 'dispatches' in s ? s.dispatches.running : 0
  return s.lifetime.running === true || dispatches > 0 || s.human.pending > 0
}

// ---------- бегущие значения ----------

/** Что клиент знает про «сейчас», чего нет в статистике: идёт ли отрезок «в работе» и в какой колонке задача. */
export interface LiveTask {
  /** Отрезок `Task.activeMs` открыт (`taskTicking`). */
  activeTicking: boolean
  /** Текущий статус задачи (id колонки) — её время в полосе растёт, пока задача не в done. */
  status: string
}

export interface LiveGlobal {
  /** Открыт отрезок собственного времени глобальной задачи (`globalTaskTicking(g, 'own')`). */
  ownTicking: boolean
  status: string
  /** Жив PTY координатора: время координатора растёт. */
  coordinatorLive: boolean
  /** Подзадач с идущей сессией: каждая добавляет свой отрезок к времени подзадач. */
  subtasksRunning: number
}

function grow(columns: TaskColumnTime[], status: string, delta: number): TaskColumnTime[] {
  return columns.map((c) => (c.status === status ? { ...c, ms: c.ms + delta } : c))
}

function growWait(human: TaskWaitStats, delta: number): TaskWaitStats {
  return human.pending > 0 ? { ...human, waitingMs: human.waitingMs + delta } : human
}

/**
 * «Бегущие» значения на момент `now`: main считает их на `generatedAt`, клиент добавляет прошедшее — как
 * `activeDuration`. Растут: время жизни (пока не в done), «в работе», колонка задачи, ожидание человека (пока есть
 * pending-запрос) и время агентов идущих сессий. Разбивки по ролям и этапам ждут перечитывания (`STATS_REFRESH_MS`).
 */
export function advanceTaskStats(s: TaskStats, now: number, live: LiveTask): TaskStats {
  const delta = Math.max(0, now - s.generatedAt)
  if (delta === 0) return s
  const running = s.lifetime.running === true
  return {
    ...s,
    lifetime: running ? { ...s.lifetime, ms: s.lifetime.ms + delta } : s.lifetime,
    ...(s.activeMs !== undefined ? { activeMs: live.activeTicking ? s.activeMs + delta : s.activeMs } : {}),
    columns: running ? grow(s.columns, live.status, delta) : s.columns,
    usage: { ...s.usage, agentMs: s.usage.agentMs + s.dispatches.running * delta },
    human: growWait(s.human, delta)
  }
}

export function advanceGlobalStats(s: GlobalTaskStats, now: number, live: LiveGlobal): GlobalTaskStats {
  const delta = Math.max(0, now - s.generatedAt)
  if (delta === 0) return s
  const running = s.lifetime.running === true
  const coordinator = live.coordinatorLive ? delta : 0
  const subtasks = live.subtasksRunning * delta
  return {
    ...s,
    lifetime: running ? { ...s.lifetime, ms: s.lifetime.ms + delta } : s.lifetime,
    ...(s.ownActiveMs !== undefined ? { ownActiveMs: live.ownTicking ? s.ownActiveMs + delta : s.ownActiveMs } : {}),
    columns: running ? grow(s.columns, live.status, delta) : s.columns,
    usage: { ...s.usage, agentMs: s.usage.agentMs + coordinator + subtasks },
    coordinator: { ...s.coordinator, agentMs: s.coordinator.agentMs + coordinator },
    subtasks: { ...s.subtasks, agentMs: s.subtasks.agentMs + subtasks },
    human: growWait(s.human, delta)
  }
}

// ---------- значения ----------

/** Длительность интервала: у неточного (`approx`) — «≈ 3 ч». */
export function spanLabel(span: { ms: number; approx?: boolean }): string {
  return `${span.approx ? '≈ ' : ''}${formatDuration(span.ms)}`
}

/** Подсказка к «≈»: откуда неточность. */
export function approxTitle(): string {
  return t('board.stats.approx')
}

/** Значение показателя: текст, «неизвестно» (курсивом, не 0) и подсказка. */
export interface StatFact {
  id: string
  label: string
  /** Главное значение. */
  value: string
  /** Подпись под значением. */
  hint?: string
  /** Значение неизвестно — рисуется приглушённо. */
  unknown?: boolean
  /** Значение приблизительное. */
  approx?: boolean
  /** Идёт сейчас — значение тикает. */
  live?: boolean
  title?: string
}

/** Стоимость среза: «$1,20», «не менее $1,20», «без цены», «нет данных» — и подпись, чего не хватает. */
export function costFact(u: StatsUsage): Pick<StatFact, 'value' | 'hint' | 'unknown' | 'title'> {
  const c = costCell(u)
  const missing = missingSessions(u)
  const tokens = totalTokens(u.tokens)
  const gaps = missing > 0 && u.sessions > 0 ? missingLabel(missing) : undefined
  if (c.kind === 'cost') {
    return {
      value: c.atLeast ? t('board.stats.atLeast', { value: c.text }) : c.text,
      hint: [tokens !== undefined ? t('board.stats.tokens', { value: formatTokens(tokens) }) : undefined, gaps].filter(Boolean).join(' · ') || undefined,
      title: c.atLeast ? t('board.stats.unpricedTokens', { value: formatTokens(u.unpricedTokens), models: u.unpricedModels.join(', ') }) : undefined
    }
  }
  if (c.kind === 'unpriced') return { value: t('board.stats.unpriced'), hint: t('board.stats.unpricedHint', { models: u.unpricedModels.join(', ') }), unknown: true }
  return {
    value: t('board.stats.noData'),
    hint: u.sessions > 0 ? t('board.stats.noTokens', { sessions: sessionsLabel(u.sessions) }) : t('board.stats.agentsNotRun'),
    unknown: true,
    title: t('board.stats.noTokensTitle')
  }
}

/** «Ждала вас»: сколько у задачи был pending-запрос к человеку (не время самого человека). */
export function waitFact(human: TaskWaitStats): StatFact {
  const total = human.resolved + human.cancelled + human.pending
  const base = { id: 'wait', label: t('board.stats.wait'), title: t('board.stats.waitTitle') }
  if (total === 0) return { ...base, value: t('board.stats.notWaited'), hint: t('board.stats.noRequests') }
  return {
    ...base,
    value: formatDuration(human.waitingMs),
    hint: human.pending > 0 ? t('board.stats.waitingNow', { total }) : t('board.stats.requests', { count: total }),
    ...(human.pending > 0 ? { live: true } : {})
  }
}

function agentsFact(usage: StatsUsage): StatFact {
  return {
    id: 'agents',
    label: t('board.stats.agents'),
    value: usage.sessions > 0 ? formatAgentTime(usage.agentMs) : t('board.stats.notRun'),
    hint: usage.sessions > 0 ? sessionsLabel(usage.sessions) : undefined,
    title: t('board.stats.agentsTitle')
  }
}

/** Строка фактов задачи: «Время жизни · В работе · Агенты · Ждала вас · Стоимость». */
export function taskFacts(s: TaskStats): StatFact[] {
  const life = s.lifetime
  const lead = s.leadMs !== undefined ? t('board.stats.lead', { value: formatDuration(s.leadMs) }) : undefined
  const running = t('board.stats.running')
  return [
    {
      id: 'lifetime', label: t('board.stats.lifetime'), value: spanLabel(life), approx: life.approx === true, live: life.running === true,
      hint: life.running ? `${running}${lead ? ` · ${lead}` : ''}` : lead, title: life.approx ? approxTitle() : t('board.stats.lifetimeTitle')
    },
    s.activeMs !== undefined
      ? { id: 'active', label: t('board.stats.active'), value: formatDuration(s.activeMs), title: t('board.stats.activeTitle') }
      : { id: 'active', label: t('board.stats.active'), value: t('board.stats.neverActive'), unknown: true, title: t('board.stats.neverActiveTitle') },
    agentsFact(s.usage),
    waitFact(s.human),
    { id: 'cost', label: t('board.stats.cost'), ...costFact(s.usage) }
  ]
}

/** Итог глобальной задачи: «Время жизни · Своё время · Агенты · Ждала вас · Стоимость». */
export function globalFacts(s: GlobalTaskStats): StatFact[] {
  const life = s.lifetime
  return [
    {
      id: 'lifetime', label: t('board.stats.lifetime'), value: spanLabel(life), approx: life.approx === true, live: life.running === true,
      hint: life.running ? t('board.stats.running') : undefined, title: life.approx ? approxTitle() : t('board.stats.lifetimeGlobalTitle')
    },
    s.ownActiveMs !== undefined
      ? { id: 'own', label: t('board.stats.own'), value: formatDuration(s.ownActiveMs), title: t('board.stats.ownTitle') }
      : { id: 'own', label: t('board.stats.own'), value: t('board.stats.noData'), unknown: true, title: t('board.stats.ownUnknownTitle') },
    agentsFact(s.usage),
    waitFact(s.human),
    { id: 'cost', label: t('board.stats.cost'), ...costFact(s.usage) }
  ]
}

// ---------- полосы ----------

/** Часть полосы времени: колонка доски или этап воркфлоу. */
export interface TimePart {
  key: string
  title: string
  color: string
  ms: number
  entries: number
  approx: boolean
  /** Доля от суммы, 0..1 (0 у частей без времени). */
  share: number
}

function withShares(parts: Omit<TimePart, 'share'>[]): TimePart[] {
  const total = parts.reduce((a, p) => a + p.ms, 0)
  return parts.map((p) => ({ ...p, share: total > 0 ? p.ms / total : 0 }))
}

/**
 * Полоса по колонкам: цвета колонок доски (как `StatusHistoryBlock`). Колонки, которой уже нет на доске, —
 * серая часть с её id вместо названия. Порядок — как прислал main (порядок колонок доски).
 */
export function columnParts(columns: readonly TaskColumnTime[], board: readonly Pick<BoardColumn, 'id' | 'title' | 'color'>[]): TimePart[] {
  return withShares(columns.map((c) => {
    const col = board.find((b) => b.id === c.status)
    return { key: c.status, title: col?.title ?? c.status, color: col?.color ?? 'var(--s-other)', ms: c.ms, entries: c.entries, approx: c.approx === true }
  }))
}

/** Цвета этапов: у воркфлоу цветов нет — палитра серий (`--s1`…`--s5`) по кругу в порядке этапов. */
const STAGE_COLORS = 5

/** Полоса по этапам воркфлоу, в порядке первого захода. Нет `stages` — этапов нет. */
export function stageParts(stages: readonly TaskStageTime[] | undefined): TimePart[] {
  return withShares((stages ?? []).map((s, i) => ({
    key: s.nodeId, title: s.title, color: `var(--s${(i % STAGE_COLORS) + 1})`, ms: s.ms, entries: s.entries, approx: s.approx === true
  })))
}

/** Значение части полосы: «2 ч 10 мин · 3 захода»; ноль — «—» (в done время не считается, а не «<1 мин»). */
export function partValue(p: TimePart): string {
  if (p.ms === 0) return '—'
  const times = p.entries > 1 ? ` · ${t('board.stats.entries', { count: p.entries })}` : ''
  return `${spanLabel(p)}${times}`
}

/** Подпись части полосы для подсказки: «Работа — 2 ч 10 мин · 3 захода». */
export function partLabel(p: TimePart): string {
  return `${p.title} — ${partValue(p)}`
}

// ---------- роли и счётчики ----------

/** Строка таблицы ролей: время, токены, стоимость — по данным `StatsRow`. */
export interface RoleRow {
  key: string
  title: string
  agentMs: number
  /** Все виды токенов; нет данных — `undefined` («неизвестно», не 0). */
  tokens?: number
  usage: StatsUsage
}

export function roleRows(rows: readonly StatsRow[]): RoleRow[] {
  return rows.map((r) => ({ key: r.key, title: r.title, agentMs: r.agentMs, tokens: totalTokens(r.tokens), usage: r }))
}

/** Отказы и возвраты на доработку: сумма и расшифровка для подсказки. */
export function rejectionsTotal(r: TaskStats['rejections']): number {
  return r.gate + r.approval + r.clarify + r.manual
}

export function rejectionsTitle(r: TaskStats['rejections']): string {
  const parts = [
    r.gate > 0 ? t('board.stats.rejGate', { n: r.gate }) : '',
    r.approval > 0 ? t('board.stats.rejApproval', { n: r.approval }) : '',
    r.clarify > 0 ? t('board.stats.rejClarify', { n: r.clarify }) : '',
    r.manual > 0 ? t('board.stats.rejManual', { n: r.manual }) : ''
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(', ') : t('board.stats.noRejections')
}

/** Чип-счётчик: подпись, значение и тон (`warn` — стоит посмотреть). */
export interface StatCounter {
  id: string
  text: string
  tone?: 'ok' | 'warn' | 'live'
  title?: string
}

/** Запуски: «запусков 3» и исходы — сдано, упало, вышел без done, идут. */
export function dispatchCounters(d: TaskStats['dispatches']): StatCounter[] {
  if (d.total === 0) return [{ id: 'runs', text: t('board.stats.noRuns') }]
  const out: StatCounter[] = [{ id: 'runs', text: t('board.stats.runs', { n: d.total }) }]
  if (d.done > 0) out.push({ id: 'done', text: t('board.stats.runsDone', { n: d.done }), tone: 'ok' })
  if (d.failed > 0) out.push({ id: 'failed', text: t('board.stats.runsFailed', { n: d.failed }), tone: 'warn' })
  if (d.unknown > 0) out.push({ id: 'unknown', text: t('board.stats.runsUnknown', { n: d.unknown }), title: t('board.stats.runsUnknownTitle') })
  if (d.running > 0) out.push({ id: 'running', text: t('board.stats.runsRunning', { n: d.running }), tone: 'live' })
  return out
}

/** Счётчики задачи: запуски, отказы ревью, вопросы координатору. */
export function taskCounters(s: TaskStats): StatCounter[] {
  const back = rejectionsTotal(s.rejections)
  const q = s.coordinatorQuestions
  return [
    ...dispatchCounters(s.dispatches),
    { id: 'rejections', text: t('board.stats.rejections', { n: back }), tone: back > 0 ? 'warn' : undefined, title: rejectionsTitle(s.rejections) },
    {
      id: 'questions', text: t('board.stats.questions', { n: q.count }),
      title: q.answerMedianMs !== undefined ? t('board.stats.questionsMedian', { value: formatDuration(q.answerMedianMs) }) : t('board.stats.questionsTitle')
    }
  ]
}

/** Запросы к человеку: «вопросов 2, решений 1» — по видам, где они были (вид — как заголовок карточки запроса). */
export function humanKinds(human: TaskWaitStats): string {
  return HUMAN_REQUEST_KINDS.filter((k) => human.byKind[k].count > 0)
    .map((k: HumanRequestKind) => t(`board.stats.kind.${k}`, { n: human.byKind[k].count }))
    .join(', ')
}

/** Строка про запросы к человеку под фактами; нет запросов — `undefined`. */
export function humanLine(human: TaskWaitStats): string | undefined {
  const total = human.resolved + human.cancelled + human.pending
  if (total === 0) return undefined
  const parts = [t('board.stats.humanTotal', { n: total, kinds: humanKinds(human) })]
  if (human.pending > 0) parts.push(t('board.stats.humanPending', { n: human.pending }))
  if (human.cancelled > 0) parts.push(t('board.stats.humanCancelled', { n: human.cancelled }))
  if (human.reactionMedianMs !== undefined) {
    const median = formatDuration(human.reactionMedianMs)
    parts.push(human.reactionMaxMs !== undefined
      ? t('board.stats.reactionMax', { median, max: formatDuration(human.reactionMaxMs) })
      : t('board.stats.reaction', { median }))
  }
  return parts.join(' · ')
}

// ---------- глобальная задача ----------

/** Сторона «координатор» или «подзадачи» в сравнении расхода глобальной задачи. */
export interface SideStats {
  id: 'coordinator' | 'subtasks'
  title: string
  facts: StatFact[]
}

/** «Координатор vs подзадачи»: у каждой стороны время агентов, стоимость и то, чем она отличается (запуски / подзадачи). */
export function globalSides(s: GlobalTaskStats): SideStats[] {
  const side = (id: SideStats['id'], title: string, u: StatsUsage, extra: StatFact): SideStats => ({
    id,
    title,
    facts: [
      extra,
      { id: `${id}-time`, label: t('board.stats.agentTime'), value: u.sessions > 0 ? formatAgentTime(u.agentMs) : t('board.stats.none'), unknown: u.sessions === 0 },
      { id: `${id}-cost`, label: t('board.stats.cost'), ...costFact(u) }
    ]
  })
  const c = s.coordinator
  const sub = s.subtasks
  return [
    side('coordinator', t('board.stats.coordinator'), c, { id: 'launches', label: t('board.stats.launches'), value: String(c.launches), hint: c.sessions > 0 ? sessionsLabel(c.sessions) : undefined }),
    side('subtasks', t('board.stats.subtasks'), sub, { id: 'count', label: t('board.stats.subtaskCount'), value: String(sub.count), hint: t('board.stats.subtasksDone', { n: sub.done }) })
  ]
}

/** Строка топа подзадач: кликабельна, если задача ещё есть на доске. */
export interface TopTaskRow {
  key: string
  title: string
  agentMs: number
  usage: StatsUsage
  /** Задача есть среди известных — клик открывает её. */
  openable: boolean
  /** Доля от самой дорогой строки, 0..1: по стоимости, а без токенов — по времени агентов. */
  share: number
}

/** Первые `limit` подзадач (main отсортировал по стоимости) с долей; `known` — id задач, которые можно открыть. */
export function topTasks(rows: readonly StatsRow[], known: ReadonlySet<string>, limit = 8): TopTaskRow[] {
  const top = rows.slice(0, limit)
  const byCost = top.some((r) => r.costUsd !== undefined)
  const value = (r: StatsRow): number => (byCost ? r.costUsd ?? 0 : r.agentMs)
  const max = Math.max(0, ...top.map(value))
  return top.map((r) => ({ key: r.key, title: r.title, agentMs: r.agentMs, usage: r, openable: known.has(r.key), share: max > 0 ? value(r) / max : 0 }))
}

/** Возвраты человеком с «Проверки» в работу (`Run.returns`): «возвращена в работу 2 раза». */
export function returnsCounter(returns: number): StatCounter {
  return {
    id: 'returns',
    text: returns > 0 ? t('board.stats.returns', { count: returns }) : t('board.stats.noReturns'),
    tone: returns > 0 ? 'warn' : undefined,
    title: t('board.stats.returnsTitle')
  }
}
