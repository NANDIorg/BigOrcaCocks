/**
 * Статистика одной задачи и одной глобальной задачи (docs/architecture.md, «Статистика задачи»): чистые функции
 * без Node — их зовёт main (с токенами из транскриптов), а renderer при старом main — без `usage`, тогда время
 * есть, а токенов нет («неизвестно», не ноль).
 */
import type {
  BoardColumn, ColumnKind, Dispatch, GlobalTaskStats, HumanRequest, HumanRequestKind, ModelPrice, Question, Run,
  StageChange, StatusChange, Task, TaskColumnTime, TaskStageTime, TaskStats, TaskWaitStats
} from './types.ts'
import { HUMAN_REQUEST_KINDS } from './types.ts'
import { activeDuration, taskActiveTime } from './active-time.ts'
import { globalTaskStatus } from './global-tasks.ts'
import { MODEL_PRICES, tokensCost } from './pricing.ts'
import { statsSessions, type SessionUsage, type StatsSession } from './stats.ts'
import { Acc, Group, UNKNOWN_MODEL, modelTitle, sessionModel, sessionSpan } from './stats-acc.ts'
import { STATUS_HISTORY_LIMIT } from './status-history.ts'
import { wfNodeTitle, type Workflow } from './workflow.ts'

/** Что нужно обеим статистикам: снапшот store и то, что знает только main (транскрипты, PTY, названия ролей). */
interface StatsBaseInput {
  /** Момент расчёта: «сейчас» для идущих интервалов и сессий. */
  now: number
  tasks: Task[]
  runs: Run[]
  dispatches: Dispatch[]
  requests: HumanRequest[]
  questions: Question[]
  columns: readonly BoardColumn[]
  /** Данные транскрипта сессии; нет функции или `undefined` — «неизвестно». */
  usage?: (s: StatsSession) => SessionUsage | undefined
  /** Жив ли PTY сессии без `endedAt`; по умолчанию — жив (идёт до `now`). */
  isAlive?: (ptyId: string) => boolean
  /** Название роли по id; нет — сам id. */
  roleTitle?: (roleId: string) => string | undefined
  prices?: ModelPrice[]
}

export interface TaskStatsInput extends StatsBaseInput {
  taskId: string
  /** Граф прогона задачи: названия этапов, если в `StageChange.title` их нет (запись миграции). */
  workflow?: Workflow
}

export interface GlobalTaskStatsInput extends StatsBaseInput {
  runId: string
}

// ---------- интервалы ----------

/** Интервал истории: запись и время, которое задача в ней пробыла. */
export interface HistorySpan<T> {
  entry: T
  from: number
  to: number
}

/**
 * Интервалы по истории переходов (от старых к новым): запись живёт до следующей, последняя — до `until`
 * (конец жизни задачи или «сейчас»). Интервал не бывает отрицательным: переход позже `until` даёт нулевой.
 */
export function historySpans<T extends { at: number }>(history: readonly T[], until: number): HistorySpan<T>[] {
  return history.map((entry, i) => {
    const next = history[i + 1]?.at ?? until
    return { entry, from: entry.at, to: Math.max(entry.at, Math.min(next, until)) }
  })
}

/** Объединение интервалов: пересекающиеся и соприкасающиеся сливаются, результат — по возрастанию начала. */
export function mergeSpans(spans: ReadonlyArray<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = []
  for (const s of [...spans].sort((a, b) => a.from - b.from || a.to - b.to)) {
    const last = out[out.length - 1]
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to)
    else out.push({ from: s.from, to: s.to })
  }
  return out
}

function spansMs(spans: ReadonlyArray<{ from: number; to: number }>): number {
  return spans.reduce((sum, s) => sum + (s.to - s.from), 0)
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const v = [...values].sort((a, b) => a - b)
  const mid = v.length >> 1
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

/** История обрезана до предела: самые ранние переходы потеряны (граница неточная — длина ровно на пределе). */
function truncated(history: readonly unknown[] | undefined): boolean {
  return (history?.length ?? 0) >= STATUS_HISTORY_LIMIT
}

// ---------- время жизни, колонки ----------

interface Timeline {
  lifetime: TaskStats['lifetime']
  leadMs?: number
  columns: TaskColumnTime[]
  /** Конец учёта: вход в done или `now`. */
  until: number
}

/**
 * Время жизни и по колонкам из истории статусов. Жизнь: `createdAt` → последний вход в done, не done — до `now`.
 * Запись миграции (`migrated`) — «была в done уже тогда», момент входа — `doneFallback` (`doneAt` / `closedAt`);
 * нет и её — `updatedAt` (оба случая — `approx`). Время в самой done-колонке после последнего входа не считается:
 * это не затраты задачи, оно растёт вечно.
 */
function timeline(t: {
  createdAt: number
  updatedAt: number
  status: string | undefined
  history: StatusChange[] | undefined
  doneFallback: number | undefined
  now: number
  columns: readonly BoardColumn[]
  kindOf: (status: string | undefined) => ColumnKind | undefined
}): Timeline {
  const { now, kindOf } = t
  const history = t.history ?? []
  const isDone = kindOf(t.status) === 'done'
  let until = now
  let approx = false
  let doneAt: number | undefined
  if (isDone) {
    const lastDone = [...history].reverse().find((h) => kindOf(h.status) === 'done')
    if (lastDone && !lastDone.migrated) doneAt = lastDone.at
    else {
      doneAt = t.doneFallback ?? lastDone?.at ?? t.updatedAt
      approx = true
    }
    until = Math.min(now, doneAt)
  }
  const lifetime: Timeline['lifetime'] = {
    ms: Math.max(0, until - t.createdAt),
    ...(approx ? { approx: true as const } : {}),
    ...(isDone ? {} : { running: true as const })
  }

  // «Первый вход в in_progress → done» — только по честной истории: запись миграции моментом входа не считается.
  let leadMs: number | undefined
  if (isDone && !approx && doneAt !== undefined) {
    const start = history.find((h) => !h.migrated && h.at <= doneAt! && kindOf(h.status) === 'in_progress')
    if (start) leadMs = doneAt - start.at
  }

  const cut = truncated(t.history)
  const byStatus = new Map<string, TaskColumnTime>()
  for (const { entry, from, to } of historySpans(history, until)) {
    let c = byStatus.get(entry.status)
    if (!c) byStatus.set(entry.status, (c = { status: entry.status, ms: 0, entries: 0 }))
    c.ms += to - from
    c.entries++
    if (cut || entry.migrated) c.approx = true
  }
  const order = new Map(t.columns.map((c, i) => [c.id, i]))
  const columns = [...byStatus.values()].sort((a, b) => (order.get(a.status) ?? Infinity) - (order.get(b.status) ?? Infinity))
  return { lifetime, ...(leadMs !== undefined ? { leadMs } : {}), columns, until }
}

/** Время по этапам воркфлоу: заходы суммируются, порядок — по первому заходу. */
function stageTimes(history: StageChange[], until: number, workflow: Workflow | undefined): TaskStageTime[] {
  const cut = truncated(history)
  const byNode = new Map<string, TaskStageTime>()
  for (const { entry, from, to } of historySpans(history, until)) {
    let s = byNode.get(entry.nodeId)
    if (!s) {
      const node = workflow?.nodes.find((n) => n.id === entry.nodeId)
      s = { nodeId: entry.nodeId, title: entry.title ?? (node ? wfNodeTitle(node) : entry.nodeId), ms: 0, entries: 0 }
      byNode.set(entry.nodeId, s)
    }
    s.ms += to - from
    s.entries++
    if (cut || entry.migrated) s.approx = true
  }
  return [...byNode.values()]
}

// ---------- запросы к человеку ----------

/** Ожидание человека по запросам: объединённое время pending и реакция по решённым. */
function waitStats(requests: readonly HumanRequest[], now: number): TaskWaitStats {
  const byKind = Object.fromEntries(HUMAN_REQUEST_KINDS.map((k) => [k, { count: 0, waitingMs: 0 }])) as Record<HumanRequestKind, { count: number; waitingMs: number }>
  const all: Array<{ from: number; to: number }> = []
  const perKind = new Map<HumanRequestKind, Array<{ from: number; to: number }>>()
  const reactions: number[] = []
  let resolved = 0
  let cancelled = 0
  let pending = 0
  for (const r of requests) {
    // Запрос без `resolvedAt`, но не pending (битые данные), не ждал ни минуты.
    const to = r.status === 'pending' ? now : Math.min(now, r.resolvedAt ?? r.createdAt)
    const span = { from: r.createdAt, to: Math.max(r.createdAt, to) }
    all.push(span)
    const list = perKind.get(r.kind)
    if (list) list.push(span)
    else perKind.set(r.kind, [span])
    byKind[r.kind].count++
    if (r.status === 'pending') pending++
    else if (r.status === 'cancelled') cancelled++
    else {
      resolved++
      if (r.resolvedAt !== undefined) reactions.push(Math.max(0, r.resolvedAt - r.createdAt))
    }
  }
  for (const [kind, spans] of perKind) byKind[kind].waitingMs = spansMs(mergeSpans(spans))
  const reactionMedianMs = median(reactions)
  return {
    waitingMs: spansMs(mergeSpans(all)),
    byKind,
    resolved,
    cancelled,
    pending,
    ...(reactionMedianMs !== undefined ? { reactionMedianMs, reactionMaxMs: Math.max(...reactions) } : {})
  }
}

// ---------- сессии и токены ----------

/**
 * Dispatch, закрытый миграцией при рестарте (`outcome: 'unknown'`), имеет `endedAt` = момент загрузки
 * приложения: время агента завысилось бы на простой. Если транскрипт нашёлся, конец — его последнее сообщение.
 */
function trimUnknownEnd(s: StatsSession, usage: SessionUsage | undefined): StatsSession {
  if (s.outcome !== 'unknown' || s.endedAt === undefined || usage?.lastAt === undefined) return s
  if (usage.lastAt < s.startedAt || usage.lastAt >= s.endedAt) return s
  return { ...s, endedAt: usage.lastAt }
}

/**
 * Разложить сессии по накопителям: `slices` даёт срезы сессии (итог, роль…), модель добавляется сюда. Период
 * задачи — всё время, без обрезки. Идущая сессия — до `now`, сессия без конца (упало приложение, транскрипта нет) —
 * 0 мс и без токенов: «неизвестно».
 */
function feedSessions(
  sessions: readonly StatsSession[],
  input: StatsBaseInput,
  byModel: Group,
  slices: (s: StatsSession) => Acc[]
): void {
  const isAlive = input.isAlive ?? ((): boolean => true)
  const prices = input.prices ?? MODEL_PRICES
  for (const raw of sessions) {
    if (raw.startedAt > input.now) continue
    const usage = input.usage?.(raw)
    const s = trimUnknownEnd(raw, usage)
    const { end, clippedEnd } = sessionSpan(s, usage, input.now, isAlive)
    const ms = end === undefined ? 0 : Math.max(0, clippedEnd - s.startedAt)
    const main = sessionModel(usage, s.model)
    const base = slices(s)
    for (const a of [...base, byModel.get(main, () => modelTitle(main))]) a.session(usage !== undefined, ms)
    for (const r of usage?.records ?? []) {
      const model = r.model || UNKNOWN_MODEL
      const rec = model === r.model ? r : { ...r, model }
      const cost = tokensCost(model, r, prices)
      // Токены — в модель записи (в сессии их может быть несколько), а не в модель сессии.
      for (const a of [...base, byModel.get(model, () => modelTitle(model))]) a.record(rec, cost)
    }
  }
}

function dispatchCounts(dispatches: readonly Dispatch[]): TaskStats['dispatches'] {
  const counts = { total: 0, done: 0, failed: 0, unknown: 0, running: 0 }
  for (const d of dispatches) {
    counts.total++
    if (d.endedAt === undefined) counts.running++
    else counts[d.outcome ?? 'unknown']++
  }
  return counts
}

// ---------- задача ----------

/**
 * Статистика задачи (`stats:task`, docs/architecture.md → «Статистика задачи → Откуда каждая метрика»).
 * Расход — сессии задачи и её проверок (`Task.gateFor`); ожидание человека и вопросы — тоже по обоим.
 */
export function buildTaskStats(input: TaskStatsInput): TaskStats {
  const { now, columns } = input
  const task = input.tasks.find((t) => t.id === input.taskId)
  if (!task) throw new Error(`статистика: задачи ${input.taskId} нет в проекте`)
  const kindOf = (status: string | undefined): ColumnKind | undefined => columns.find((c) => c.id === status)?.kind
  const gates = input.tasks.filter((t) => t.gateFor?.taskId === task.id)
  const ids = new Set([task.id, ...gates.map((g) => g.id)])

  const time = timeline({
    createdAt: task.createdAt, updatedAt: task.updatedAt, status: task.status, history: task.statusHistory,
    doneFallback: task.doneAt, now, columns, kindOf
  })
  const active = taskActiveTime(task)

  const dispatches = input.dispatches.filter((d) => ids.has(d.taskId))
  const usage = new Acc()
  const byRole = new Group()
  const byModel = new Group()
  feedSessions(statsSessions({ tasks: input.tasks, runs: [], dispatches }), input, byModel, (s) => [
    usage, byRole.get(s.roleId, () => input.roleTitle?.(s.roleId) ?? s.roleId)
  ])

  const requests = input.requests.filter((r) => ids.has(r.taskId))
  const approvalRejects = requests.filter((r) => r.kind === 'approval' && r.resolution?.action === 'reject').length
  const clarifies = requests.filter((r) => r.kind === 'answer' && r.resolution?.action === 'clarify').length
  const stageHistory = task.stageHistory
  // Отказ человека на ноде human тоже идёт исходом reject: он уже посчитан как approval, гейту его не приписываем.
  const stageRejects = stageHistory?.filter((h) => h.outcome === 'reject').length ?? 0
  const manual = stageHistory?.length
    // В воркфлоу возврат вручную — вход в первый этап с `restart` (`enterWork`): с ревью, из done.
    ? stageHistory.filter((h) => h.outcome === 'restart').length
    : reviewToReady(task.statusHistory, kindOf)
  const questions = input.questions.filter((q) => ids.has(q.taskId) && !q.forHuman)
  const answerMedianMs = median(questions.filter((q) => q.answeredAt !== undefined).map((q) => Math.max(0, q.answeredAt! - q.createdAt)))

  return {
    taskId: task.id,
    generatedAt: now,
    lifetime: time.lifetime,
    ...(time.leadMs !== undefined ? { leadMs: time.leadMs } : {}),
    ...(active ? { activeMs: activeDuration(active, now) } : {}),
    columns: time.columns,
    ...(stageHistory ? { stages: stageTimes(stageHistory, time.until, input.workflow) } : {}),
    usage: usage.usage(),
    byRole: byRole.rows(),
    byModel: byModel.rows(),
    dispatches: dispatchCounts(dispatches),
    rejections: {
      gate: Math.max(0, stageRejects - approvalRejects),
      approval: approvalRejects,
      clarify: clarifies,
      // У задачи-ответа «Уточнить» с ревью — это и переход review → ready, но не второй возврат.
      manual: task.answerFor && !stageHistory?.length ? Math.max(0, manual - clarifies) : manual
    },
    human: waitStats(requests, now),
    coordinatorQuestions: { count: questions.length, ...(answerMedianMs !== undefined ? { answerMedianMs } : {}) }
  }
}

/** Переходы ревью → ready по истории статусов: возврат задачи вне воркфлоу (записи миграции не считаются). */
function reviewToReady(history: StatusChange[] | undefined, kindOf: (status: string | undefined) => ColumnKind | undefined): number {
  let n = 0
  for (let i = 1; i < (history?.length ?? 0); i++) {
    const h = history![i]
    if (!h.migrated && kindOf(history![i - 1].status) === 'review' && kindOf(h.status) === 'ready') n++
  }
  return n
}

// ---------- глобальная задача ----------

/**
 * Статистика глобальной задачи (`stats:global`): время и ожидание — как у задачи (по `Run.statusHistory` и запросам
 * прогона); расход — координатор и подзадачи раздельно, проверка подзадачи входит в строку проверяемой подзадачи.
 */
export function buildGlobalTaskStats(input: GlobalTaskStatsInput): GlobalTaskStats {
  const { now, columns } = input
  const run = input.runs.find((r) => r.id === input.runId)
  if (!run) throw new Error(`статистика: глобальной задачи ${input.runId} нет в проекте`)
  const kindOf = (status: string | undefined): ColumnKind | undefined => columns.find((c) => c.id === status)?.kind
  const status = globalTaskStatus(run.status, columns) ?? run.status

  const time = timeline({
    createdAt: run.createdAt, updatedAt: run.updatedAt ?? run.createdAt, status, history: run.statusHistory,
    doneFallback: run.closedAt, now, columns, kindOf
  })

  const subtasks = input.tasks.filter((t) => t.runId === run.id)
  const work = subtasks.filter((t) => !t.gateFor)
  const taskOf = new Map(subtasks.map((t) => [t.id, t]))
  const ids = new Set(subtasks.map((t) => t.id))
  const dispatches = input.dispatches.filter((d) => ids.has(d.taskId))

  const total = new Acc()
  const coordinator = new Acc()
  const subtasksAcc = new Acc()
  const byRole = new Group()
  const byModel = new Group()
  const byTask = new Group()
  feedSessions(statsSessions({ tasks: input.tasks, runs: [run], dispatches }), input, byModel, (s) => {
    const role = byRole.get(s.roleId, () => input.roleTitle?.(s.roleId) ?? s.roleId)
    if (s.kind === 'coordinator') return [total, coordinator, role]
    const own = s.taskId ? taskOf.get(s.taskId) : undefined
    const key = own?.gateFor?.taskId ?? s.taskId ?? ''
    return [total, subtasksAcc, role, byTask.get(key, () => taskOf.get(key)?.title ?? key)]
  })

  const requests = input.requests.filter((r) => r.runId === run.id)
  const ownActive = run.activeMs !== undefined || run.activeSince !== undefined
    ? activeDuration({ closedMs: run.activeMs ?? 0, ...(run.activeSince !== undefined ? { since: run.activeSince } : {}) }, now)
    : undefined

  return {
    runId: run.id,
    generatedAt: now,
    lifetime: time.lifetime,
    ...(time.leadMs !== undefined ? { leadMs: time.leadMs } : {}),
    ...(ownActive !== undefined ? { ownActiveMs: ownActive } : {}),
    columns: time.columns,
    usage: total.usage(),
    byRole: byRole.rows(),
    byModel: byModel.rows(),
    coordinator: { ...coordinator.usage(), launches: run.coordinatorSessions?.length ?? 0 },
    subtasks: {
      ...subtasksAcc.usage(),
      count: work.length,
      done: work.filter((t) => kindOf(t.status) === 'done').length
    },
    returns: run.returns?.length ?? 0,
    byTask: byTask.rows(),
    human: waitStats(requests, now)
  }
}
