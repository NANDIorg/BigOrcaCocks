import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WF_PORTS, type WfNodeType } from '@orca-board/core'
import { WF_NODE_HELP } from './workflowHelp'
import { WF_ADDABLE_TYPES, WF_OUTCOME_LABELS } from './workflowEdit'
import { WF_TYPE_ORDER, WF_TYPE_TITLES } from './workflowForm'
import { setLocale, t } from './i18n'

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

test('справка и подписи переводятся: на en — английский текст, ни одного ключа словаря вместо текста', () => {
  setLocale('en')
  try {
    for (const type of MODEL_TYPES) {
      const h = WF_NODE_HELP[type]
      const texts = [h.summary, h.actor, h.details, ...h.fields, ...Object.values(h.outcomes)]
      for (const s of texts) assert.ok(!s.startsWith('config.') && !/[А-Яа-яЁё]/.test(s ?? ''), `${type}: «${s}»`)
      assert.ok(!/[А-Яа-яЁё]/.test(WF_TYPE_TITLES[type]), type)
    }
    assert.equal(WF_OUTCOME_LABELS.reject, 'reject')
    assert.equal(WF_TYPE_TITLES.gate, 'Agent check')
  } finally {
    setLocale('ru')
  }
  assert.equal(WF_TYPE_TITLES.gate, 'Проверка агентом')
  assert.equal(WF_OUTCOME_LABELS.reject, 'вернуть')
})

test('справка «Вопроса человеку»: один исход next, поля из инспектора, вопросы идут человеку', () => {
  const { fields, outcomes, actor } = WF_NODE_HELP.ask
  assert.deepEqual(Object.keys(outcomes), ['next'])
  for (const label of ['Роль', 'О чём спросить']) assert.ok(fields.some((f) => f.startsWith(`${label} — `)), `нет описания поля «${label}»`)
  assert.match(actor, /минуя координатора/)
  assert.ok(WF_ADDABLE_TYPES.includes('ask') && WF_TYPE_ORDER.includes('ask'))
})

test('справка описывает воркфлоу глобальной задачи: «Работу» ведёт координатор, роли необязательны, условия по роли и create_branch нет', () => {
  const { work, condition, git, gate, human } = WF_NODE_HELP
  assert.match(work.summary, /координатор/)
  assert.match(work.details, /stage_started/)
  assert.ok(work.fields.some((f) => f.startsWith('Роли — ') && /необязательно/.test(f)), 'роли этапа необязательны')
  assert.doesNotMatch(condition.details + condition.fields.join(' '), /роль рабочей задачи/i)
  assert.ok(condition.fields.every((f) => !/^Условие «Роль/.test(f)))
  assert.doesNotMatch(git.fields.join(' '), /create_branch|checkout/)
  assert.match(gate.summary, /ветку глобальной задачи/)
  assert.match(human.details, /Решение \/ что делать дальше/)
})

test('справка «Решения ИИ»: исходов у типа нет (порты — варианты ноды), поля инспектора описаны, фоллбэк — человек', () => {
  const { fields, outcomes, actor, details } = WF_NODE_HELP.decision
  assert.deepEqual(outcomes, {})
  for (const label of ['Вопрос', 'Роль', 'Варианты', 'Как решать']) {
    assert.ok(fields.some((f) => f.startsWith(`${label} — `)), `нет описания поля «${label}»`)
  }
  assert.match(actor, /человек/)
  assert.match(details, /Инбокс/)
  assert.ok(WF_ADDABLE_TYPES.includes('decision') && WF_TYPE_ORDER.includes('decision'))
  assert.equal(t('config.wf.help.decision.outcome').startsWith('config.'), false)
})
