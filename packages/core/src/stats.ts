/**
 * Статистика проекта (docs/architecture.md, «Статистика»): чистые функции без Node — их использует main
 * (сбор) и renderer (пустое состояние, подписи периода).
 */
import type { BoardColumn, ColumnKind, Dispatch, ModelPrice, ProjectStats, Run, StatsRange, StatsRow, StatsUsage, StatusChange, Task, TokenUsage } from './types.ts'
import { AGENT_TITLES } from './agents.ts'
import { globalTaskStatus, globalTaskTitle } from './global-tasks.ts'
import { MODEL_PRICES, tokensCost, type PricedTokens } from './pricing.ts'

const DAY_MS = 24 * 60 * 60 * 1000

/** Начало периода, epoch ms: скользящее окно от `now`; `all` — без начала. */
export function statsRangeStart(range: StatsRange, now: number): number | undefined {
  if (range === '7d') return now - 7 * DAY_MS
  if (range === '30d') return now - 30 * DAY_MS
  return undefined
}

/** Расход без данных: токенов нет (неизвестно), а не нули. */
export function emptyStatsUsage(): StatsUsage {
  return { unpricedTokens: 0, unpricedModels: [], sessions: 0, sessionsWithUsage: 0, agentMs: 0 }
}

/** Статистика проекта без единой сессии и задачи — пустой проект и заглушка main до реализации сбора. */
export function emptyProjectStats(projectId: string, range: StatsRange, now: number): ProjectStats {
  const from = statsRangeStart(range, now)
  const counts = (): ProjectStats['tasks'] => ({ total: 0, byStatus: {}, created: 0, done: 0 })
  return {
    projectId,
    range,
    ...(from === undefined ? {} : { from }),
    generatedAt: now,
    totals: emptyStatsUsage(),
    tasks: counts(),
    globalTasks: counts(),
    dispatches: { total: 0, done: 0, failed: 0, unknown: 0, running: 0 },
    coordinatorLaunches: 0,
    taskTime: { samples: 0 },
    byRole: [],
    byModel: [],
    byAgent: [],
    byGlobalTask: [],
    byTask: [],
    byDay: []
  }
}

// ---------- сбор ----------

/**
 * Одна ответная реплика API из транскрипта агента: время, модель и токены (запись в кэш — по TTL, для цены).
 * Её читает main (fs), core только складывает.
 */
export interface UsageRecord extends PricedTokens {
  /** Время сообщения, epoch ms. */
  at: number
  /** Id модели из транскрипта; пусто — `unknown`. */
  model: string
}

/** Данные транскрипта одной сессии. Нет объекта — транскрипт не найден («неизвестно»). */
export interface SessionUsage {
  records: UsageRecord[]
  /** Последнее сообщение сессии, epoch ms — конец сессии, если PTY умер без `endedAt`. */
  lastAt?: number
}

/** Сессия агента в проекте: dispatch воркера или запуск координатора (`Run.coordinatorSessions`). */
export interface StatsSession {
  /** Id dispatch или `coord:<runId>:<ptyId>`. */
  key: string
  kind: 'dispatch' | 'coordinator'
  ptyId: string
  roleId: string
  agent: string
  /** Модель из снимка роли (может быть алиасом `opus`); в разбивку идёт, только если транскрипта нет. */
  model?: string
  sessionId?: string
  taskId?: string
  runId?: string
  startedAt: number
  endedAt?: number
}

const UNKNOWN_MODEL = 'unknown'

/**
 * Сессии агентов проекта из снапшота store. dispatch без снимка роли (от кода до статистики) берёт роль и агента
 * задачи; координатор — только из `coordinatorSessions` (у старых прогонов их нет — сессий нет).
 */
export function statsSessions(data: { tasks: Task[]; runs: Run[]; dispatches: Dispatch[] }): StatsSession[] {
  const tasks = new Map(data.tasks.map((t) => [t.id, t]))
  const out: StatsSession[] = []
  for (const d of data.dispatches) {
    const task = tasks.get(d.taskId)
    out.push({
      key: d.id,
      kind: 'dispatch',
      ptyId: d.ptyId,
      roleId: d.roleId ?? task?.roleId ?? UNKNOWN_MODEL,
      agent: d.agent ?? task?.agent ?? UNKNOWN_MODEL,
      ...(d.model ? { model: d.model } : {}),
      ...(d.sessionId ? { sessionId: d.sessionId } : {}),
      taskId: d.taskId,
      ...(task?.runId ? { runId: task.runId } : {}),
      startedAt: d.startedAt,
      ...(d.endedAt !== undefined ? { endedAt: d.endedAt } : {})
    })
  }
  for (const run of data.runs) {
    for (const s of run.coordinatorSessions ?? []) {
      out.push({
        key: `coord:${run.id}:${s.ptyId}`,
        kind: 'coordinator',
        ptyId: s.ptyId,
        roleId: s.roleId,
        agent: s.agent,
        ...(s.model ? { model: s.model } : {}),
        ...(s.sessionId ? { sessionId: s.sessionId } : {}),
        runId: run.id,
        startedAt: s.startedAt,
        ...(s.endedAt !== undefined ? { endedAt: s.endedAt } : {})
      })
    }
  }
  return out
}

/** Вход сбора: снапшот store проекта и то, что знает только main (транскрипты, живые PTY, названия ролей). */
export interface ProjectStatsInput {
  projectId: string
  range: StatsRange
  now: number
  tasks: Task[]
  runs: Run[]
  dispatches: Dispatch[]
  columns: readonly BoardColumn[]
  /** Данные транскрипта сессии; нет функции или `undefined` — «неизвестно». */
  usage?: (s: StatsSession) => SessionUsage | undefined
  /** Жив ли PTY сессии без `endedAt`; по умолчанию — жив (идёт до `now`). */
  isAlive?: (ptyId: string) => boolean
  /** Название роли по id; нет — сам id. */
  roleTitle?: (roleId: string) => string | undefined
  /** Ключ дня `YYYY-MM-DD`; по умолчанию — локальная дата процесса. */
  dayKey?: (ms: number) => string
  prices?: ModelPrice[]
}

/** Локальная дата `YYYY-MM-DD`. */
export function localDayKey(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Накопитель среза: токены «неизвестны», пока не добавили сессию с данными или запись. */
class Acc {
  tokens?: TokenUsage
  cost?: number
  unpricedTokens = 0
  unpricedModels = new Set<string>()
  sessions = 0
  sessionsWithUsage = 0
  agentMs = 0

  known(): TokenUsage {
    this.tokens ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    return this.tokens
  }

  record(r: UsageRecord, cost: number | undefined): void {
    const t = this.known()
    t.input += r.input
    t.output += r.output
    t.cacheRead += r.cacheRead
    t.cacheWrite += r.cacheWrite5m + r.cacheWrite1h
    if (cost === undefined) {
      this.unpricedTokens += recordTotal(r)
      this.unpricedModels.add(r.model)
    } else this.cost = (this.cost ?? 0) + cost
  }

  session(withUsage: boolean, ms: number): void {
    this.sessions++
    if (withUsage) {
      this.sessionsWithUsage++
      this.known()
    }
    this.agentMs += ms
  }

  usage(): StatsUsage {
    return {
      ...(this.tokens ? { tokens: { ...this.tokens } } : {}),
      ...(this.cost !== undefined ? { costUsd: this.cost } : {}),
      unpricedTokens: this.unpricedTokens,
      unpricedModels: [...this.unpricedModels].sort(),
      sessions: this.sessions,
      sessionsWithUsage: this.sessionsWithUsage,
      agentMs: this.agentMs
    }
  }
}

function recordTotal(r: PricedTokens): number {
  return r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h
}

function tokensTotal(t: TokenUsage | undefined): number {
  return t ? t.input + t.output + t.cacheRead + t.cacheWrite : -1
}

/** Порядок строк разбивок: стоимость → токены → время агентов, по убыванию; при равенстве — по ключу. */
function compareRows(a: StatsRow, b: StatsRow): number {
  return (b.costUsd ?? -1) - (a.costUsd ?? -1) ||
    tokensTotal(b.tokens) - tokensTotal(a.tokens) ||
    b.agentMs - a.agentMs ||
    a.key.localeCompare(b.key)
}

/** Группа накопителей по ключу (роль, модель…) с подписью. */
class Group {
  private accs = new Map<string, { acc: Acc; title: string }>()

  get(key: string, title: () => string): Acc {
    let e = this.accs.get(key)
    if (!e) {
      e = { acc: new Acc(), title: title() }
      this.accs.set(key, e)
    }
    return e.acc
  }

  rows(): StatsRow[] {
    return [...this.accs].map(([key, e]) => ({ key, title: e.title, ...e.acc.usage() })).sort(compareRows)
  }
}

/**
 * Момент входа в kind=done в периоде: последний такой переход по истории. Запись миграции (`migrated`) —
 * «была в done уже тогда», момент входа — `fallback` (`doneAt` / `closedAt`); истории нет — тоже `fallback`.
 */
function doneInPeriod(
  history: StatusChange[] | undefined,
  fallback: number | undefined,
  kindOf: (status: string) => ColumnKind | undefined,
  from: number,
  now: number
): number | undefined {
  const inPeriod = (at: number | undefined): at is number => at !== undefined && at >= from && at <= now
  if (!history) return inPeriod(fallback) ? fallback : undefined
  let found: number | undefined
  for (const h of history) {
    if (kindOf(h.status) !== 'done') continue
    const at = h.migrated ? fallback : h.at
    if (inPeriod(at)) found = at
  }
  return found
}

/**
 * Статистика проекта (`stats:project`, docs/architecture.md → «Статистика → Откуда каждая метрика»). Чистая
 * функция: транскрипты читает main и отдаёт через `usage`.
 */
export function buildProjectStats(input: ProjectStatsInput): ProjectStats {
  const { now, columns } = input
  const stats = emptyProjectStats(input.projectId, input.range, now)
  const from = stats.from ?? -Infinity
  const prices = input.prices ?? MODEL_PRICES
  const dayKey = input.dayKey ?? localDayKey
  const isAlive = input.isAlive ?? ((): boolean => true)
  const kindOf = (status: string): ColumnKind | undefined => columns.find((c) => c.id === status)?.kind
  const inPeriod = (at: number): boolean => at >= from && at <= now
  const tasks = new Map(input.tasks.map((t) => [t.id, t]))
  const runs = new Map(input.runs.map((r) => [r.id, r]))

  // ---- задачи и глобальные задачи ----
  const days = new Map<string, { acc: Acc; tasksDone: number; models: Map<string, Acc> }>()
  const day = (key: string): { acc: Acc; tasksDone: number; models: Map<string, Acc> } => {
    let d = days.get(key)
    if (!d) {
      d = { acc: new Acc(), tasksDone: 0, models: new Map() }
      days.set(key, d)
    }
    return d
  }
  let activeSum = 0
  let activeN = 0
  let leadSum = 0
  let leadN = 0
  for (const t of input.tasks) {
    stats.tasks.total++
    stats.tasks.byStatus[t.status] = (stats.tasks.byStatus[t.status] ?? 0) + 1
    if (inPeriod(t.createdAt)) stats.tasks.created++
    const doneAt = doneInPeriod(t.statusHistory, t.doneAt, kindOf, from, now)
    if (doneAt === undefined) continue
    stats.tasks.done++
    stats.taskTime.samples++
    day(dayKey(doneAt)).tasksDone++
    if (t.activeMs !== undefined) {
      activeSum += t.activeMs
      activeN++
    }
    const start = t.statusHistory?.find((h) => !h.migrated && h.at <= doneAt && kindOf(h.status) === 'in_progress')
    const doneEntry = t.statusHistory?.some((h) => !h.migrated && h.at === doneAt)
    if (start && doneEntry) {
      leadSum += doneAt - start.at
      leadN++
    }
  }
  if (activeN > 0) stats.taskTime.avgActiveMs = activeSum / activeN
  if (leadN > 0) stats.taskTime.avgLeadMs = leadSum / leadN
  for (const r of input.runs) {
    if (r.inbox) continue
    stats.globalTasks.total++
    const status = globalTaskStatus(r.status, columns) ?? r.status ?? UNKNOWN_MODEL
    stats.globalTasks.byStatus[status] = (stats.globalTasks.byStatus[status] ?? 0) + 1
    if (inPeriod(r.createdAt)) stats.globalTasks.created++
    if (doneInPeriod(r.statusHistory, r.closedAt, kindOf, from, now) !== undefined) stats.globalTasks.done++
  }

  // ---- прогоны агентов ----
  for (const d of input.dispatches) {
    if (!inPeriod(d.startedAt)) continue
    stats.dispatches.total++
    if (d.endedAt === undefined) stats.dispatches.running++
    else stats.dispatches[d.outcome ?? 'unknown']++
  }

  // ---- сессии и токены ----
  const totals = new Acc()
  const byRole = new Group()
  const byModel = new Group()
  const byAgent = new Group()
  const byGlobal = new Group()
  const byTask = new Group()
  const modelTitle = (m: string): string => (m === UNKNOWN_MODEL ? 'Модель неизвестна' : m)
  for (const s of statsSessions(input)) {
    if (s.kind === 'coordinator' && inPeriod(s.startedAt)) stats.coordinatorLaunches++
    const usage = input.usage?.(s)
    const end = s.endedAt ?? (isAlive(s.ptyId) ? now : usage?.lastAt)
    const clippedEnd = Math.min(end ?? s.startedAt, now)
    // Агент мог писать и после `endedAt` (dispatch закрыт `done`, а терминал жив) — такие записи тоже в периоде.
    const lastActivity = Math.max(clippedEnd, Math.min(usage?.lastAt ?? -Infinity, now))
    if (s.startedAt > now || lastActivity < from) continue
    const ms = end === undefined ? 0 : Math.max(0, clippedEnd - Math.max(s.startedAt, from))
    const task = s.taskId ? tasks.get(s.taskId) : undefined
    const run = s.runId ? runs.get(s.runId) : undefined
    const slices: Acc[] = [
      totals,
      byRole.get(s.roleId, () => input.roleTitle?.(s.roleId) ?? s.roleId),
      byAgent.get(s.agent, () => (AGENT_TITLES as Record<string, string>)[s.agent] ?? s.agent),
      ...(s.runId ? [byGlobal.get(s.runId, () => (run ? globalTaskTitle(run) : s.runId ?? ''))] : []),
      ...(s.taskId ? [byTask.get(s.taskId, () => task?.title ?? s.taskId ?? '')] : [])
    ]
    // Модель сессии для счётчика и времени — та, что потратила больше всего токенов; транскрипта нет — снимок роли.
    const perModel = new Map<string, number>()
    for (const r of usage?.records ?? []) perModel.set(r.model || UNKNOWN_MODEL, (perModel.get(r.model || UNKNOWN_MODEL) ?? 0) + recordTotal(r))
    const sessionModel = [...perModel].sort((a, b) => b[1] - a[1])[0]?.[0] ?? s.model ?? UNKNOWN_MODEL
    const startDay = day(dayKey(Math.max(s.startedAt, from)))
    const dayModel = (m: string): Acc => {
      let a = startDay.models.get(m)
      if (!a) startDay.models.set(m, (a = new Acc()))
      return a
    }
    for (const a of [...slices, byModel.get(sessionModel, () => modelTitle(sessionModel)), startDay.acc, dayModel(sessionModel)]) {
      a.session(usage !== undefined, ms)
    }
    for (const r of usage?.records ?? []) {
      if (!inPeriod(r.at)) continue
      const model = r.model || UNKNOWN_MODEL
      const rec = model === r.model ? r : { ...r, model }
      const cost = tokensCost(model, r, prices)
      const d = day(dayKey(r.at))
      let dm = d.models.get(model)
      if (!dm) d.models.set(model, (dm = new Acc()))
      for (const a of [...slices, byModel.get(model, () => modelTitle(model)), d.acc, dm]) a.record(rec, cost)
    }
  }
  stats.totals = totals.usage()
  stats.byRole = byRole.rows()
  stats.byModel = byModel.rows()
  stats.byAgent = byAgent.rows()
  stats.byGlobalTask = byGlobal.rows()
  stats.byTask = byTask.rows()
  const modelOrder = new Map(stats.byModel.map((r, i) => [r.key, i]))
  stats.byDay = [...days]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, d]) => ({
      date,
      tasksDone: d.tasksDone,
      ...d.acc.usage(),
      byModel: [...d.models]
        .map(([key, a]) => ({ key, title: modelTitle(key), ...a.usage() }))
        .sort((a, b) => (modelOrder.get(a.key) ?? Infinity) - (modelOrder.get(b.key) ?? Infinity))
    }))
  return stats
}
