import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultWorkflow, validateWorkflow, DEFAULT_ROLES, DEFAULT_COLUMNS } from '@orca-board/core'
import { addNode, connect, disconnect, issueTargets, moveNode, removeNode, removeSelected, uniqueId } from './workflowEdit'

const wf = defaultWorkflow([{ id: 'reviewer' }])

test('uniqueId подбирает свободный суффикс', () => {
  assert.equal(uniqueId('work', ['start']), 'work')
  assert.equal(uniqueId('work', ['work', 'work_2']), 'work_3')
})

test('addNode: уникальный id, поля по умолчанию, исходный граф не меняется', () => {
  const { workflow, nodeId } = addNode(wf, 'work', 10, 20)
  assert.equal(nodeId, 'work_2')
  assert.deepEqual(workflow.nodes.at(-1), { id: 'work_2', x: 10, y: 20, type: 'work' })
  assert.equal(wf.nodes.length + 1, workflow.nodes.length)

  const gate = addNode(wf, 'gate', 0, 0).workflow.nodes.at(-1)!
  assert.equal(gate.type === 'gate' && gate.roleId, '')
  const cond = addNode(wf, 'condition', 0, 0).workflow.nodes.at(-1)!
  assert.deepEqual(cond.type === 'condition' && cond.test, { kind: 'attempts', node: 'work', atLeast: 3 })
})

test('removeNode убирает ноду и все её рёбра', () => {
  const g = removeNode(wf, 'review')
  assert.equal(g.nodes.some((n) => n.id === 'review'), false)
  assert.equal(g.edges.some((e) => e.from === 'review' || e.to === 'review'), false)
  assert.ok(g.edges.some((e) => e.id === 'e_merge_ok'))
  assert.equal(removeNode(wf, 'нет'), wf)
})

test('moveNode меняет только координаты своей ноды', () => {
  const g = moveNode(wf, 'work', 5, 7)
  assert.deepEqual([g.nodes.find((n) => n.id === 'work')!.x, g.nodes.find((n) => n.id === 'work')!.y], [5, 7])
  assert.equal(g.nodes.find((n) => n.id === 'start'), wf.nodes.find((n) => n.id === 'start'))
  assert.equal(moveNode(wf, 'work', 220, 0), wf, 'без сдвига — тот же объект')
})

test('connect заменяет ребро порта, сохраняя его id', () => {
  const { workflow, edgeId } = connect(wf, 'review', 'reject', 'conflict')
  assert.equal(edgeId, 'e_review_reject')
  const rejects = workflow.edges.filter((e) => e.from === 'review' && e.outcome === 'reject')
  assert.deepEqual(rejects, [{ id: 'e_review_reject', from: 'review', outcome: 'reject', to: 'conflict' }])
  assert.equal(workflow.edges.length, wf.edges.length)
})

test('connect на пустой порт создаёт ребро с новым id; петля в себя разрешена', () => {
  const g = disconnect(wf, 'e_review_reject')
  const { workflow, edgeId } = connect(g, 'review', 'reject', 'review')
  assert.equal(edgeId, 'e_review_reject')
  assert.ok(workflow.edges.some((e) => e.id === edgeId && e.to === 'review'))
})

test('connect отвергает чужой порт, вход в старт и несуществующие ноды', () => {
  assert.equal(connect(wf, 'work', 'accept', 'merge').workflow, wf)
  assert.equal(connect(wf, 'work', 'next', 'start').workflow, wf)
  assert.equal(connect(wf, 'work', 'next', 'нет').workflow, wf)
  assert.equal(connect(wf, 'end', 'next', 'work').workflow, wf)
  assert.equal(connect(wf, 'work', 'accept', 'merge').edgeId, undefined)
})

test('disconnect и removeSelected', () => {
  assert.equal(disconnect(wf, 'e_merge_ok').edges.some((e) => e.id === 'e_merge_ok'), false)
  assert.equal(disconnect(wf, 'нет'), wf)
  assert.equal(removeSelected(wf, null), wf)
  assert.equal(removeSelected(wf, { kind: 'edge', id: 'e_start' }).edges.length, wf.edges.length - 1)
  assert.equal(removeSelected(wf, { kind: 'node', id: 'end' }).nodes.length, wf.nodes.length - 1)
})

test('issueTargets: проблемы по нодам и рёбрам, ошибка важнее предупреждения', () => {
  const broken = disconnect(addNode(wf, 'merge', 0, 400).workflow, 'e_review_reject')
  const issues = validateWorkflow(broken, { roles: DEFAULT_ROLES, columns: DEFAULT_COLUMNS })
  const t = issueTargets(issues)
  assert.equal(t.nodes.get('review')?.level, 'error')
  assert.equal(t.nodes.get('merge_2')?.level, 'error', 'у новой ноды нет переходов')
  assert.ok(t.nodes.get('merge_2')!.messages.some((m) => m.includes('недостижима')))
  assert.equal(issueTargets(undefined).nodes.size, 0)
  const mixed = issueTargets({ errors: [{ message: 'e', edgeId: 'x' }], warnings: [{ message: 'w', edgeId: 'x' }] })
  assert.deepEqual(mixed.edges.get('x'), { level: 'error', messages: ['e', 'w'] })
})
