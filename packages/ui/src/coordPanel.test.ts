import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentSession } from '@orca-board/core'
import { coordState, coordStateText, knownSessions, sessionRows } from './coordPanel'
import { setLocale } from './i18n'

afterEach(() => setLocale('ru'))

const H = 3_600_000
const session = (extra: Partial<AgentSession> = {}): AgentSession => ({ ptyId: 'p1', roleId: 'coordinator', agent: 'claude', startedAt: 1_000_000, ...extra })

test('coordState: нет живого PTY — не запущен, даже при pending-запросах', () => {
  assert.equal(coordState(false, 2, 'needs_input'), 'stopped')
  assert.equal(coordState(true, 0, 'in_progress'), 'working')
  assert.equal(coordState(true, undefined, undefined), 'working')
})

test('coordState: живой координатор при pending-запросах или в «Нужен ответ» ждёт человека', () => {
  assert.equal(coordState(true, 1, 'in_progress'), 'waiting')
  assert.equal(coordState(true, 0, 'needs_input'), 'waiting')
})

test('sessionRows: поля нет — запуски неизвестны, пустой список — запусков не было', () => {
  assert.equal(sessionRows(undefined, 'p1', 0), undefined)
  assert.deepEqual(sessionRows([], undefined, 0), [])
})

test('sessionRows: новые сверху, номер по порядку запуска, название агента и модель', () => {
  const rows = sessionRows(
    [session({ ptyId: 'p2', startedAt: 10 * H, endedAt: 12 * H, model: 'opus' }), session({ ptyId: 'p1', startedAt: 5 * H, endedAt: 6 * H })],
    undefined,
    20 * H
  ) ?? []
  assert.deepEqual(rows.map((r) => r.title), ['Запуск 2', 'Запуск 1'])
  assert.deepEqual(rows.map((r) => r.duration), ['2 ч', '1 ч'])
  assert.match(rows[0].agent, /· opus$/)
  assert.ok(!rows[1].agent.includes('·'))
  assert.equal(rows[0].live, false)
})

test('sessionRows: живой запуск идёт до «сейчас», мёртвый без endedAt — конец неизвестен', () => {
  const live = sessionRows([session({ startedAt: 10 * H })], 'p1', 11 * H)?.[0]
  assert.equal(live?.live, true)
  assert.equal(live?.duration, '1 ч')
  assert.match(live?.period ?? '', /— сейчас$/)
  const crashed = sessionRows([session({ startedAt: 10 * H })], undefined, 11 * H)?.[0]
  assert.equal(crashed?.live, false)
  assert.equal(crashed?.duration, undefined)
  assert.match(crashed?.period ?? '', /конец неизвестен$/)
  // живой PTY другого запуска не делает этот запуск живым
  assert.equal(sessionRows([session({ ptyId: 'old' })], 'p9', 0)?.[0].live, false)
})

test('knownSessions: поле есть — оно; поля нет — «не было» без запусков и «неизвестны» с запуском', () => {
  const list = [session()]
  assert.equal(knownSessions(list, true), list)
  assert.deepEqual(knownSessions(undefined, false), [])
  assert.equal(knownSessions(undefined, true), undefined)
})

test('sessionRows: конец в тот же день — только время, в другой день — с датой', () => {
  const day = new Date(2026, 8, 24, 10, 5).getTime()
  const same = sessionRows([session({ startedAt: day, endedAt: day + 2 * H })], undefined, day)?.[0]
  assert.match(same?.period ?? '', /^24\.09, 10:05 — 12:05$/)
  const next = sessionRows([session({ startedAt: day, endedAt: day + 30 * H })], undefined, day)?.[0]
  assert.match(next?.period ?? '', /^24\.09, 10:05 — 25\.09, 16:05$/)
})

test('английский интерфейс: состояние, номер запуска, «now» и формат даты — по языку', () => {
  assert.equal(coordStateText('waiting'), 'Координатор ждёт вас')
  setLocale('en')
  assert.equal(coordStateText('stopped'), 'Coordinator is not running')
  const day = new Date(2026, 8, 24, 10, 5).getTime()
  const live = sessionRows([session({ startedAt: day })], 'p1', day + H)?.[0]
  assert.equal(live?.title, 'Session 1')
  assert.equal(live?.duration, '1 h')
  assert.match(live?.period ?? '', /^09\/24, 10:05 AM — now$/)
  const crashed = sessionRows([session({ startedAt: day })], undefined, day)?.[0]
  assert.match(crashed?.period ?? '', /end unknown$/)
})
