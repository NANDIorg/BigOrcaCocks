import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_COLUMNS, DEFAULT_ROLES, defaultWorkflow, nextStage, validateWorkflow, type WfStage, type Workflow } from '@orca-board/core'
import {
  WORKFLOW_STALE_MESSAGE, addRetryLimit, changeNodeType, conditionOfKind, exportWorkflowJson, isStaleWorkflowError,
  parseWorkflowJson, patchNode, portTarget, setPortTarget, stageRoles, targetOptions, workflowApi, workflowFileName
} from './workflowForm'

const wf = defaultWorkflow(DEFAULT_ROLES)
const node = (w: Workflow, id: string) => w.nodes.find((n) => n.id === id)
/** Роль ноды любого типа: у типов без роли — undefined. */
const roleOf = (w: Workflow, id: string): string | undefined => {
  const n = node(w, id)
  return n && 'roleId' in n ? n.roleId : undefined
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
  next = patchNode(next, 'work', { roleId: '', column: '', instructions: 'не для работы' })
  assert.deepEqual(node(next, 'work'), { id: 'work', type: 'work', x: 220, y: 0 })

  next = patchNode(wf, 'review', { roleId: '', instructions: '  ' })
  assert.equal(roleOf(next, 'review'), '')
  assert.ok(validateWorkflow(next, ctx).errors.some((e) => e.nodeId === 'review'))

  assert.equal(patchNode(wf, 'нет', { title: 'x' }), wf)
  assert.equal(node(wf, 'work')?.title, 'Работа', 'исходный граф не меняется')
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
  assert.ok('error' in addRetryLimit(defaultWorkflow([])), 'без проверки агентом ставить некуда')
})

test('старый main/preload: понятная ошибка вместо падения', () => {
  assert.throws(() => workflowApi(undefined), { message: WORKFLOW_STALE_MESSAGE })
  assert.throws(() => workflowApi({ projects: {}, workflow: {} }), { message: WORKFLOW_STALE_MESSAGE })
  const api = workflowApi({ projects: { setWorkflow: async () => ({ id: 'p', root: '/', name: 'p' }) }, workflow: { default: async () => wf } })
  assert.equal(typeof api.setWorkflow, 'function')
  assert.equal(isStaleWorkflowError("Error invoking remote method 'projects:setWorkflow': Error: No handler registered for 'projects:setWorkflow'"), true)
  assert.equal(isStaleWorkflowError('воркфлоу не сохранён: нет ноды «Старт»'), false)
})
