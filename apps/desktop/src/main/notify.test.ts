// Запуск: pnpm --filter @orca-board/desktop test. Фильтр и тексты системных уведомлений.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { OrcaEvent, Run, Task } from '@orca-board/core'
import {
  DEFAULT_NOTIFICATION_SETTINGS as D,
  inQuietHours,
  mergeNotificationSettings,
  normalizeNotificationSettings,
  shouldNotify,
  type NotificationSettings
} from '../shared/notifications'
import { describeEvent, describePrFailure, answerNudge } from './notify'

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
    assert.equal(describeEvent(ev('worker_done', { answerFor: 'human' }), task, 'P', true), null, 'ответ для человека — через request_created')
    assert.equal(describeEvent(ev('worker_done', { answerFor: 'coordinator' }), task, 'P', true)?.kind, 'workerDone')
    assert.equal(describeEvent(ev('request_created', { kind: 'question', requestId: 'r1' }), task, 'P', true)?.roleId, 'reviewer')
    const run = describeEvent({ ...ev('run_done', { objective: 'цель' }), taskId: undefined }, undefined, 'P', true)
    assert.deepEqual(run && { kind: run.kind, roleId: run.roleId, body: run.body }, { kind: 'runDone', roleId: 'coordinator', body: 'Подзадачи сделаны, скоро проверка: цель' })
    const manual = describeEvent({ ...ev('run_done', { objective: 'цель', manual: true }), taskId: undefined }, undefined, 'P', true)
    assert.equal(manual?.body, 'Прогон завершён: цель', 'ручной перенос — человек сам объявил задачу сделанной')
    assert.equal(describeEvent(ev('task_ready', {}), task, 'P', true), null)
    assert.equal(describeEvent(ev('question_answered', {}), task, 'P', true), null)
  })

  it('уведомляет только о запросах к человеку, а не о каждом вопросе и эскалации', () => {
    assert.equal(describeEvent(ev('question', { question: 'q' }), task, 'P', true), null, 'вопрос координатору')
    assert.equal(describeEvent(ev('escalation', { reason: 'код 1' }), task, 'P', true), null, 'эскалация без запроса')
    assert.equal(describeEvent(ev('escalation', { reason: 'нет вывода 20 мин', stuck: true }), task, 'P', true)?.kind, 'escalation')
    const kinds = (['question', 'answer', 'escalation'] as const).map((kind) => describeEvent(ev('request_created', { kind, requestId: 'r', title: 't' }), task, 'P', true)?.kind)
    assert.deepEqual(kinds, ['question', 'answerReady', 'escalation'])
  })

  it('воркфлоу: этап «человек» — как готовое к ревью, остановка — эскалация, сданная проверка — без уведомления', () => {
    const approval = describeEvent(ev('request_created', { kind: 'approval', requestId: 'r', title: 'Ревью человеком: Задача' }), task, 'P', true)
    assert.deepEqual(approval && { kind: approval.kind, body: approval.body, requestId: approval.requestId }, { kind: 'workerDone', body: 'Ждёт решения: Ревью человеком: Задача', requestId: 'r' })
    const blocked = describeEvent(ev('workflow_blocked', { reason: 'нет роли' }), task, 'P', true)
    assert.deepEqual(blocked && { kind: blocked.kind, body: blocked.body }, { kind: 'escalation', body: 'Воркфлоу остановлен: нет роли' })
    assert.equal(describeEvent(ev('worker_done', { summary: 'принято', gateFor: 't0' }), task, 'P', true), null)
    assert.equal(describeEvent(ev('stage_changed', { to: 'review' }), task, 'P', true), null)
  })

  it('превью: с текстом и без; requestId — для клика', () => {
    const e = ev('request_created', { kind: 'question', requestId: 'req_1', title: 'Какой вариант?' })
    assert.deepEqual(describeEvent(e, task, 'P', true), { kind: 'question', roleId: 'reviewer', title: 'Задача · P', body: 'Вопрос: Какой вариант?', requestId: 'req_1' })
    assert.deepEqual(describeEvent(e, task, 'P', false), { kind: 'question', roleId: 'reviewer', title: 'P', body: 'Вопрос', requestId: 'req_1' })
  })

  it('пинок воркеру — команда, а не текст ответа', () => {
    assert.equal(answerNudge('q_1', 'req_1'), '[orca] на вопрос q_1 ответили: orca-board request get --request req_1')
    assert.equal(answerNudge('q_1'), '[orca] на вопрос q_1 ответили: orca-board question get --question q_1')
  })
})

describe('describePrFailure', () => {
  const run = (git: Partial<NonNullable<Run['git']>>): Run =>
    ({ id: 'run_1', title: 'Фича', objective: 'Фича', git: { branch: 'feature/x', base: 'develop', ...git } }) as Run

  it('эскалация от координатора; нет gh и нет логина — своими словами, прочее — текст gh', () => {
    const missing = describePrFailure(run({ prError: 'gh не установлен', prErrorCode: 'ghMissing' }), 'P', true)
    assert.equal(missing.kind, 'escalation')
    assert.equal(missing.roleId, 'coordinator')
    assert.equal(missing.title, 'Фича · P')
    assert.match(missing.body, /^PR не открыт: gh не установлен/)
    assert.match(describePrFailure(run({ prError: 'x', prErrorCode: 'ghAuth' }), 'P', true).body, /gh auth login/)
    assert.equal(describePrFailure(run({ prError: 'GraphQL: forbidden', prErrorCode: 'other' }), 'P', true).body, 'PR не открыт: GraphQL: forbidden')
  })

  it('без превью — только проект и общий текст', () => {
    const c = describePrFailure(run({ prError: 'секрет', prErrorCode: 'other' }), 'P', false)
    assert.equal(c.title, 'P')
    assert.equal(c.body, 'PR не открыт')
  })
})
