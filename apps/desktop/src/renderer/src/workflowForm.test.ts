import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_COLUMNS, DEFAULT_ROLES, nextStage, validateWorkflow, type WfStage, type Workflow } from '@orca-board/core'
import {
  WF_TYPE_ORDER, WF_TYPE_TITLES, addRetryLimit, changeNodeType, conditionOfKind, exportWorkflowJson, hasColumn, parseWorkflowJson, patchNode, portTarget, setPortTarget, stageRoles, targetOptions, workflowFileName
} from './workflowForm'
import { setLocale } from './i18n'
import { graphWithMerge } from './workflowFixture'

const wf = graphWithMerge(DEFAULT_ROLES)
const node = (w: Workflow, id: string) => w.nodes.find((n) => n.id === id)
/** Роль ноды любого типа: у типов без роли — undefined. */
const roleOf = (w: Workflow, id: string): string | undefined => {
  const n = node(w, id)
  return n && 'roleId' in n ? n.roleId : undefined
}
const showcaseOf = (w: Workflow): unknown => {
  const n = node(w, 'work')
  return n?.type === 'work' ? n.showcase : undefined
}
const ctx = { roles: DEFAULT_ROLES, columns: DEFAULT_COLUMNS }

test('роли для этапов — без служебных coordinator и assistant', () => {
  const ids = stageRoles(DEFAULT_ROLES).map((r) => r.id)
  assert.ok(!ids.includes('coordinator') && !ids.includes('assistant'))
  assert.ok(ids.includes('reviewer') && ids.includes('developer'))
})

test('patchNode: пустые необязательные поля удаляются, чужие для типа — игнорируются', () => {
  let next = patchNode(wf, 'work', { title: '', roleId: 'developer', column: 'review' })
  assert.deepEqual(node(next, 'work'), { id: 'work', type: 'work', x: 220, y: 0, roleId: 'developer', column: 'review' })
  next = patchNode(next, 'work', { roleId: '', column: '', merged: true, test: { kind: 'role', roleIds: [] } })
  assert.deepEqual(node(next, 'work'), { id: 'work', type: 'work', x: 220, y: 0 })

  next = patchNode(wf, 'review', { roleId: '', instructions: '  ' })
  assert.equal(roleOf(next, 'review'), '')
  assert.ok(validateWorkflow(next, ctx).errors.some((e) => e.nodeId === 'review'))

  assert.equal(patchNode(wf, 'нет', { title: 'x' }), wf)
  assert.equal(node(wf, 'work')?.title, 'Работа', 'исходный граф не меняется')
})

test('patchNode: инструкция и показ у «Работы»', () => {
  let next = patchNode(wf, 'work', { instructions: 'Сделай 3 варианта макета', showcase: { what: 'макеты' } })
  assert.deepEqual(node(next, 'work'), { id: 'work', type: 'work', x: 220, y: 0, title: 'Работа', roleId: 'developer', instructions: 'Сделай 3 варианта макета', showcase: { what: 'макеты' } })
  next = patchNode(next, 'work', { showcase: { required: true } })
  assert.deepEqual(showcaseOf(next), { what: 'макеты', required: true }, 'флажок не стирает текст')
  next = patchNode(next, 'work', { showcase: { what: '' } })
  assert.deepEqual(showcaseOf(next), { what: '', required: true }, 'обязательный показ с пустым «что» остаётся — его подсветит валидация')
  assert.ok(validateWorkflow(next, ctx).errors.some((e) => e.nodeId === 'work'))
  next = patchNode(next, 'work', { showcase: { required: false }, instructions: ' ' })
  assert.deepEqual(node(next, 'work'), { id: 'work', type: 'work', x: 220, y: 0, title: 'Работа', roleId: 'developer' }, 'пустой показ и инструкция удаляются')
  assert.deepEqual(patchNode(wf, 'review', { showcase: { what: 'x' } }), wf, 'показ только у «Работы»')

  const human = changeNodeType(patchNode(wf, 'work', { instructions: 'этап', showcase: { what: 'макеты' } }), 'work', 'human')
  const h = node(human, 'work')
  assert.equal(h?.type === 'human' ? h.instructions : undefined, 'этап', 'инструкция переносится')
  assert.ok(!(h && 'showcase' in h), 'показа у человека нет')
})

test('changeNodeType: сохраняет id, позицию и роль, убирает рёбра лишних портов', () => {
  const human = changeNodeType(wf, 'review', 'human')
  const n = node(human, 'review')
  assert.equal(n?.type, 'human')
  assert.equal(n?.title, 'Ревью')
  assert.deepEqual([n?.x, n?.y], [440, 0])
  assert.equal(portTarget(human, 'review', 'accept'), 'merge')

  const back = changeNodeType(human, 'review', 'gate')
  assert.equal(node(back, 'review')?.type, 'gate')
  assert.equal(roleOf(back, 'review'), '')

  const toWork = changeNodeType(wf, 'review', 'work')
  assert.equal(node(toWork, 'review')?.type, 'work')
  assert.equal(roleOf(toWork, 'review'), 'reviewer')
  assert.deepEqual(toWork.edges.filter((e) => e.from === 'review'), [], 'у работы нет портов accept/reject')

  const toStart = changeNodeType(wf, 'work', 'start')
  assert.ok(!toStart.edges.some((e) => e.to === 'work'), 'в старт переходы не ведут')
  assert.equal(changeNodeType(wf, 'work', 'work'), wf)
})

test('select «куда ведёт»: смена цели порта и снятие перехода', () => {
  const next = setPortTarget(wf, 'review', 'reject', 'conflict')
  assert.equal(portTarget(next, 'review', 'reject'), 'conflict')
  assert.equal(next.edges.find((e) => e.from === 'review' && e.outcome === 'reject')?.id, 'e_review_reject')
  const cut = setPortTarget(next, 'review', 'reject', null)
  assert.equal(portTarget(cut, 'review', 'reject'), undefined)
  assert.equal(setPortTarget(cut, 'review', 'reject', null), cut)
  assert.equal(setPortTarget(wf, 'review', 'reject', 'start'), wf, 'в старт вести нельзя')
  assert.ok(!targetOptions(wf).some((o) => o.id === 'start'))
  assert.equal(targetOptions(wf).find((o) => o.id === 'merge')?.label, 'Мерж (merge)')
})

test('условие нового вида — с полями по умолчанию', () => {
  assert.deepEqual(conditionOfKind(wf, 'attempts'), { kind: 'attempts', node: 'work', atLeast: 3 })
  assert.deepEqual(conditionOfKind(wf, 'role'), { kind: 'role', roleIds: [] })
})

test('экспорт и импорт JSON: круг без потерь, мусор — понятная ошибка', () => {
  const back = parseWorkflowJson(exportWorkflowJson(wf))
  assert.deepEqual(back, { workflow: wf })
  assert.match((parseWorkflowJson('{') as { error: string }).error, /^файл не JSON/)
  assert.match((parseWorkflowJson('[]') as { error: string }).error, /не воркфлоу/)
  assert.match((parseWorkflowJson('{"version":1,"nodes":{}}') as { error: string }).error, /nodes и edges/)
  assert.match((parseWorkflowJson('{"version":99,"nodes":[],"edges":[]}') as { error: string }).error, /обновите приложение/)
  assert.match((parseWorkflowJson('{"version":1,"nodes":[{"id":"a","type":"x","x":0,"y":0}],"edges":[]}') as { error: string }).error, /неизвестный тип «x»/)
  assert.match((parseWorkflowJson('{"version":1,"nodes":[{"id":"a"}],"edges":[]}') as { error: string }).error, /нода №1/)
  assert.match((parseWorkflowJson('{"version":1,"nodes":[],"edges":[{"id":"e"}]}') as { error: string }).error, /переход №1/)
  assert.equal(workflowFileName('my app: v2'), 'workflow-my-app-v2.json')
  assert.equal(workflowFileName('  '), 'workflow.json')
})

test('ошибки импорта и названия пресета — на языке интерфейса', () => {
  setLocale('en')
  try {
    assert.match((parseWorkflowJson('{') as { error: string }).error, /^not a JSON file/)
    assert.match((parseWorkflowJson('{"version":1,"nodes":[{"id":"a","type":"x","x":0,"y":0}],"edges":[]}') as { error: string }).error, /unknown type “x”/)
    const res = addRetryLimit(wf)
    assert.ok('workflow' in res)
    assert.ok(res.workflow.nodes.some((n) => n.title === 'Rejects ≥ 3'))
  } finally {
    setLocale('ru')
  }
})

test('пресет «3 отказа → человек»: граф валиден, третий отказ уходит человеку', () => {
  const res = addRetryLimit(wf)
  assert.ok('workflow' in res)
  const limited = res.workflow
  assert.equal(res.added, 1)
  assert.deepEqual(validateWorkflow(limited, ctx).errors, [])
  const run = { roleId: 'developer' }
  let stage: WfStage = { nodeId: 'review', visits: { start: 1, work: 1, review: 1 } }
  for (let i = 1; i <= 2; i++) {
    const step = nextStage(limited, stage, 'reject', run)
    assert.equal(step.stage.nodeId, 'work', `отказ ${i} — снова в работу`)
    stage = { ...step.stage, nodeId: 'review' }
  }
  const third = nextStage(limited, stage, 'reject', run)
  assert.equal(third.action.type, 'request_human')
  assert.equal(portTarget(limited, third.stage.nodeId, 'accept'), 'merge')
  assert.equal(portTarget(limited, third.stage.nodeId, 'reject'), 'work')

  const again = addRetryLimit(limited)
  assert.ok('error' in again, 'повторно лимит не ставится')
  assert.ok('error' in addRetryLimit(graphWithMerge([])), 'без проверки агентом ставить некуда')
})

test('ask: тип в select «Тип», без поля «Колонка»', () => {
  assert.ok(WF_TYPE_ORDER.includes('ask'))
  assert.equal(WF_TYPE_TITLES.ask, 'Вопрос человеку')
  assert.equal(hasColumn('ask'), false)
  assert.equal(hasColumn('work'), true)
})

test('patchNode для ask: роль опциональна, инструкция обязательна и не удаляется пустой', () => {
  const withAsk = changeNodeType(wf, 'review', 'ask')
  assert.equal(node(withAsk, 'review')?.type, 'ask')
  let next = patchNode(withAsk, 'review', { roleId: 'developer', instructions: 'Уточни срок' })
  assert.deepEqual(node(next, 'review'), { id: 'review', type: 'ask', x: node(wf, 'review')!.x, y: node(wf, 'review')!.y, title: node(wf, 'review')!.title, roleId: 'developer', instructions: 'Уточни срок' })
  next = patchNode(next, 'review', { roleId: '', instructions: '  ', column: 'review' })
  const n = node(next, 'review')
  assert.equal(n?.type === 'ask' && 'roleId' in n, false, 'пустая роль — «роль задачи»')
  assert.equal(n?.type === 'ask' && n.instructions, '  ', 'пустая инструкция остаётся строкой, а не пропадает')
  assert.ok(validateWorkflow(next, ctx).errors.some((e) => e.nodeId === 'review'), 'валидация подсвечивает пустое «О чём спросить»')
})

test('changeNodeType в ask и из него: роль и инструкция переносятся, колонка — нет, порты чистятся', () => {
  const work = patchNode(wf, 'work', { roleId: 'developer', instructions: 'Спроси про формат', column: 'review' })
  const ask = changeNodeType(work, 'work', 'ask')
  const a = node(ask, 'work')
  assert.equal(a?.type === 'ask' && a.roleId, 'developer')
  assert.equal(a?.type === 'ask' && a.instructions, 'Спроси про формат')
  assert.equal(a?.column, undefined, 'у ask колонки нет')
  assert.ok(ask.edges.some((e) => e.from === 'work' && e.outcome === 'next'))

  const back = changeNodeType(ask, 'work', 'work')
  const w = node(back, 'work')
  assert.equal(w?.type === 'work' && w.roleId, 'developer')
  assert.equal(w?.type === 'work' && w.instructions, 'Спроси про формат')

  // Гейт с двумя портами → ask с одним: лишние рёбра уходят.
  const fromGate = changeNodeType(wf, 'review', 'ask')
  assert.equal(fromGate.edges.filter((e) => e.from === 'review').every((e) => e.outcome === 'next'), true)
})
