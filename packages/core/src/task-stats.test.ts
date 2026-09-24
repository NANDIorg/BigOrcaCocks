import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildGlobalTaskStats, buildTaskStats, historySpans, mergeSpans, type TaskStatsInput } from './task-stats.ts'
import { buildProjectStats, type SessionUsage, type StatsSession, type UsageRecord } from './stats.ts'
import { STATUS_HISTORY_LIMIT } from './status-history.ts'
import type { Workflow } from './workflow.ts'
import {
  DEFAULT_COLUMNS, type Dispatch, type HumanRequest, type Question, type Run, type StageChange, type StatusChange, type Task
} from './types.ts'

const H = 3_600_000
const T0 = Date.UTC(2026, 8, 1)
const at = (h: number): number => T0 + h * H
const now = at(100)

function task(p: Partial<Task> & Pick<Task, 'id'>): Task {
  return { title: p.id, spec: '', status: 'backlog', priority: 'normal', deps: [], roleId: 'developer', agent: 'claude', createdAt: at(0), updatedAt: at(0), ...p }
}

/** История статусов из пар «колонка, час». */
function history(...steps: Array<[string, number] | [string, number, Partial<StatusChange>]>): StatusChange[] {
  return steps.map(([status, h, extra]) => ({ status, at: at(h), by: 'app' as const, ...extra }))
}

function stages(...steps: Array<[string, number] | [string, number, Partial<StageChange>]>): StageChange[] {
  return steps.map(([nodeId, h, extra]) => ({ nodeId, at: at(h), by: 'workflow' as const, ...extra }))
}

function dispatch(p: Partial<Dispatch> & Pick<Dispatch, 'id' | 'taskId'>): Dispatch {
  return { ptyId: `pty-${p.id}`, startedAt: at(0), ...p }
}

function request(p: Partial<HumanRequest> & Pick<HumanRequest, 'id' | 'taskId' | 'kind' | 'createdAt'>): HumanRequest {
  return { runId: 'r1', status: 'resolved', title: p.id, options: [], ...p }
}

function rec(h: number, model: string, input: number, output = 0): UsageRecord {
  return { at: at(h), model, input, output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }
}

function input(taskId: string, p: Partial<TaskStatsInput> = {}): TaskStatsInput {
  return { taskId, now, tasks: [], runs: [], dispatches: [], requests: [], questions: [], columns: DEFAULT_COLUMNS, ...p }
}

describe('статистика задачи: интервалы', () => {
  it('historySpans: запись живёт до следующей, последняя — до until, назад не идёт', () => {
    const h = [{ at: 10 }, { at: 30 }, { at: 60 }]
    assert.deepEqual(historySpans(h, 100).map((s) => [s.from, s.to]), [[10, 30], [30, 60], [60, 100]])
    assert.deepEqual(historySpans(h, 40).map((s) => [s.from, s.to]), [[10, 30], [30, 40], [60, 60]])
    assert.deepEqual(historySpans([], 5), [])
  })

  it('mergeSpans: пересекающиеся и соприкасающиеся сливаются, вложенные не удваиваются', () => {
    assert.deepEqual(mergeSpans([{ from: 5, to: 8 }, { from: 0, to: 3 }, { from: 2, to: 4 }, { from: 8, to: 9 }, { from: 6, to: 7 }]),
      [{ from: 0, to: 4 }, { from: 5, to: 9 }])
    assert.deepEqual(mergeSpans([]), [])
  })
})

describe('статистика задачи: время', () => {
  const done = task({
    id: 't1', status: 'done', createdAt: at(0), doneAt: at(7), activeMs: 4 * H, updatedAt: at(7),
    statusHistory: history(['backlog', 0], ['ready', 1], ['in_progress', 2], ['review', 4], ['in_progress', 5], ['review', 6], ['done', 7])
  })

  it('done: жизнь до последнего входа в done, лид от первого in_progress, колонки суммируют заходы', () => {
    const s = buildTaskStats(input('t1', { tasks: [done] }))
    assert.deepEqual(s.lifetime, { ms: 7 * H })
    assert.equal(s.leadMs, 5 * H)
    assert.equal(s.activeMs, 4 * H)
    assert.deepEqual(s.columns, [
      { status: 'backlog', ms: H, entries: 1 },
      { status: 'ready', ms: H, entries: 1 },
      { status: 'in_progress', ms: 3 * H, entries: 2 },
      { status: 'review', ms: 2 * H, entries: 2 },
      // Время «в done» после приёмки не растёт: это не затраты задачи.
      { status: 'done', ms: 0, entries: 1 }
    ])
  })

  it('не done: идёт до now, running, лида нет, идущий отрезок работы включён в activeMs', () => {
    const t = task({
      id: 't2', status: 'in_progress', createdAt: at(10), activeMs: H, activeSince: at(98),
      statusHistory: history(['ready', 10], ['in_progress', 98])
    })
    const s = buildTaskStats(input('t2', { tasks: [t] }))
    assert.deepEqual(s.lifetime, { ms: 90 * H, running: true })
    assert.equal(s.leadMs, undefined)
    assert.ok(!('leadMs' in s))
    assert.equal(s.activeMs, 3 * H)
    assert.deepEqual(s.columns.map((c) => [c.status, c.ms]), [['ready', 88 * H], ['in_progress', 2 * H]])
  })

  it('задача была в done и переоткрыта: считается как не done', () => {
    const t = task({ id: 't3', status: 'ready', statusHistory: history(['in_progress', 1], ['done', 2], ['ready', 3]) })
    const s = buildTaskStats(input('t3', { tasks: [t] }))
    assert.equal(s.lifetime.running, true)
    assert.equal(s.lifetime.ms, 100 * H)
  })

  it('migrated: done по doneAt и запись миграции — приближённо, лида и точного времени нет', () => {
    const t = task({
      id: 't4', status: 'done', createdAt: at(0), doneAt: at(20), updatedAt: at(50),
      statusHistory: history(['done', 50, { migrated: true }])
    })
    const s = buildTaskStats(input('t4', { tasks: [t] }))
    assert.deepEqual(s.lifetime, { ms: 20 * H, approx: true })
    assert.equal(s.leadMs, undefined)
    assert.deepEqual(s.columns, [{ status: 'done', ms: 0, entries: 1, approx: true }])
  })

  it('migrated не done: колонка миграции приближённая, остальные точные', () => {
    const t = task({
      id: 't5', status: 'in_progress', updatedAt: at(40),
      statusHistory: history(['in_progress', 40, { migrated: true }])
    })
    const s = buildTaskStats(input('t5', { tasks: [t] }))
    assert.deepEqual(s.columns, [{ status: 'in_progress', ms: 60 * H, entries: 1, approx: true }])
    assert.deepEqual(s.lifetime, { ms: 100 * H, running: true })
  })

  it('обрезанная история: все колонки приближённые', () => {
    const steps: Array<[string, number]> = []
    for (let i = 0; i < STATUS_HISTORY_LIMIT; i++) steps.push([i % 2 ? 'review' : 'in_progress', i * 0.1])
    const t = task({ id: 't6', status: 'review', statusHistory: history(...steps) })
    const s = buildTaskStats(input('t6', { tasks: [t] }))
    assert.equal(t.statusHistory?.length, STATUS_HISTORY_LIMIT)
    assert.ok(s.columns.length === 2 && s.columns.every((c) => c.approx === true))
    assert.equal(s.columns.reduce((sum, c) => sum + c.entries, 0), STATUS_HISTORY_LIMIT)
  })

  it('нет истории: колонок нет, время работы неизвестно — не ноль', () => {
    const s = buildTaskStats(input('t7', { tasks: [task({ id: 't7' })] }))
    assert.deepEqual(s.columns, [])
    assert.ok(!('activeMs' in s))
    assert.ok(!('stages' in s))
  })

  it('порядок колонок — как на доске, удалённая колонка — в конце', () => {
    const t = task({ id: 't8', status: 'review', statusHistory: history(['gone', 0], ['review', 1], ['backlog', 2], ['review', 3]) })
    const s = buildTaskStats(input('t8', { tasks: [t] }))
    assert.deepEqual(s.columns.map((c) => c.status), ['backlog', 'review', 'gone'])
  })

  it('неизвестной задачи нет — ошибка по-русски', () => {
    assert.throws(() => buildTaskStats(input('nope')), /статистика: задачи nope нет в проекте/)
    assert.throws(() => buildGlobalTaskStats({ ...input('x'), runId: 'nope' }), /глобальной задачи nope нет в проекте/)
  })
})

describe('статистика задачи: этапы', () => {
  const wf: Workflow = {
    version: 1,
    nodes: [{ id: 'g', type: 'gate', roleId: 'reviewer', x: 0, y: 0, title: 'Проверка кода' }],
    edges: []
  }
  const t = task({
    id: 't1', status: 'done', updatedAt: at(7), doneAt: at(7),
    statusHistory: history(['in_progress', 2], ['review', 4], ['in_progress', 5], ['review', 6], ['done', 7]),
    stageHistory: stages(['w', 2, { title: 'Работа', outcome: 'next' }], ['g', 4, { outcome: 'next', from: 'w' }],
      ['w', 5, { title: 'Работа', outcome: 'reject', from: 'g' }], ['g', 6, { outcome: 'next', from: 'w' }],
      ['e', 7, { title: 'Конец', outcome: 'accept', from: 'g' }])
  })

  it('заходы суммируются, порядок — по первому заходу, название — из графа, если в записи нет', () => {
    const s = buildTaskStats(input('t1', { tasks: [t], workflow: wf }))
    assert.deepEqual(s.stages, [
      { nodeId: 'w', title: 'Работа', ms: 3 * H, entries: 2 },
      { nodeId: 'g', title: 'Проверка кода', ms: 2 * H, entries: 2 },
      { nodeId: 'e', title: 'Конец', ms: 0, entries: 1 }
    ])
    assert.equal(buildTaskStats(input('t1', { tasks: [t] })).stages?.[1].title, 'g')
  })

  it('запись миграции — этап приближённый', () => {
    const m = task({ id: 't2', status: 'in_progress', stageHistory: stages(['w', 40, { migrated: true }]) })
    assert.deepEqual(buildTaskStats(input('t2', { tasks: [m] })).stages, [{ nodeId: 'w', title: 'w', ms: 60 * H, entries: 1, approx: true }])
  })
})

describe('статистика задачи: расход', () => {
  const t1 = task({ id: 't1', status: 'done', runId: 'r1', statusHistory: history(['done', 9]) })
  const gate = task({ id: 'g1', status: 'done', runId: 'r1', gateFor: { taskId: 't1', nodeId: 'g' }, roleId: 'reviewer' })
  const other = task({ id: 't2', runId: 'r1' })
  const dispatches = [
    dispatch({ id: 'd1', taskId: 't1', startedAt: at(2), endedAt: at(4), outcome: 'done', roleId: 'developer', sessionId: 's1' }),
    dispatch({ id: 'd2', taskId: 'g1', startedAt: at(4), endedAt: at(5), outcome: 'done', roleId: 'reviewer', sessionId: 's2' }),
    dispatch({ id: 'd3', taskId: 't2', startedAt: at(2), endedAt: at(30), outcome: 'done' }),
    dispatch({ id: 'd4', taskId: 't1', startedAt: at(6), endedAt: at(7), outcome: 'failed', roleId: 'developer' })
  ]
  const transcripts: Record<string, SessionUsage> = {
    d1: { records: [rec(3, 'claude-opus-5', 1_000_000, 100_000)] },
    d2: { records: [rec(4.5, 'claude-opus-5', 2_000_000)] },
    d3: { records: [rec(5, 'claude-opus-5', 9_000_000)] }
  }
  const base = { tasks: [t1, gate, other], dispatches, usage: (s: StatsSession): SessionUsage | undefined => transcripts[s.key] }

  it('в статистику проверяемой задачи входят сессии её проверок, чужие — нет', () => {
    const s = buildTaskStats(input('t1', base))
    assert.equal(s.usage.sessions, 3)
    assert.equal(s.usage.sessionsWithUsage, 2)
    assert.equal(s.usage.agentMs, 4 * H)
    assert.deepEqual(s.usage.tokens, { input: 3_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 })
    // opus-5: $5 вход, $25 выход за миллион
    assert.equal(s.usage.costUsd, 15 + 2.5)
    assert.deepEqual(s.byRole.map((r) => [r.key, r.sessions]).sort(), [['developer', 2], ['reviewer', 1]])
    assert.deepEqual(s.dispatches, { total: 3, done: 2, failed: 1, unknown: 0, running: 0 })
    assert.equal(s.dispatches.total, s.usage.sessions)
  })

  it('сама проверка тоже считается как задача: без чужих сессий', () => {
    const s = buildTaskStats(input('g1', base))
    assert.equal(s.usage.sessions, 1)
    assert.equal(s.byModel[0].key, 'claude-opus-5')
  })

  it('неизвестно ≠ 0: нет транскриптов — токенов и стоимости нет, а не нули; сессии посчитаны', () => {
    const s = buildTaskStats(input('t1', { ...base, usage: undefined }))
    assert.equal(s.usage.tokens, undefined)
    assert.equal(s.usage.costUsd, undefined)
    assert.equal(s.usage.sessions, 3)
    assert.equal(s.usage.sessionsWithUsage, 0)
    assert.equal(s.usage.agentMs, 4 * H)
  })

  it('задача без запусков: токены неизвестны, dispatch-ов нет', () => {
    const s = buildTaskStats(input('t2', { tasks: [other] }))
    assert.equal(s.usage.tokens, undefined)
    assert.equal(s.usage.sessions, 0)
    assert.deepEqual(s.dispatches, { total: 0, done: 0, failed: 0, unknown: 0, running: 0 })
  })

  it('идущая сессия — до now, упавшая без конца и транскрипта — 0 мс', () => {
    const running = dispatch({ id: 'r', taskId: 't2', startedAt: at(90) })
    const dead = dispatch({ id: 'x', taskId: 't2', startedAt: at(10) })
    const s = buildTaskStats(input('t2', { tasks: [other], dispatches: [running, dead], isAlive: (p) => p === 'pty-r' }))
    assert.equal(s.usage.agentMs, 10 * H)
    assert.deepEqual(s.dispatches, { total: 2, done: 0, failed: 0, unknown: 0, running: 2 })
  })

  it('outcome unknown (закрыт миграцией): конец — min(endedAt, последнее сообщение транскрипта)', () => {
    const d = dispatch({ id: 'u', taskId: 't2', startedAt: at(10), endedAt: at(90), outcome: 'unknown' })
    const withTranscript = buildTaskStats(input('t2', { tasks: [other], dispatches: [d], usage: () => ({ records: [rec(12, 'claude-opus-5', 1)], lastAt: at(13) }) }))
    assert.equal(withTranscript.usage.agentMs, 3 * H)
    assert.equal(withTranscript.dispatches.unknown, 1)
    // Транскрипта нет — берём endedAt как есть.
    assert.equal(buildTaskStats(input('t2', { tasks: [other], dispatches: [d] })).usage.agentMs, 80 * H)
    // У обычного завершённого dispatch endedAt не трогаем, даже если агент писал позже.
    const done = dispatch({ id: 'n', taskId: 't2', startedAt: at(10), endedAt: at(11), outcome: 'done' })
    assert.equal(buildTaskStats(input('t2', { tasks: [other], dispatches: [done], usage: () => ({ records: [], lastAt: at(50) }) })).usage.agentMs, H)
  })

  it('проектная статистика тот же unknown-dispatch не трогает', () => {
    const d = dispatch({ id: 'u', taskId: 't2', startedAt: at(10), endedAt: at(90), outcome: 'unknown' })
    const p = buildProjectStats({
      projectId: 'p', range: 'all', now, tasks: [other], runs: [], dispatches: [d], columns: DEFAULT_COLUMNS,
      usage: () => ({ records: [], lastAt: at(13) })
    })
    assert.equal(p.totals.agentMs, 80 * H)
  })
})

describe('статистика задачи: ожидание человека', () => {
  const t = task({ id: 't1', runId: 'r1', status: 'needs_input' })

  it('параллельные запросы объединяются, а не складываются; по видам — отдельно', () => {
    const requests = [
      request({ id: 'a', taskId: 't1', kind: 'question', createdAt: at(10), resolvedAt: at(14) }),
      request({ id: 'b', taskId: 't1', kind: 'approval', createdAt: at(12), resolvedAt: at(16) }),
      request({ id: 'c', taskId: 't1', kind: 'escalation', createdAt: at(20), resolvedAt: at(21) })
    ]
    const h = buildTaskStats(input('t1', { tasks: [t], requests })).human
    assert.equal(h.waitingMs, 7 * H) // 10–16 и 20–21
    assert.deepEqual(h.byKind.question, { count: 1, waitingMs: 4 * H })
    assert.deepEqual(h.byKind.approval, { count: 1, waitingMs: 4 * H })
    assert.deepEqual(h.byKind.answer, { count: 0, waitingMs: 0 })
    assert.equal(h.resolved, 3)
    assert.equal(h.reactionMedianMs, 4 * H)
    assert.equal(h.reactionMaxMs, 4 * H)
  })

  it('идущий запрос — до now и не в реакции; отменённый считается ожиданием, но не реакцией', () => {
    const requests = [
      request({ id: 'a', taskId: 't1', kind: 'question', status: 'pending', createdAt: at(90) }),
      request({ id: 'b', taskId: 't1', kind: 'escalation', status: 'cancelled', createdAt: at(10), resolvedAt: at(12) }),
      request({ id: 'c', taskId: 't1', kind: 'answer', createdAt: at(50), resolvedAt: at(51) }),
      request({ id: 'd', taskId: 't1', kind: 'answer', createdAt: at(60), resolvedAt: at(63) })
    ]
    const h = buildTaskStats(input('t1', { tasks: [t], requests })).human
    assert.equal(h.pending, 1)
    assert.equal(h.cancelled, 1)
    assert.equal(h.resolved, 2)
    assert.equal(h.waitingMs, 10 * H + 2 * H + H + 3 * H)
    assert.equal(h.reactionMedianMs, 2 * H) // медиана из 1 ч и 3 ч
    assert.equal(h.reactionMaxMs, 3 * H)
  })

  it('нет запросов: нули и без полей реакции; чужие запросы не входят', () => {
    const foreign = request({ id: 'z', taskId: 't9', kind: 'question', createdAt: at(1), resolvedAt: at(5) })
    const h = buildTaskStats(input('t1', { tasks: [t], requests: [foreign] })).human
    assert.equal(h.waitingMs, 0)
    assert.equal(h.resolved + h.cancelled + h.pending, 0)
    assert.ok(!('reactionMedianMs' in h) && !('reactionMaxMs' in h))
  })

  it('запросы проверки задачи входят в ожидание проверяемой', () => {
    const gate = task({ id: 'g1', runId: 'r1', gateFor: { taskId: 't1', nodeId: 'g' } })
    const requests = [request({ id: 'g', taskId: 'g1', kind: 'escalation', createdAt: at(5), resolvedAt: at(6) })]
    assert.equal(buildTaskStats(input('t1', { tasks: [t, gate], requests })).human.waitingMs, H)
  })

  it('вопросы координатору: только не адресованные человеку, медиана по отвеченным', () => {
    const q = (id: string, p: Partial<Question>): Question => ({ id, taskId: 't1', question: id, options: [], createdAt: at(10), ...p })
    const questions = [
      q('a', { answeredAt: at(11) }), q('b', { answeredAt: at(14) }), q('c', {}), q('d', { forHuman: true, answeredAt: at(99) }), q('e', { taskId: 'zz' })
    ]
    const s = buildTaskStats(input('t1', { tasks: [t], questions }))
    assert.deepEqual(s.coordinatorQuestions, { count: 3, answerMedianMs: 2.5 * H })
    assert.deepEqual(buildTaskStats(input('t1', { tasks: [t] })).coordinatorQuestions, { count: 0 })
  })
})

describe('статистика задачи: возвраты', () => {
  it('гейт: отказы по stageHistory; отказ человека на approval — отдельно, гейту не приписывается', () => {
    const t = task({
      id: 't1', runId: 'r1', status: 'in_progress',
      stageHistory: stages(['w', 1, { outcome: 'next' }], ['g', 2, { outcome: 'next' }], ['w', 3, { outcome: 'reject', from: 'g' }],
        ['g', 4, { outcome: 'next' }], ['w', 5, { outcome: 'reject', from: 'g' }], ['h', 6, { outcome: 'next' }], ['w', 7, { outcome: 'reject', from: 'h' }])
    })
    const requests = [request({ id: 'a', taskId: 't1', kind: 'approval', nodeId: 'h', createdAt: at(6), resolvedAt: at(7), resolution: { action: 'reject', text: 'нет' } })]
    const r = buildTaskStats(input('t1', { tasks: [t], requests })).rejections
    assert.deepEqual(r, { gate: 2, approval: 1, clarify: 0, manual: 0 })
  })

  it('«Принять» approval и решённая эскалация возвратом не считаются', () => {
    const t = task({ id: 't1', runId: 'r1', stageHistory: stages(['w', 1], ['h', 2], ['m', 3, { outcome: 'accept' }]) })
    const requests = [
      request({ id: 'a', taskId: 't1', kind: 'approval', createdAt: at(2), resolvedAt: at(3), resolution: { action: 'accept' } }),
      request({ id: 'b', taskId: 't1', kind: 'escalation', createdAt: at(4), resolvedAt: at(5), resolution: { action: 'restart' } })
    ]
    assert.deepEqual(buildTaskStats(input('t1', { tasks: [t], requests })).rejections, { gate: 0, approval: 0, clarify: 0, manual: 0 })
  })

  it('clarify: «Уточнить» по ответу — один возврат, а не два (ревью → ready того же уточнения не считается)', () => {
    const t = task({
      id: 't1', runId: 'r1', answerFor: 'human', status: 'done',
      statusHistory: history(['in_progress', 1], ['review', 2], ['ready', 3], ['in_progress', 3.5], ['review', 4], ['done', 5])
    })
    const requests = [request({ id: 'a', taskId: 't1', kind: 'answer', createdAt: at(2), resolvedAt: at(3), resolution: { action: 'clarify', text: 'ещё' } })]
    assert.deepEqual(buildTaskStats(input('t1', { tasks: [t], requests })).rejections, { gate: 0, approval: 0, clarify: 1, manual: 0 })
  })

  it('manual вне воркфлоу: ревью → ready по истории статусов, запись миграции не в счёт', () => {
    const t = task({
      id: 't1', status: 'done',
      statusHistory: history(['review', 1, { migrated: true }], ['ready', 2], ['in_progress', 3], ['review', 4], ['ready', 5], ['in_progress', 6], ['review', 7], ['done', 8])
    })
    // Оба перехода настоящие: (1 → 2) стартует с записи миграции, но сам переход в ready уже случился после неё.
    assert.equal(buildTaskStats(input('t1', { tasks: [t] })).rejections.manual, 1 + 1)
    const m = task({ id: 't2', statusHistory: history(['ready', 1], ['review', 2], ['in_progress', 3]) })
    assert.equal(buildTaskStats(input('t2', { tasks: [m] })).rejections.manual, 0)
  })

  it('manual в воркфлоу: вход в первый этап с restart (enterWork), а не review → ready', () => {
    const t = task({
      id: 't1', runId: 'r1',
      statusHistory: history(['in_progress', 1], ['review', 2], ['ready', 3], ['in_progress', 4]),
      stageHistory: stages(['w', 1, { outcome: 'next' }], ['g', 2, { outcome: 'next' }], ['w', 3, { outcome: 'restart', from: 'g' }])
    })
    assert.deepEqual(buildTaskStats(input('t1', { tasks: [t] })).rejections, { gate: 0, approval: 0, clarify: 0, manual: 1 })
  })
})

describe('статистика глобальной задачи', () => {
  const columns = DEFAULT_COLUMNS
  const run: Run = {
    id: 'r1', objective: 'Глобальная', createdAt: at(0), status: 'done', closedAt: at(20), activeMs: 5 * H, activeSince: at(99),
    returns: [{ at: at(15), text: 'ещё' }, { at: at(18), text: 'и это' }],
    statusHistory: history(['backlog', 0], ['in_progress', 2], ['review', 10], ['in_progress', 15], ['review', 18], ['done', 20]),
    coordinatorSessions: [
      { ptyId: 'pc1', roleId: 'coordinator', agent: 'claude', startedAt: at(2), endedAt: at(10), sessionId: 'c1' },
      { ptyId: 'pc2', roleId: 'coordinator', agent: 'claude', startedAt: at(15), endedAt: at(18), sessionId: 'c2' }
    ]
  }
  const t1 = task({ id: 't1', title: 'Первая', runId: 'r1', status: 'done' })
  const t2 = task({ id: 't2', title: 'Вторая', runId: 'r1', status: 'review' })
  const gate = task({ id: 'g1', runId: 'r1', status: 'done', gateFor: { taskId: 't1', nodeId: 'g' }, roleId: 'reviewer' })
  const foreign = task({ id: 't9', runId: 'r2' })
  const dispatches = [
    dispatch({ id: 'd1', taskId: 't1', startedAt: at(3), endedAt: at(5), outcome: 'done' }),
    dispatch({ id: 'd2', taskId: 'g1', startedAt: at(5), endedAt: at(6), outcome: 'done', roleId: 'reviewer' }),
    dispatch({ id: 'd3', taskId: 't2', startedAt: at(6), endedAt: at(7), outcome: 'done' }),
    dispatch({ id: 'd9', taskId: 't9', startedAt: at(6), endedAt: at(70), outcome: 'done' })
  ]
  const transcripts: Record<string, SessionUsage> = {
    'coord:r1:pc1': { records: [rec(3, 'claude-opus-5', 1_000_000)] },
    d1: { records: [rec(4, 'claude-opus-5', 2_000_000)] },
    d2: { records: [rec(5.5, 'claude-opus-5', 1_000_000)] },
    d9: { records: [rec(7, 'claude-opus-5', 50_000_000)] }
  }
  const gin = {
    now, columns, runId: 'r1', runs: [run], tasks: [t1, t2, gate, foreign], dispatches, requests: [] as HumanRequest[], questions: [],
    usage: (s: StatsSession): SessionUsage | undefined => transcripts[s.key]
  }

  it('время: жизнь до done, лид, колонки, своё время с идущим отрезком, возвраты', () => {
    const g = buildGlobalTaskStats(gin)
    assert.deepEqual(g.lifetime, { ms: 20 * H })
    assert.equal(g.leadMs, 18 * H)
    assert.deepEqual(g.columns.map((c) => [c.status, c.ms, c.entries]), [
      ['backlog', 2 * H, 1], ['in_progress', 11 * H, 2], ['review', 7 * H, 2], ['done', 0, 1]
    ])
    assert.equal(g.ownActiveMs, 6 * H)
    assert.equal(g.returns, 2)
    assert.ok(!('taskId' in g) && !('stages' in g) && !('rejections' in g))
  })

  it('расход: координатор и подзадачи раздельно, проверка — в строке проверяемой, чужой прогон не входит', () => {
    const g = buildGlobalTaskStats(gin)
    assert.equal(g.coordinator.launches, 2)
    assert.equal(g.coordinator.sessions, 2)
    assert.equal(g.coordinator.sessionsWithUsage, 1)
    assert.equal(g.coordinator.agentMs, 11 * H)
    assert.equal(g.coordinator.costUsd, 5)
    assert.equal(g.subtasks.sessions, 3)
    assert.equal(g.subtasks.costUsd, 15)
    assert.equal(g.subtasks.count, 2) // проверка — не подзадача
    assert.equal(g.subtasks.done, 1)
    assert.equal(g.usage.sessions, 5)
    assert.equal(g.usage.costUsd, 20)
    assert.deepEqual(g.byTask.map((r) => [r.key, r.title, r.sessions]), [['t1', 'Первая', 2], ['t2', 'Вторая', 1]])
    // Строки подзадач в сумме — расход подзадач.
    assert.equal(g.byTask.reduce((n, r) => n + r.agentMs, 0), g.subtasks.agentMs)
    assert.deepEqual(g.byRole.map((r) => r.key).sort(), ['coordinator', 'developer', 'reviewer'])
  })

  it('«неизвестно ≠ 0»: прогон от кода до статистики — сессий координатора нет, launches 0, токенов нет', () => {
    const old: Run = { id: 'r1', objective: 'старый', createdAt: at(0), status: 'in_progress' }
    const g = buildGlobalTaskStats({ ...gin, runs: [old], tasks: [], dispatches: [], usage: undefined })
    assert.equal(g.coordinator.launches, 0)
    assert.equal(g.coordinator.tokens, undefined)
    assert.equal(g.subtasks.tokens, undefined)
    assert.ok(!('ownActiveMs' in g))
    assert.deepEqual(g.lifetime, { ms: 100 * H, running: true })
  })

  it('ожидание человека — по запросам прогона (всех подзадач), объединённое', () => {
    const requests = [
      request({ id: 'a', taskId: 't1', kind: 'question', createdAt: at(4), resolvedAt: at(6) }),
      request({ id: 'b', taskId: 't2', kind: 'question', createdAt: at(5), resolvedAt: at(8) }),
      request({ id: 'c', taskId: 't9', runId: 'r2', kind: 'question', createdAt: at(4), resolvedAt: at(50) })
    ]
    const g = buildGlobalTaskStats({ ...gin, requests })
    assert.equal(g.human.waitingMs, 4 * H)
    assert.equal(g.human.byKind.question.count, 2)
  })
})
