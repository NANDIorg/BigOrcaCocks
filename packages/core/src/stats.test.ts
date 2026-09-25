import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildProjectStats, emptyProjectStats, localDayKey, statsRangeStart, type SessionUsage, type StatsSession, type UsageRecord } from './stats.ts'
import { findModelPrice, tokensCost } from './pricing.ts'
import { TaskStore } from './store.ts'
import { DEFAULT_COLUMNS, STATS_RANGES, type Dispatch, type Run, type Task } from './types.ts'

describe('статистика: контракт', () => {
  const now = Date.UTC(2026, 8, 24, 12)

  it('период — скользящее окно от момента запроса, all — без начала', () => {
    assert.equal(statsRangeStart('all', now), undefined)
    assert.equal(statsRangeStart('7d', now), now - 7 * 86_400_000)
    assert.equal(statsRangeStart('30d', now), now - 30 * 86_400_000)
    assert.deepEqual(STATS_RANGES, ['all', '7d', '30d'])
  })

  it('пустая статистика: токены неизвестны, а не нули', () => {
    const s = emptyProjectStats('p1', '7d', now)
    assert.equal(s.projectId, 'p1')
    assert.equal(s.from, now - 7 * 86_400_000)
    assert.equal(s.generatedAt, now)
    assert.equal(s.totals.tokens, undefined)
    assert.equal(s.totals.costUsd, undefined)
    assert.equal(s.totals.sessions, 0)
    assert.deepEqual(s.byDay, [])
    assert.ok(!('from' in emptyProjectStats('p1', 'all', now)))
  })

  it('счётчики задач и глобальных задач — разные объекты', () => {
    const s = emptyProjectStats('p1', 'all', now)
    assert.notEqual(s.tasks.byStatus, s.globalTasks.byStatus)
  })
})


const H = 3_600_000
const D = 24 * H

function task(p: Partial<Task> & Pick<Task, 'id'>): Task {
  return { title: p.id, spec: '', status: 'backlog', priority: 'normal', deps: [], roleId: 'developer', agent: 'claude', createdAt: 0, updatedAt: 0, ...p }
}

function rec(at: number, model: string, input: number, output: number, extra: Partial<UsageRecord> = {}): UsageRecord {
  return { at, model, input, output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...extra }
}

describe('статистика: цены', () => {
  it('выигрывает самый длинный префикс, неизвестная модель — без цены', () => {
    assert.equal(findModelPrice('claude-opus-5-5')?.input, 4)
    assert.equal(findModelPrice('claude-opus-5-20260101')?.input, 5)
    assert.equal(findModelPrice('claude-fable-5-1')?.cacheRead, 0.25)
    assert.equal(findModelPrice('claude-fable-5')?.cacheRead, 1)
    assert.equal(findModelPrice('gpt-6'), undefined)
    assert.equal(tokensCost('gpt-6', rec(0, 'gpt-6', 1, 1)), undefined)
  })

  it('стоимость — по всем видам токенов, запись в кэш по TTL', () => {
    // opus-5: 5 вход, 25 выход, 0.5 чтение, 6.25 запись 5 мин, 10 запись 1 час ($ за миллион)
    const cost = tokensCost('claude-opus-5', { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 })
    assert.equal(cost, 5 + 25 + 0.5 + 6.25 + 10)
  })
})

describe('статистика: цены GPT (codex)', () => {
  it('id модели: снапшот с датой, регистр и префикс провайдера — те же цены; сосед по префиксу — нет', () => {
    assert.equal(findModelPrice('gpt-5.5')?.output, 30)
    assert.equal(findModelPrice('gpt-5.5-2026-04-23')?.output, 30)
    assert.equal(findModelPrice('gpt-5.4-20260305')?.output, 15)
    assert.equal(findModelPrice('GPT-5.5')?.output, 30)
    assert.equal(findModelPrice('openai/gpt-5.5')?.output, 30)
    // gpt-5.4-mini не путается с gpt-5.4, а gpt-5.6-sol — с gpt-5
    assert.equal(findModelPrice('gpt-5.4-mini-2026-03-05')?.input, 0.75)
    assert.equal(findModelPrice('gpt-5.6-sol')?.input, 4)
    // неизвестные версии и служебные модели — без цены, а не по цене «ближайшего» префикса
    assert.equal(findModelPrice('gpt-5.7'), undefined)
    assert.equal(findModelPrice('gpt-5.5-preview'), undefined)
    assert.equal(findModelPrice('gpt-5-codex'), undefined)
    assert.equal(findModelPrice('codex-auto-review'), undefined)
    assert.equal(findModelPrice('gpt-reserve'), undefined)
  })

  it('стоимость: обычный вход, кэшированный вход и выход по своим ценам', () => {
    // gpt-5.5: 5 вход, 0.5 кэш, 30 выход ($ за миллион); запись в кэш отдельной цены не имеет — как вход
    const t = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 0, cacheWrite1h: 0 }
    assert.equal(tokensCost('gpt-5.5', t), 5 + 30 + 0.5)
    assert.equal(tokensCost('gpt-5.5-2026-04-23', t), 5 + 30 + 0.5)
    // gpt-5.6-sol: отдельная цена записи в кэш 5
    const w = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 2e6, cacheWrite1h: 0 }
    assert.equal(tokensCost('gpt-5.6-sol', w), 10)
    assert.equal(tokensCost('gpt-5.5', w), 10)
  })

  it('сводка: токены codex считаются в $, неизвестная модель — в unpricedTokens, а не нулём', () => {
    const now = Date.UTC(2026, 8, 25, 12)
    const usage: Record<string, SessionUsage> = {
      d1: { records: [rec(now - H, 'gpt-5.5', 1_000_000, 100_000, { cacheRead: 2_000_000 }), rec(now - H, 'codex-auto-review', 300, 50)] }
    }
    const s = buildProjectStats({
      projectId: 'p', range: 'all', now, tasks: [task({ id: 't1', agent: 'codex' })], runs: [], columns: DEFAULT_COLUMNS,
      dispatches: [{ id: 'd1', taskId: 't1', ptyId: 'p1', startedAt: now - 2 * H, endedAt: now, roleId: 'developer', agent: 'codex' }],
      usage: (x: StatsSession) => usage[x.key],
      isAlive: () => false
    })
    // gpt-5.5: 5 (вход) + 3 (100K выхода по 30) + 1 (2M кэша по 0.5)
    assert.equal(s.totals.costUsd, 9)
    assert.equal(s.totals.unpricedTokens, 350)
    assert.deepEqual(s.totals.unpricedModels, ['codex-auto-review'])
  })
})

describe('статистика: сбор по store', () => {
  const now = Date.UTC(2026, 8, 24, 12)
  const old = now - 20 * D
  const columns = DEFAULT_COLUMNS
  const runs: Run[] = [
    {
      id: 'r1', objective: 'Глобальная', createdAt: old, status: 'in_progress',
      coordinatorSessions: [{ ptyId: 'pc', roleId: 'coordinator', agent: 'claude', sessionId: 'c1', startedAt: now - 2 * H, endedAt: now - H }]
    },
    { id: 'inbox', objective: '', inbox: true, createdAt: old }
  ]
  const tasks: Task[] = [
    task({
      id: 't1', title: 'Новая', runId: 'r1', status: 'done', createdAt: now - 3 * H, activeMs: 30 * 60_000,
      statusHistory: [
        { status: 'backlog', at: now - 3 * H, by: 'cli' },
        { status: 'in_progress', at: now - 2 * H, by: 'app' },
        { status: 'done', at: now - H, by: 'human' }
      ]
    }),
    // Старая задача: создана и сделана до периода 7 дней, история — только запись миграции.
    task({ id: 't2', title: 'Старая', runId: 'r1', status: 'done', createdAt: old, doneAt: old + H, statusHistory: [{ status: 'done', at: old + 2 * H, by: 'app', migrated: true }] }),
    task({ id: 't3', title: 'Codex', runId: 'inbox', status: 'in_progress', createdAt: now - H, agent: 'codex', roleId: 'qa' })
  ]
  const dispatches: Dispatch[] = [
    { id: 'd1', taskId: 't1', ptyId: 'p1', startedAt: now - 2 * H, endedAt: now - H, outcome: 'done', roleId: 'developer', agent: 'claude', sessionId: 's1' },
    { id: 'd2', taskId: 't2', ptyId: 'p2', startedAt: old, endedAt: old + H, outcome: 'failed' },
    { id: 'd3', taskId: 't3', ptyId: 'p3', startedAt: now - 30 * 60_000 }
  ]
  const usage: Record<string, SessionUsage> = {
    d1: { records: [rec(now - 90 * 60_000, 'claude-opus-5', 1_000_000, 100_000, { cacheRead: 2_000_000 }), rec(now - 80 * 60_000, 'gpt-6', 500, 50)], lastAt: now - 80 * 60_000 },
    d2: { records: [rec(old + 10 * 60_000, 'claude-sonnet-5', 1_000_000, 0)] },
    'coord:r1:pc': { records: [rec(now - 100 * 60_000, 'claude-opus-5-5', 0, 1_000_000)] }
  }
  const build = (range: 'all' | '7d') => buildProjectStats({
    projectId: 'p', range, now, tasks, runs, dispatches, columns,
    usage: (s: StatsSession) => usage[s.key],
    isAlive: (id) => id === 'p3',
    roleTitle: (id) => ({ developer: 'Разработчик', coordinator: 'Координатор' } as Record<string, string>)[id],
    dayKey: (ms) => new Date(ms).toISOString().slice(0, 10)
  })

  it('всё время: токены, стоимость, неизвестная модель, сессии без данных', () => {
    const s = build('all')
    assert.deepEqual(s.totals.tokens, { input: 2_000_500, output: 1_100_050, cacheRead: 2_000_000, cacheWrite: 0 })
    // opus-5: 5 + 2.5 + 1 = 8.5; sonnet-5: 2; opus-5-5: 20
    assert.equal(s.totals.costUsd, 30.5)
    assert.equal(s.totals.unpricedTokens, 550)
    assert.deepEqual(s.totals.unpricedModels, ['gpt-6'])
    assert.equal(s.totals.sessions, 4)
    assert.equal(s.totals.sessionsWithUsage, 3)
    // d1 — 1 ч, d2 — 1 ч, координатор — 1 ч, d3 жив — 30 мин до now
    assert.equal(s.totals.agentMs, 3 * H + 30 * 60_000)
    assert.deepEqual(s.dispatches, { total: 3, done: 1, failed: 1, unknown: 0, running: 1 })
    assert.equal(s.coordinatorLaunches, 1)
  })

  it('разбивки: отсортированы по стоимости, «нет данных» — без tokens', () => {
    const s = build('all')
    assert.deepEqual(s.byModel.map((r) => r.key), ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'gpt-6', 'unknown'])
    assert.equal(s.byModel.find((r) => r.key === 'unknown')?.tokens, undefined)
    assert.equal(s.byModel.find((r) => r.key === 'gpt-6')?.costUsd, undefined)
    assert.deepEqual(s.byRole.map((r) => [r.key, r.title]), [['coordinator', 'Координатор'], ['developer', 'Разработчик'], ['qa', 'qa']])
    assert.deepEqual(s.byAgent.map((r) => [r.key, r.title]), [['claude', 'Claude Code'], ['codex', 'Codex']])
    assert.deepEqual(s.byGlobalTask.map((r) => [r.key, r.title]), [['r1', 'Глобальная'], ['inbox', 'Входящие']])
    assert.equal(s.byGlobalTask[0].costUsd, 30.5)
    assert.deepEqual(s.byTask.map((r) => r.key), ['t1', 't2', 't3'])
    assert.equal(s.byTask[2].tokens, undefined)
    assert.equal(s.byTask[2].sessions, 1)
  })

  it('период 7 дней: старые сессии, задачи и токены не входят', () => {
    const s = build('7d')
    assert.equal(s.from, now - 7 * D)
    assert.equal(s.totals.costUsd, 28.5)
    assert.equal(s.totals.sessions, 3)
    assert.equal(s.dispatches.total, 2)
    assert.equal(s.tasks.total, 3)
    assert.equal(s.tasks.created, 2)
    assert.equal(s.tasks.done, 1)
    assert.deepEqual(s.tasks.byStatus, { done: 2, in_progress: 1 })
    assert.deepEqual(s.taskTime, { avgActiveMs: 30 * 60_000, avgLeadMs: H, samples: 1 })
    assert.equal(s.globalTasks.total, 1)
    assert.equal(s.globalTasks.created, 0)
    assert.ok(!s.byModel.some((r) => r.key === 'claude-sonnet-5'))
  })

  it('старая задача с записью миграции: вход в done — по doneAt', () => {
    const s = build('all')
    assert.equal(s.tasks.done, 2)
    assert.equal(s.taskTime.samples, 2)
    // Время «в работу → done» — только у задачи с настоящей историей.
    assert.equal(s.taskTime.avgLeadMs, H)
  })

  it('по дням: от старых к новым, модели дня — в порядке byModel', () => {
    const s = build('all')
    assert.deepEqual(s.byDay.map((d) => d.date), [new Date(old).toISOString().slice(0, 10), new Date(now).toISOString().slice(0, 10)])
    const today = s.byDay[1]
    assert.equal(today.tasksDone, 1)
    assert.equal(today.costUsd, 28.5)
    assert.deepEqual(today.byModel.map((r) => r.key), ['claude-opus-5-5', 'claude-opus-5', 'gpt-6', 'unknown'])
  })

  it('PTY умер без endedAt — конец по последнему сообщению, без транскрипта время не считается', () => {
    const r: Run = { id: 'r2', objective: 'x', createdAt: now - H, coordinatorSessions: [
      { ptyId: 'dead1', roleId: 'coordinator', agent: 'claude', sessionId: 'x1', startedAt: now - H },
      { ptyId: 'dead2', roleId: 'coordinator', agent: 'claude', startedAt: now - H }
    ] }
    const s = buildProjectStats({
      projectId: 'p', range: 'all', now, tasks: [], runs: [r], dispatches: [], columns,
      usage: (x) => (x.ptyId === 'dead1' ? { records: [], lastAt: now - 30 * 60_000 } : undefined),
      isAlive: () => false
    })
    assert.equal(s.totals.agentMs, 30 * 60_000)
    assert.equal(s.totals.sessions, 2)
    assert.deepEqual(s.totals.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    assert.equal(s.totals.costUsd, undefined)
  })

  it('день по умолчанию — локальная дата', () => {
    const t = new Date(2026, 0, 2, 23, 30).getTime()
    assert.equal(localDayKey(t), '2026-01-02')
  })
})

describe('статистика: запись сессий в store', () => {
  it('dispatch хранит снимок роли и id сессии, координатор — все запуски', () => {
    const store = new TaskStore()
    const t = store.createTask({ title: 'x' })
    const d = store.startDispatch(t.id, 'p1', 'd1', { roleId: 'developer', agent: 'claude', model: 'opus', sessionId: 'u1' })
    assert.deepEqual([d.roleId, d.agent, d.model, d.sessionId], ['developer', 'claude', 'opus', 'u1'])
    const bare = store.startDispatch(t.id, 'p2', 'd2', { roleId: 'developer', agent: 'codex', model: undefined })
    assert.ok(!('model' in bare) && !('sessionId' in bare))
    store.setDispatchSessionId('d2', 'codex-1')
    store.setDispatchSessionId('d2', 'codex-2')
    assert.equal(store.getDispatch('d2')?.sessionId, 'codex-1')

    const run = store.createRun('цель')
    store.setRunPty(run.id, 'c1', 'claude', { roleId: 'coordinator', agent: 'claude', sessionId: 'cs1' })
    store.coordinatorExited(run.id, 'c1')
    store.setRunPty(run.id, 'c2', 'claude', { roleId: 'coordinator', agent: 'claude', sessionId: 'cs2' })
    const sessions = store.getRun(run.id)?.coordinatorSessions ?? []
    assert.deepEqual(sessions.map((s) => [s.ptyId, s.sessionId, s.endedAt !== undefined]), [['c1', 'cs1', true], ['c2', 'cs2', false]])
  })
})
