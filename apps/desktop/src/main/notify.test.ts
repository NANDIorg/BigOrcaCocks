// Запуск: pnpm --filter @orca-board/desktop test. Фильтр и тексты системных уведомлений.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { OrcaEvent, Task } from '@orca-board/core'
import { describeEvent, answerNudge } from './notify'

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
    // Агент не выбрал ветку «Решения ИИ» — человек выбирает её, как отвечает на вопрос.
    assert.equal(describeEvent(ev('request_created', { kind: 'decision', requestId: 'r', title: 'Нужен ли дизайн?' }), task, 'P', true)?.kind, 'question')
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
