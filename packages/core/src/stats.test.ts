import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { emptyProjectStats, statsRangeStart } from './stats.ts'
import { STATS_RANGES } from './types.ts'

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
