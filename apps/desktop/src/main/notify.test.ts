// Запуск: pnpm --filter @orca-board/desktop test. Фильтр и тексты системных уведомлений.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { OrcaEvent, Task } from '@orca-board/core'
import {
  DEFAULT_NOTIFICATION_SETTINGS as D,
  inQuietHours,
  mergeNotificationSettings,
  normalizeNotificationSettings,
  shouldNotify,
  type NotificationSettings
} from '../shared/notifications'
import { describeEvent } from './notify'

const at = (hhmm: string): Date => new Date(2026, 0, 1, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3)))
const noon = at('12:00')
const q = { kind: 'question', roleId: 'developer' } as const
const with_ = (patch: Partial<NotificationSettings>): NotificationSettings => ({ ...D, ...patch })

describe('shouldNotify', () => {
  it('по умолчанию уведомляет как раньше: в фокусе, со всеми ролями', () => {
    assert.equal(shouldNotify(q, D, noon, true), true)
    assert.equal(shouldNotify({ kind: 'escalation', roleId: 'custom-role' }, D, noon, false), true)
  })

  it('run_done по умолчанию выключен (раньше не уведомлял)', () => {
    assert.equal(shouldNotify({ kind: 'runDone', roleId: 'coordinator' }, D, noon, false), false)
  })

  it('глобальный выключатель подавляет всё', () => {
    assert.equal(shouldNotify(q, with_({ enabled: false }), noon, false), false)
  })

  it('выключенный вид события подавляет только его', () => {
    const s = with_({ events: { ...D.events, question: false } })
    assert.equal(shouldNotify(q, s, noon, false), false)
    assert.equal(shouldNotify({ kind: 'escalation', roleId: 'developer' }, s, noon, false), true)
  })

  it('выключенная роль подавляет, неизвестная (новая) — включена', () => {
    const s = with_({ roles: { developer: false, qa: true } })
    assert.equal(shouldNotify(q, s, noon, false), false)
    assert.equal(shouldNotify({ kind: 'question', roleId: 'qa' }, s, noon, false), true)
    assert.equal(shouldNotify({ kind: 'question', roleId: 'designer' }, s, noon, false), true)
  })

  it('только вне фокуса', () => {
    const s = with_({ onlyWhenUnfocused: true })
    assert.equal(shouldNotify(q, s, noon, true), false)
    assert.equal(shouldNotify(q, s, noon, false), true)
  })

  it('тихие часы подавляют', () => {
    const s = with_({ quietHours: { enabled: true, from: '11:00', to: '13:00' } })
    assert.equal(shouldNotify(q, s, noon, false), false)
    assert.equal(shouldNotify(q, s, at('13:00'), false), true)
  })
})

describe('inQuietHours', () => {
  const night = { enabled: true, from: '22:00', to: '08:00' }
  it('интервал через полночь', () => {
    assert.equal(inQuietHours(night, at('22:00')), true)
    assert.equal(inQuietHours(night, at('23:59')), true)
    assert.equal(inQuietHours(night, at('00:00')), true)
    assert.equal(inQuietHours(night, at('07:59')), true)
    assert.equal(inQuietHours(night, at('08:00')), false)
    assert.equal(inQuietHours(night, at('21:59')), false)
    assert.equal(inQuietHours(night, noon), false)
  })
  it('дневной интервал, выключенные и пустые', () => {
    assert.equal(inQuietHours({ enabled: true, from: '09:00', to: '18:00' }, noon), true)
    assert.equal(inQuietHours({ enabled: true, from: '09:00', to: '18:00' }, at('08:59')), false)
    assert.equal(inQuietHours({ ...night, enabled: false }, at('23:00')), false)
    assert.equal(inQuietHours({ enabled: true, from: '10:00', to: '10:00' }, at('10:00')), false)
  })
})

describe('normalize / merge', () => {
  it('старый файл без notifications — дефолты', () => {
    assert.deepEqual(normalizeNotificationSettings(undefined), D)
    assert.deepEqual(normalizeNotificationSettings({}), D)
  })

  it('частичные и битые поля — дефолты, корректные сохраняются', () => {
    const s = normalizeNotificationSettings({
      sound: false,
      enabled: 'yes',
      roles: { qa: false, bad: 1 },
      events: { runDone: true, unknown: true },
      quietHours: { enabled: true, from: '25:00', to: '07:30' }
    })
    assert.equal(s.sound, false)
    assert.equal(s.enabled, true)
    assert.deepEqual(s.roles, { qa: false })
    assert.deepEqual(s.events, { ...D.events, runDone: true })
    assert.deepEqual(s.quietHours, { enabled: true, from: D.quietHours.from, to: '07:30' })
  })

  it('merge мержит вложенные объекты', () => {
    const a = mergeNotificationSettings(D, { roles: { qa: false } })
    const b = mergeNotificationSettings(a, { roles: { reviewer: false }, events: { escalation: false }, quietHours: { from: '23:00' } })
    assert.deepEqual(b.roles, { qa: false, reviewer: false })
    assert.equal(b.events.escalation, false)
    assert.equal(b.events.question, true)
    assert.deepEqual(b.quietHours, { ...D.quietHours, from: '23:00' })
  })

  it('merge отклоняет мусор', () => {
    assert.throws(() => mergeNotificationSettings(D, { sound: 'no' }))
    assert.throws(() => mergeNotificationSettings(D, { events: { nope: true } }))
    assert.throws(() => mergeNotificationSettings(D, { quietHours: { to: '8:00' } }))
    assert.throws(() => mergeNotificationSettings(D, { roles: { qa: 'off' } }))
  })
})

describe('describeEvent', () => {
  const task = { id: 't1', title: 'Задача', roleId: 'reviewer' } as Task
  const ev = (type: OrcaEvent['type'], payload: Record<string, unknown>): OrcaEvent => ({ id: 'e', type, taskId: 't1', payload, createdAt: 0 })

  it('вид и роль по событию', () => {
    assert.equal(describeEvent(ev('worker_done', { summary: 's' }), task, 'P', true)?.kind, 'workerDone')
    assert.equal(describeEvent(ev('worker_done', { answerFor: 'human' }), task, 'P', true)?.kind, 'answerReady')
    assert.equal(describeEvent(ev('worker_done', { answerFor: 'coordinator' }), task, 'P', true)?.kind, 'workerDone')
    assert.equal(describeEvent(ev('question', {}), task, 'P', true)?.roleId, 'reviewer')
    const run = describeEvent({ ...ev('run_done', { objective: 'цель' }), taskId: undefined }, undefined, 'P', true)
    assert.deepEqual(run && { kind: run.kind, roleId: run.roleId, body: run.body }, { kind: 'runDone', roleId: 'coordinator', body: 'Прогон завершён: цель' })
    assert.equal(describeEvent(ev('task_ready', {}), task, 'P', true), null)
    assert.equal(describeEvent(ev('question_answered', {}), task, 'P', true), null)
  })

  it('превью: с текстом и без', () => {
    const e = ev('question', { question: 'Какой вариант?' })
    assert.deepEqual(describeEvent(e, task, 'P', true), { kind: 'question', roleId: 'reviewer', title: 'Задача · P', body: 'Вопрос: Какой вариант?' })
    assert.deepEqual(describeEvent(e, task, 'P', false), { kind: 'question', roleId: 'reviewer', title: 'P', body: 'Вопрос' })
  })
})
