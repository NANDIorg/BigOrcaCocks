import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WF_PORTS, type WfNodeType } from '@orca-board/core'
import { WF_NODE_HELP } from './workflowHelp'
import { WF_ADDABLE_TYPES } from './workflowEdit'
import { WF_TYPE_ORDER } from './workflowForm'

const MODEL_TYPES = Object.keys(WF_PORTS) as WfNodeType[]

test('справка есть для каждого типа ноды модели и не пустая', () => {
  assert.deepEqual(Object.keys(WF_NODE_HELP).sort(), [...MODEL_TYPES].sort())
  for (const type of MODEL_TYPES) {
    const h = WF_NODE_HELP[type]
    assert.ok(h.summary.trim(), `${type}: пустое summary`)
    assert.ok(h.actor.trim(), `${type}: не сказано, кто выполняет`)
    assert.ok(h.details.trim(), `${type}: пустое описание`)
    assert.ok(h.fields.length > 0 && h.fields.every((f) => f.trim()), `${type}: нет описания полей`)
  }
})

test('исходы в справке совпадают с портами типа', () => {
  for (const type of MODEL_TYPES) {
    assert.deepEqual(Object.keys(WF_NODE_HELP[type].outcomes).sort(), [...WF_PORTS[type]].sort(), type)
  }
})

test('палитра и select «Тип» покрыты справкой', () => {
  for (const type of [...WF_ADDABLE_TYPES, ...WF_TYPE_ORDER]) assert.ok(WF_NODE_HELP[type], type)
})

test('справка «Работы» описывает поля этапа и показа из инспектора', () => {
  const { fields, details } = WF_NODE_HELP.work
  for (const label of ['Что сделать на этапе', 'Показать человеку', 'Показ обязателен']) {
    assert.ok(fields.some((f) => f.startsWith(`${label} — `)), `нет описания поля «${label}»`)
  }
  assert.match(details, /показ/i)
  assert.match(WF_NODE_HELP.human.details, /показ/i)
})

test('справка «Вопроса человеку»: один исход next, поля из инспектора, вопросы идут человеку', () => {
  const { fields, outcomes, actor } = WF_NODE_HELP.ask
  assert.deepEqual(Object.keys(outcomes), ['next'])
  for (const label of ['Роль', 'О чём спросить']) assert.ok(fields.some((f) => f.startsWith(`${label} — `)), `нет описания поля «${label}»`)
  assert.match(actor, /минуя координатора/)
  assert.ok(WF_ADDABLE_TYPES.includes('ask') && WF_TYPE_ORDER.includes('ask'))
})
