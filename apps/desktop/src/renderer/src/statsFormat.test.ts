import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyProjectStats, emptyStatsUsage, type ProjectStats, type StatsDay, type StatsRow } from '@orca-board/core'
import {
  STATS_STALE_MESSAGE,
  axisLabelIndexes,
  buildChart,
  chartMetrics,
  costCell,
  effectiveMetric,
  formatAgentTime,
  formatAxis,
  formatTokens,
  formatUsd,
  hasUsage,
  isEmptyStats,
  isStaleStatsError,
  localDateKey,
  missingLabel,
  missingSessions,
  niceStep,
  seriesColor,
  shareItems,
  statsApi,
  statusParts,
  taskCost,
  totalTokens
} from './statsFormat'

const MIN = 60_000
const HOUR = 60 * MIN

/** Полдень локального дня — чтобы `localDateKey` не зависел от часового пояса машины с тестами. */
const noon = (y: number, m: number, d: number): number => new Date(y, m - 1, d, 12).getTime()

function row(key: string, extra: Partial<StatsRow> = {}): StatsRow {
  return { ...emptyStatsUsage(), key, title: key, ...extra }
}

function day(date: string, extra: Partial<StatsDay> = {}): StatsDay {
  return { ...emptyStatsUsage(), date, tasksDone: 0, byModel: [], ...extra }
}

function stats(extra: Partial<ProjectStats> = {}): ProjectStats {
  return { ...emptyProjectStats('p', '30d', noon(2026, 9, 24)), ...extra }
}

test('statsApi: нет stats в старом preload — ошибка «перезапустите», новый main — распознаётся', () => {
  assert.throws(() => statsApi(undefined), { message: STATS_STALE_MESSAGE })
  assert.throws(() => statsApi({}), { message: STATS_STALE_MESSAGE })
  assert.ok(isStaleStatsError("Error invoking remote method 'stats:project': Error: No handler registered for 'stats:project'"))
  assert.ok(!isStaleStatsError('проект не найден'))
})

test('formatTokens: тысячи, миллионы, миллиарды через запятую', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(-5), '0')
  assert.equal(formatTokens(950), '950')
  assert.equal(formatTokens(12_345), '12 тыс')
  assert.equal(formatTokens(999_600), '1,0 млн')
  assert.equal(formatTokens(1_234_567), '1,2 млн')
  assert.equal(formatTokens(2_150_000_000), '2,15 млрд')
})

test('formatUsd: центы до $100, целые с разрядами после, копейки — «<$0,01»', () => {
  assert.equal(formatUsd(0), '$0')
  assert.equal(formatUsd(0.004), '<$0,01')
  assert.equal(formatUsd(12.4), '$12,40')
  assert.equal(formatUsd(412.4), '$412')
  assert.equal(formatUsd(1234.5).replace(/\s/g, ' '), '$1 235')
})

test('formatAgentTime: часы без перехода в дни, от 100 ч — только часы', () => {
  assert.equal(formatAgentTime(0), '<1 мин')
  assert.equal(formatAgentTime(45 * MIN), '45 мин')
  assert.equal(formatAgentTime(3 * HOUR), '3 ч')
  assert.equal(formatAgentTime(3 * HOUR + 12 * MIN), '3 ч 12 мин')
  assert.equal(formatAgentTime(30 * HOUR + 5 * MIN), '30 ч 5 мин')
  assert.equal(formatAgentTime(144.1 * HOUR), '144 ч')
})

test('неизвестно ≠ 0: нет токенов — undefined, нет стоимости — «нет данных» или «без цены»', () => {
  assert.equal(totalTokens(undefined), undefined)
  assert.equal(totalTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }), 10)
  const tokens = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
  assert.deepEqual(costCell(emptyStatsUsage()), { kind: 'unknown' })
  assert.deepEqual(costCell({ ...emptyStatsUsage(), tokens, unpricedTokens: 2, unpricedModels: ['x'] }), { kind: 'unpriced' })
  assert.deepEqual(costCell({ ...emptyStatsUsage(), tokens, costUsd: 5 }), { kind: 'cost', text: '$5,00', atLeast: false })
  assert.deepEqual(costCell({ ...emptyStatsUsage(), tokens, costUsd: 5, unpricedTokens: 10 }), { kind: 'cost', text: '$5,00', atLeast: true })
  assert.equal(missingSessions({ ...emptyStatsUsage(), sessions: 5, sessionsWithUsage: 3 }), 2)
  assert.equal(missingLabel(1), 'нет данных по 1 сессии')
  assert.equal(missingLabel(3), 'нет данных по 3 сессиям')
})

test('taskCost и hasUsage: делим только известную стоимость на ненулевое число задач', () => {
  const tokens = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
  assert.equal(taskCost(stats()), undefined)
  assert.equal(hasUsage(stats()), false)
  const s = stats({ totals: { ...emptyStatsUsage(), tokens, costUsd: 30 }, tasks: { total: 5, byStatus: {}, created: 1, done: 3 } })
  assert.equal(taskCost(s), 10)
  assert.equal(hasUsage(s), true)
  assert.equal(taskCost({ ...s, tasks: { ...s.tasks, done: 0 } }), undefined)
})

test('isEmptyStats: заглушка main пустая; задачи или сессии в периоде — уже не пустая', () => {
  assert.ok(isEmptyStats(stats()))
  assert.ok(!isEmptyStats(stats({ totals: { ...emptyStatsUsage(), sessions: 1 } })))
  assert.ok(!isEmptyStats(stats({ tasks: { total: 1, byStatus: {}, created: 1, done: 0 } })))
})

test('seriesColor: цвет по месту в byModel, unknown и шестая строка — серые', () => {
  const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => ({ key: k }))
  assert.equal(seriesColor(rows, 'a'), 'var(--s1)')
  assert.equal(seriesColor(rows, 'e'), 'var(--s5)')
  assert.equal(seriesColor(rows, 'f'), 'var(--s-other)')
  assert.equal(seriesColor(rows, 'нет-такой'), 'var(--s-other)')
  assert.equal(seriesColor([{ key: 'unknown' }], 'unknown'), 'var(--s-unknown)')
})

test('shareItems: доля от самой большой строки — по стоимости, без токенов — по времени', () => {
  const rows = [row('a', { costUsd: 10, agentMs: 1 }), row('b', { costUsd: 5, agentMs: 4 }), row('c', { agentMs: 2 })]
  assert.deepEqual(shareItems(rows, true).map((i) => i.share), [1, 0.5, 0])
  assert.deepEqual(shareItems(rows, false).map((i) => i.share), [0.25, 1, 0.5])
  assert.equal(shareItems(rows, true, 2).length, 2)
  assert.deepEqual(shareItems([row('z')], true).map((i) => i.share), [0])
})

test('statusParts: колонки в порядке доски, удалённые колонки — «Другие»', () => {
  const cols = [{ id: 'backlog', title: 'Бэклог', color: '#111' }, { id: 'done', title: 'Готово', color: '#222' }]
  const parts = statusParts({ done: 3, gone: 2, old: 1 }, cols)
  assert.deepEqual(parts.map((p) => [p.title, p.count]), [['Бэклог', 0], ['Готово', 3], ['Другие', 3]])
  assert.equal(statusParts({ backlog: 1 }, cols).length, 2)
})

test('chartMetrics / effectiveMetric: без токенов стоимость и токены скрыты', () => {
  assert.deepEqual(chartMetrics(true), ['cost', 'tokens', 'time', 'done'])
  assert.deepEqual(chartMetrics(false), ['time', 'done'])
  assert.equal(effectiveMetric('cost', false), 'time')
  assert.equal(effectiveMetric('done', false), 'done')
  assert.equal(effectiveMetric('tokens', true), 'tokens')
})

test('buildChart: 7 дней — ровно 7 столбцов до даты запроса, дни без записи пустые', () => {
  const s = stats({ range: '7d', byDay: [day('2026-09-10', { agentMs: HOUR }), day('2026-09-20', { agentMs: 2 * HOUR }), day('2026-09-24', { tasksDone: 3 })] })
  const c = buildChart(s, 'time')
  assert.equal(c.bucket, 'day')
  assert.deepEqual(c.columns.map((x) => x.date), ['2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'])
  assert.deepEqual(c.columns.map((x) => x.active), [false, false, true, false, false, false, true])
  assert.equal(c.columns[2].total, 2 * HOUR)
  assert.equal(c.columns[2].label, '20.09')
  // Шкала времени — в круглых часах/минутах.
  assert.equal(c.step % MIN, 0)
  assert.ok(c.top >= 2 * HOUR)
  assert.equal(buildChart(s, 'done').columns[6].total, 3)
})

test('buildChart: стоимость — стопкой по моделям, порядок сегментов как в byModel', () => {
  const s = stats({
    range: '30d',
    byDay: [day('2026-09-23', { byModel: [row('opus', { costUsd: 4 }), row('sonnet', { costUsd: 1 }), row('unknown')] })]
  })
  const c = buildChart(s, 'cost')
  assert.equal(c.columns.length, 30)
  const col = c.columns[28]
  assert.deepEqual(col.segments, [{ key: 'opus', value: 4 }, { key: 'sonnet', value: 1 }])
  assert.equal(col.total, 5)
  // Шаг 2 (круглый, не меньше 5/4) — верх шкалы 6.
  assert.equal(c.step, 2)
  assert.equal(c.top, 6)
})

test('buildChart: всё время — от первого дня, длинная история по неделям и месяцам', () => {
  const now = noon(2026, 9, 24)
  const short = buildChart(stats({ range: 'all', generatedAt: now, byDay: [day('2026-09-01', { agentMs: 1 })] }), 'time')
  assert.equal(short.bucket, 'day')
  assert.equal(short.columns.length, 24)

  const weeks = buildChart(stats({ range: 'all', generatedAt: now, byDay: [day('2026-06-01', { tasksDone: 1 }), day('2026-06-03', { tasksDone: 2 })] }), 'done')
  assert.equal(weeks.bucket, 'week')
  // 1 июня 2026 — понедельник: оба дня в одном столбце.
  assert.equal(weeks.columns[0].date, '2026-06-01')
  assert.equal(weeks.columns[0].total, 3)
  assert.equal(weeks.columns[0].title, '01.06–07.06')
  assert.equal(weeks.columns.at(-1)?.date, '2026-09-21')

  const months = buildChart(stats({ range: 'all', generatedAt: now, byDay: [day('2025-01-15', { tasksDone: 1 })] }), 'done')
  assert.equal(months.bucket, 'month')
  assert.equal(months.columns[0].date, '2025-01-01')
  assert.equal(months.columns[0].title, 'январь 2025')
  assert.equal(months.columns.length, 21)

  // Пустой проект: один столбец «сегодня», шкала не делится на ноль.
  const empty = buildChart(stats({ range: 'all', generatedAt: now }), 'cost')
  assert.equal(empty.columns.length, 1)
  assert.ok(empty.top > 0 && empty.step > 0)
})

test('niceStep, axisLabelIndexes, formatAxis', () => {
  assert.equal(niceStep(0), 1)
  assert.equal(niceStep(0.3), 0.5)
  assert.equal(niceStep(1.7), 2)
  assert.equal(niceStep(22), 25)
  assert.equal(niceStep(700), 1000)
  assert.deepEqual(axisLabelIndexes(7), [0, 1, 2, 3, 4, 5, 6])
  const i30 = axisLabelIndexes(30)
  assert.equal(i30.at(-1), 29)
  assert.ok(i30.length <= 8)
  assert.deepEqual(axisLabelIndexes(0), [])
  assert.equal(formatAxis(0, 'cost'), '0')
  assert.equal(formatAxis(2.5, 'cost'), '$2,5')
  assert.equal(formatAxis(10, 'cost'), '$10')
  assert.equal(formatAxis(1_500_000, 'tokens'), '1,5 млн')
  assert.equal(formatAxis(2 * HOUR, 'time'), '2 ч')
  assert.equal(formatAxis(30 * MIN, 'time'), '30 мин')
})

test('localDateKey: локальная дата с ведущими нулями', () => {
  assert.equal(localDateKey(noon(2026, 3, 5)), '2026-03-05')
})
