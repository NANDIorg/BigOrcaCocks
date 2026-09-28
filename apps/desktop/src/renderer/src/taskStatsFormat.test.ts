import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_COLUMNS, emptyStatsUsage, type Dispatch, type GlobalTaskStats, type HumanRequest, type Run, type StatsRow, type StatsUsage, type Task, type TaskStats,
  type TaskWaitStats
} from '@orca-board/core'
import { statsStaleMessage } from './statsFormat'
import { setLocale } from './i18n'
import {
  advanceGlobalStats, advanceTaskStats, columnParts, dispatchCounters, fallbackGlobalStats, fallbackTaskStats, globalFacts, globalSides, globalStatsKey,
  humanLine, isStatsRunning, isStatsStale, partLabel, rejectionsTitle, returnsCounter, roleRows, spanLabel, stageParts, taskCounters, taskFacts,
  taskStatsApi, taskStatsKey, topTasks, waitFact, costFact, type StatsSnapshot
} from './taskStatsFormat'

const MIN = 60_000
const H = 60 * MIN
const T0 = Date.UTC(2026, 8, 1)
const NOW = T0 + 10 * H

function usage(p: Partial<StatsUsage> = {}): StatsUsage {
  return { ...emptyStatsUsage(), ...p }
}

const tokens = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }

function wait(p: Partial<TaskWaitStats> = {}): TaskWaitStats {
  const kind = { count: 0, waitingMs: 0 }
  return {
    waitingMs: 0, byKind: { question: { ...kind }, answer: { ...kind }, escalation: { ...kind }, approval: { ...kind }, decision: { ...kind } },
    resolved: 0, cancelled: 0, pending: 0, ...p
  }
}

function taskStats(p: Partial<TaskStats> = {}): TaskStats {
  return {
    taskId: 't1', generatedAt: T0, lifetime: { ms: 2 * H }, columns: [], usage: usage(), byRole: [], byModel: [],
    dispatches: { total: 0, done: 0, failed: 0, unknown: 0, running: 0 },
    rejections: { gate: 0, approval: 0, clarify: 0, manual: 0 }, human: wait(), coordinatorQuestions: { count: 0 }, ...p
  }
}

function globalStats(p: Partial<GlobalTaskStats> = {}): GlobalTaskStats {
  return {
    runId: 'r1', generatedAt: T0, lifetime: { ms: 2 * H }, columns: [], usage: usage(), byRole: [], byModel: [],
    coordinator: { ...usage(), launches: 0 }, subtasks: { ...usage(), count: 0, done: 0 }, returns: 0, byTask: [], human: wait(), ...p
  }
}

// ---------- API и старый main ----------

test('taskStatsApi: старый preload — понятная ошибка, а не «undefined is not a function»', () => {
  assert.throws(() => taskStatsApi(undefined), { message: statsStaleMessage() })
  assert.throws(() => taskStatsApi({ stats: { project: async () => { throw new Error('x') } } } as never), { message: statsStaleMessage() })
  const stats = { project: async () => { throw new Error('x') }, task: async () => { throw new Error('x') }, global: async () => { throw new Error('x') } }
  assert.equal(taskStatsApi({ stats } as never), stats)
})

test('isStatsStale: нет API в preload или обработчика в main', () => {
  assert.equal(isStatsStale(statsStaleMessage()), true)
  assert.equal(isStatsStale("No handler registered for 'stats:task'"), true)
  assert.equal(isStatsStale('статистика: задачи t9 нет в проекте'), false)
})

test('taskStatsApi: на английском ошибка старого preload — английская и узнаётся после смены языка', () => {
  setLocale('en')
  try {
    assert.throws(() => taskStatsApi(undefined), (e: Error) => /Restart the app/.test(e.message) && isStatsStale(e.message))
    const english = statsStaleMessage()
    setLocale('ru')
    assert.equal(isStatsStale(english), true)
  } finally {
    setLocale('ru')
  }
})

// ---------- бегущие значения ----------

test('advanceTaskStats: идущие значения растут на прошедшее с generatedAt', () => {
  const s = taskStats({
    lifetime: { ms: 2 * H, running: true }, activeMs: H, usage: usage({ agentMs: 30 * MIN, sessions: 2 }),
    dispatches: { total: 2, done: 0, failed: 0, unknown: 0, running: 2 },
    columns: [{ status: 'ready', ms: H, entries: 1 }, { status: 'in_progress', ms: H, entries: 1 }], human: wait({ waitingMs: 10 * MIN, pending: 1 })
  })
  const a = advanceTaskStats(s, T0 + 20 * MIN, { activeTicking: true, status: 'in_progress' })
  assert.equal(a.lifetime.ms, 2 * H + 20 * MIN)
  assert.equal(a.lifetime.running, true)
  assert.equal(a.activeMs, H + 20 * MIN)
  assert.deepEqual(a.columns.map((c) => c.ms), [H, H + 20 * MIN], 'растёт только колонка задачи')
  assert.equal(a.usage.agentMs, 30 * MIN + 2 * 20 * MIN, 'каждая идущая сессия — свой отрезок')
  assert.equal(a.human.waitingMs, 30 * MIN)
  assert.equal(s.lifetime.ms, 2 * H, 'исходный объект не меняется')
})

test('advanceTaskStats: не идёт — значения стоят; now раньше generatedAt — без изменений', () => {
  const s = taskStats({
    lifetime: { ms: 5 * H }, activeMs: H, columns: [{ status: 'done', ms: 0, entries: 1 }], human: wait({ waitingMs: MIN, resolved: 1 })
  })
  const a = advanceTaskStats(s, T0 + H, { activeTicking: false, status: 'done' })
  assert.deepEqual([a.lifetime.ms, a.activeMs, a.columns[0].ms, a.human.waitingMs, a.usage.agentMs], [5 * H, H, 0, MIN, 0])
  assert.equal(advanceTaskStats(s, T0 - H, { activeTicking: true, status: 'done' }), s)
  const idle = advanceTaskStats(taskStats({ lifetime: { ms: H, running: true }, activeMs: 3 * H }), T0 + MIN, { activeTicking: false, status: 'ready' })
  assert.equal(idle.activeMs, 3 * H, 'отрезок «в работе» закрыт — не растёт')
  assert.equal('activeMs' in advanceTaskStats(taskStats({ lifetime: { ms: H, running: true } }), T0 + MIN, { activeTicking: true, status: 'x' }), false, 'не бывала в работе — поля нет')
})

test('advanceGlobalStats: своё время, координатор и подзадачи растут по своим признакам', () => {
  const s = globalStats({
    lifetime: { ms: H, running: true }, ownActiveMs: 30 * MIN, usage: usage({ agentMs: H }),
    coordinator: { ...usage({ agentMs: 40 * MIN }), launches: 1 }, subtasks: { ...usage({ agentMs: 20 * MIN }), count: 3, done: 1 },
    columns: [{ status: 'in_progress', ms: H, entries: 1 }]
  })
  const a = advanceGlobalStats(s, T0 + 10 * MIN, { ownTicking: true, status: 'in_progress', coordinatorLive: true, subtasksRunning: 2 })
  assert.equal(a.lifetime.ms, H + 10 * MIN)
  assert.equal(a.ownActiveMs, 40 * MIN)
  assert.equal(a.coordinator.agentMs, 50 * MIN)
  assert.equal(a.subtasks.agentMs, 40 * MIN)
  assert.equal(a.usage.agentMs, H + 30 * MIN)
  const still = advanceGlobalStats(s, T0 + 10 * MIN, { ownTicking: false, status: 'in_progress', coordinatorLive: false, subtasksRunning: 0 })
  assert.equal(still.ownActiveMs, 30 * MIN)
  assert.equal(still.usage.agentMs, H)
})

test('isStatsRunning: идёт жизнь, сессия или ждёт запрос', () => {
  assert.equal(isStatsRunning(taskStats()), false)
  assert.equal(isStatsRunning(taskStats({ lifetime: { ms: 1, running: true } })), true)
  assert.equal(isStatsRunning(taskStats({ dispatches: { total: 1, done: 0, failed: 0, unknown: 0, running: 1 } })), true)
  assert.equal(isStatsRunning(globalStats({ human: wait({ pending: 1 }) })), true)
})

// ---------- факты ----------

test('spanLabel: неточное время с «≈»', () => {
  assert.equal(spanLabel({ ms: 90 * MIN }), '1 ч 30 мин')
  assert.equal(spanLabel({ ms: 90 * MIN, approx: true }), '≈ 1 ч 30 мин')
})

test('costFact: сумма, «не менее», «без цены», «нет данных» — неизвестное не 0', () => {
  assert.deepEqual(costFact(usage({ tokens, costUsd: 1.5, sessions: 2, sessionsWithUsage: 2 })), { value: '$1,50', hint: '2 тыс токенов', title: undefined })
  const partial = costFact(usage({ tokens, costUsd: 1.5, sessions: 3, sessionsWithUsage: 1, unpricedTokens: 100, unpricedModels: ['x-1'] }))
  assert.equal(partial.value, 'не менее $1,50')
  assert.match(partial.hint ?? '', /нет данных по 2 сессиям/)
  assert.match(partial.title ?? '', /x-1/)
  const unpriced = costFact(usage({ tokens, unpricedTokens: 1500, unpricedModels: ['x-1'], sessions: 1, sessionsWithUsage: 1 }))
  assert.equal(unpriced.value, 'без цены')
  assert.equal(unpriced.unknown, true)
  const none = costFact(usage({ sessions: 2 }))
  assert.equal(none.value, 'нет данных')
  assert.equal(none.hint, '2 сессии без данных о токенах')
  assert.equal(costFact(usage()).hint, 'агенты не запускались')
})

test('waitFact: «ждала вас» — время ожидания, а не время человека; без запросов — «не ждала»', () => {
  assert.equal(waitFact(wait()).value, 'не ждала')
  const w = waitFact(wait({ waitingMs: 90 * MIN, resolved: 2 }))
  assert.equal(w.value, '1 ч 30 мин')
  assert.equal(w.hint, '2 запроса')
  assert.equal(w.live, undefined)
  const pending = waitFact(wait({ waitingMs: MIN, pending: 1, resolved: 1 }))
  assert.equal(pending.live, true)
  assert.match(pending.hint ?? '', /ждёт сейчас/)
})

test('taskFacts: пять показателей в заданном порядке', () => {
  const facts = taskFacts(taskStats({
    lifetime: { ms: 3 * H, approx: true }, leadMs: 2 * H, activeMs: H, usage: usage({ tokens, costUsd: 0.5, sessions: 1, sessionsWithUsage: 1, agentMs: 45 * MIN })
  }))
  assert.deepEqual(facts.map((f) => f.label), ['Время жизни', 'В работе', 'Агенты', 'Ждала вас', 'Стоимость'])
  assert.equal(facts[0].value, '≈ 3 ч')
  assert.equal(facts[0].approx, true)
  assert.equal(facts[0].hint, 'от старта до «Готово» 2 ч')
  assert.equal(facts[1].value, '1 ч')
  assert.equal(facts[2].value, '45 мин')
  assert.equal(facts[2].hint, '1 сессия')
  assert.equal(facts[4].value, '$0,50')
})

test('taskFacts: не бывала в работе, агенты не запускались, идёт сейчас', () => {
  const facts = taskFacts(taskStats({ lifetime: { ms: H, running: true } }))
  assert.equal(facts[0].live, true)
  assert.equal(facts[0].hint, 'идёт')
  assert.equal(facts[1].value, 'не бывала')
  assert.equal(facts[1].unknown, true)
  assert.equal(facts[2].value, 'не запускались')
  assert.equal(facts[4].value, 'нет данных')
})

test('globalFacts: своё время неизвестно — «нет данных», не 0', () => {
  const facts = globalFacts(globalStats())
  assert.deepEqual(facts.map((f) => f.label), ['Время жизни', 'Своё время', 'Агенты', 'Ждала вас', 'Стоимость'])
  assert.equal(facts[1].value, 'нет данных')
  assert.equal(facts[1].unknown, true)
  assert.equal(globalFacts(globalStats({ ownActiveMs: 20 * MIN }))[1].value, '20 мин')
})

// ---------- полосы ----------

test('columnParts: цвета и названия колонок доски, доли по времени, неизвестная колонка — серая', () => {
  const parts = columnParts(
    [{ status: 'ready', ms: H, entries: 1 }, { status: 'in_progress', ms: 3 * H, entries: 2, approx: true }, { status: 'gone', ms: 0, entries: 1 }],
    DEFAULT_COLUMNS
  )
  const ready = DEFAULT_COLUMNS.find((c) => c.id === 'ready')!
  assert.deepEqual([parts[0].title, parts[0].color, parts[0].share], [ready.title, ready.color, 0.25])
  assert.equal(parts[1].share, 0.75)
  assert.equal(parts[1].approx, true)
  assert.deepEqual([parts[2].title, parts[2].color, parts[2].share], ['gone', 'var(--s-other)', 0])
  assert.deepEqual(columnParts([], DEFAULT_COLUMNS), [])
  assert.equal(columnParts([{ status: 'ready', ms: 0, entries: 1 }], DEFAULT_COLUMNS)[0].share, 0, 'нулевое время — без деления на ноль')
})

test('stageParts: названия из titles перекрывают отданные main; без titles — как отдал main', () => {
  const stages = [{ nodeId: 'w', title: 'w', ms: H, entries: 1 }, { nodeId: 'x', title: 'Икс', ms: H, entries: 1 }]
  assert.deepEqual(stageParts(stages, { w: 'Реализация' }).map((p) => p.title), ['Реализация', 'Икс'])
  assert.deepEqual(stageParts(stages).map((p) => p.title), ['w', 'Икс'])
})

test('stageParts: цвета по кругу палитры серий; нет этапов — пусто', () => {
  assert.deepEqual(stageParts(undefined), [])
  const parts = stageParts(Array.from({ length: 6 }, (_, i) => ({ nodeId: `n${i}`, title: `Этап ${i}`, ms: H, entries: 1 })))
  assert.deepEqual(parts.map((p) => p.color), ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s1)'])
  assert.equal(parts[0].share, 1 / 6)
})

test('partLabel: заходы называются, только если их больше одного', () => {
  const [one, many] = stageParts([{ nodeId: 'a', title: 'Работа', ms: 30 * MIN, entries: 1 }, { nodeId: 'b', title: 'Проверка', ms: 2 * H, entries: 3, approx: true }])
  assert.equal(partLabel(one), 'Работа — 30 мин')
  assert.equal(partLabel(many), 'Проверка — ≈ 2 ч · 3 захода')
})

// ---------- роли, счётчики ----------

test('roleRows: токены — сумма всех видов, нет данных — undefined', () => {
  const rows: StatsRow[] = [
    { key: 'dev', title: 'Разработчик', ...usage({ tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 9 }, agentMs: H }) },
    { key: 'qa', title: 'QA', ...usage({ sessions: 1 }) }
  ]
  const r = roleRows(rows)
  assert.equal(r[0].tokens, 15)
  assert.equal(r[1].tokens, undefined)
  assert.equal(r[0].agentMs, H)
})

test('dispatchCounters: исходы называются, только если они были', () => {
  assert.deepEqual(dispatchCounters({ total: 0, done: 0, failed: 0, unknown: 0, running: 0 }).map((c) => c.text), ['запусков не было'])
  const c = dispatchCounters({ total: 5, done: 2, failed: 1, unknown: 1, running: 1 })
  assert.deepEqual(c.map((x) => x.text), ['запусков 5', 'сдано 2', 'упало 1', 'вышел без done 1', 'идут сейчас 1'])
  assert.equal(c.find((x) => x.id === 'failed')?.tone, 'warn')
})

test('taskCounters: отказы ревью — сумма возвратов с расшифровкой, вопросы координатору', () => {
  const s = taskStats({
    dispatches: { total: 3, done: 3, failed: 0, unknown: 0, running: 0 },
    rejections: { gate: 2, approval: 1, clarify: 0, manual: 1 }, coordinatorQuestions: { count: 4, answerMedianMs: 5 * MIN }
  })
  const c = taskCounters(s)
  const rej = c.find((x) => x.id === 'rejections')!
  assert.equal(rej.text, 'отказов ревью 4')
  assert.equal(rej.tone, 'warn')
  assert.equal(rej.title, 'отказов проверок 2, «Вернуть» по решению 1, возвратов вручную 1')
  const q = c.find((x) => x.id === 'questions')!
  assert.equal(q.text, 'вопросов координатору 4')
  assert.match(q.title ?? '', /Медиана ответа координатора 5 мин/)
  assert.equal(taskCounters(taskStats()).find((x) => x.id === 'rejections')?.tone, undefined)
  assert.equal(rejectionsTitle({ gate: 0, approval: 0, clarify: 0, manual: 0 }), 'Возвратов на доработку не было')
})

test('humanLine: нет запросов — нет строки; иначе виды, ожидающие и реакция', () => {
  assert.equal(humanLine(wait()), undefined)
  const h = wait({ resolved: 2, pending: 1, cancelled: 1, reactionMedianMs: 3 * MIN, reactionMaxMs: 10 * MIN })
  h.byKind.question.count = 3
  h.byKind.approval.count = 1
  assert.equal(humanLine(h), 'Запросов к вам 4: вопросов 3, решений 1 · ждут ответа 1 · отменено 1 · реакция: медиана 3 мин, дольше всего 10 мин')
})

// ---------- глобальная задача ----------

test('globalSides: координатор и подзадачи раздельно', () => {
  const [c, t] = globalSides(globalStats({
    coordinator: { ...usage({ agentMs: 2 * H, sessions: 2, sessionsWithUsage: 2, tokens, costUsd: 3 }), launches: 2 },
    subtasks: { ...usage({ agentMs: H, sessions: 4 }), count: 3, done: 2 }
  }))
  assert.equal(c.id, 'coordinator')
  assert.deepEqual(c.facts.map((f) => f.value), ['2', '2 ч', '$3,00'])
  assert.equal(t.id, 'subtasks')
  assert.deepEqual(t.facts.map((f) => f.value), ['3', '1 ч', 'нет данных'])
  assert.equal(t.facts[0].hint, 'сделано 2')
})

test('topTasks: первые строки с долей, открыть можно только известные задачи', () => {
  const rows: StatsRow[] = [
    { key: 't1', title: 'A', ...usage({ costUsd: 2, agentMs: H }) },
    { key: 't2', title: 'B', ...usage({ costUsd: 1, agentMs: 2 * H }) },
    { key: 'gone', title: 'C', ...usage({ costUsd: 0.5 }) }
  ]
  const top = topTasks(rows, new Set(['t1', 't2']), 2)
  assert.deepEqual(top.map((r) => [r.key, r.openable, r.share]), [['t1', true, 1], ['t2', true, 0.5]])
  const byTime = topTasks([{ key: 'a', title: 'A', ...usage({ agentMs: H }) }, { key: 'b', title: 'B', ...usage({ agentMs: 2 * H }) }], new Set())
  assert.deepEqual(byTime.map((r) => [r.openable, r.share]), [[false, 0.5], [false, 1]], 'без стоимости — доля по времени агентов')
  assert.deepEqual(topTasks([], new Set()), [])
})

test('returnsCounter: сколько раз вернули с «Проверки»', () => {
  assert.equal(returnsCounter(0).text, 'возвратов не было')
  assert.equal(returnsCounter(0).tone, undefined)
  assert.equal(returnsCounter(1).text, 'возвращена в работу 1 раз')
  assert.equal(returnsCounter(3).text, 'возвращена в работу 3 раза')
  assert.equal(returnsCounter(5).text, 'возвращена в работу 5 раз')
  assert.equal(returnsCounter(2).tone, 'warn')
})

// ---------- ключ перечитывания и запасной расчёт ----------

function task(p: Partial<Task> & Pick<Task, 'id'>): Task {
  return { title: p.id, spec: '', status: 'backlog', priority: 'normal', deps: [], roleId: 'developer', agent: 'claude', createdAt: T0, updatedAt: T0, ...p }
}

function snapshot(p: Partial<StatsSnapshot> = {}): StatsSnapshot {
  return { tasks: [], runs: [], dispatches: [], requests: [], questions: [], columns: DEFAULT_COLUMNS, ...p }
}

const disp = (p: Partial<Dispatch> & Pick<Dispatch, 'id' | 'taskId'>): Dispatch => ({ ptyId: `pty-${p.id}`, startedAt: T0, ...p })

test('taskStatsKey: меняется от своих событий (статус, запуск, запрос, проверка), от чужих — нет', () => {
  const t1 = task({ id: 't1', status: 'in_progress' })
  const gate = task({ id: 'g1', gateFor: { taskId: 't1', nodeId: 'n' } as Task['gateFor'] })
  const other = task({ id: 't2' })
  const base = snapshot({ tasks: [t1, gate, other], dispatches: [disp({ id: 'd1', taskId: 't1' })] })
  const key = taskStatsKey(base, 't1')
  assert.equal(taskStatsKey(snapshot({ ...base, tasks: [t1, gate, task({ id: 't2', status: 'done', updatedAt: T0 + H })] }), 't1'), key, 'чужая задача')
  assert.equal(taskStatsKey(snapshot({ ...base, dispatches: [...base.dispatches, disp({ id: 'd9', taskId: 't2' })] }), 't1'), key, 'чужой запуск')
  assert.notEqual(taskStatsKey(snapshot({ ...base, tasks: [task({ id: 't1', status: 'review', updatedAt: T0 + H }), gate, other] }), 't1'), key, 'статус')
  assert.notEqual(taskStatsKey(snapshot({ ...base, dispatches: [disp({ id: 'd1', taskId: 't1', endedAt: T0 + H, outcome: 'done' })] }), 't1'), key, 'запуск закончился')
  assert.notEqual(taskStatsKey(snapshot({ ...base, dispatches: [...base.dispatches, disp({ id: 'd2', taskId: 'g1' })] }), 't1'), key, 'запуск проверки')
  const req = { id: 'q1', taskId: 't1', runId: 'r1', kind: 'question', status: 'pending', title: 'q', options: [], createdAt: T0 } as HumanRequest
  assert.notEqual(taskStatsKey(snapshot({ ...base, requests: [req] }), 't1'), key, 'запрос')
  assert.notEqual(taskStatsKey(snapshot({ ...base, requests: [{ ...req, status: 'resolved' }] }), 't1'), taskStatsKey(snapshot({ ...base, requests: [req] }), 't1'), 'запрос решён')
})

test('globalStatsKey: статус, возвраты, запуски координатора и подзадачи прогона', () => {
  const run = { id: 'r1', status: 'in_progress', createdAt: T0, updatedAt: T0 } as Run
  const base = snapshot({ runs: [run], tasks: [task({ id: 't1', runId: 'r1' }), task({ id: 't9', runId: 'r2' })] })
  const key = globalStatsKey(base, 'r1')
  assert.equal(globalStatsKey(snapshot({ ...base, tasks: [task({ id: 't1', runId: 'r1' }), task({ id: 't9', runId: 'r2', status: 'done', updatedAt: T0 + H })] }), 'r1'), key, 'чужой прогон')
  assert.notEqual(globalStatsKey(snapshot({ ...base, runs: [{ ...run, status: 'review', updatedAt: T0 + H }] }), 'r1'), key, 'статус прогона')
  assert.notEqual(globalStatsKey(snapshot({ ...base, tasks: [task({ id: 't1', runId: 'r1', status: 'done', updatedAt: T0 + H }), base.tasks[1]] }), 'r1'), key, 'подзадача')
  assert.notEqual(globalStatsKey(snapshot({ ...base, runs: [{ ...run, coordinatorSessions: [{ ptyId: 'p', roleId: 'coordinator', agent: 'claude', startedAt: T0 }] }] }), 'r1'), key, 'координатор')
})

test('fallbackTaskStats: старый main — время есть, токенов нет («неизвестно», не 0)', () => {
  const t = task({
    id: 't1', status: 'in_progress', createdAt: T0, updatedAt: T0 + H, activeMs: H,
    statusHistory: [{ status: 'backlog', at: T0, by: 'app' }, { status: 'in_progress', at: T0 + H, by: 'app' }]
  })
  const s = fallbackTaskStats(snapshot({ tasks: [t], dispatches: [disp({ id: 'd1', taskId: 't1', startedAt: T0 + H })] }), 't1', NOW)
  assert.equal(s.generatedAt, NOW)
  assert.deepEqual(s.lifetime, { ms: 10 * H, running: true })
  assert.deepEqual(s.columns.map((c) => [c.status, c.ms]), [['backlog', H], ['in_progress', 9 * H]])
  assert.equal(s.usage.tokens, undefined)
  assert.equal(s.usage.costUsd, undefined)
  assert.equal(s.usage.sessions, 1)
  assert.equal(taskFacts(s)[4].value, 'нет данных')
  assert.throws(() => fallbackTaskStats(snapshot(), 'nope', NOW), /нет в проекте/)
})

test('fallbackGlobalStats: прогон без токенов — подзадачи и координатор считаются, стоимости нет', () => {
  const run = { id: 'r1', title: 'G', status: 'in_progress', createdAt: T0, updatedAt: T0, returns: [{ at: T0, text: 'x' }] } as unknown as Run
  const t = task({ id: 't1', runId: 'r1', status: 'done' })
  const s = fallbackGlobalStats(snapshot({ runs: [run], tasks: [t] }), 'r1', NOW)
  assert.equal(s.runId, 'r1')
  assert.equal(s.subtasks.count, 1)
  assert.equal(s.subtasks.done, 1)
  assert.equal(s.returns, 1)
  assert.equal(s.usage.costUsd, undefined)
  assert.throws(() => fallbackGlobalStats(snapshot(), 'nope', NOW), /нет в проекте/)
})
