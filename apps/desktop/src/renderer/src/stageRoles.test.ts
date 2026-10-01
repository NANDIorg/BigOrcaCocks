import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_ROLES, presetTaskTypes, wfWorkRoleIds, type AgentInfo, type Role, type TaskType, type Workflow } from '@orca-board/core'
import { checkRoleNodes, chosenCount, pickPathRole, roleAgentState, stageRoleBrief, stageRolesView, toggleStageRole } from './stageRoles'
import { libraryAgents } from './taskTypeEdit'
import { patchNode } from './workflowForm'
import { graphWithMerge } from './workflowFixture'
import { setLocale } from './i18n'

setLocale('ru')

const preset = (id: string): TaskType => {
  const found = presetTaskTypes().find((x) => x.id === id)
  assert.ok(found, `нет заготовки ${id}`)
  return found
}
/** Роли и граф заготовки: у заготовок они заданы всегда. */
const settingsOf = (id: string): { roles: Role[]; workflow: Workflow } => {
  const { roles, workflow } = preset(id).settings
  assert.ok(roles && workflow)
  return { roles, workflow }
}
const backend = settingsOf('backend')
const docs = settingsOf('docs')
const ids = (xs: readonly { id: string }[]): string[] => xs.map((x) => x.id)
const agent = (id: string, enabled: boolean, installed = enabled): AgentInfo =>
  ({ id, title: id, installed, enabled, models: [], defaults: {} }) as unknown as AgentInfo
const view = (roles: readonly Role[], workflow: Workflow, chosen: readonly string[] = [], extra: Partial<Parameters<typeof stageRolesView>[0]> = {}) =>
  stageRolesView({ roles, workflow, scope: 'run', chosen, ...extra })

test('1. служебные роли не попадают ни в рабочие, ни в проверки', () => {
  const v = view(DEFAULT_ROLES, graphWithMerge(DEFAULT_ROLES))
  const all = [...ids(v.work), ...ids(v.checks)]
  assert.ok(!all.includes('coordinator') && !all.includes('assistant'))
  assert.ok(all.includes('developer'))
})

test('2. роль gate верхнего графа — в проверках с названиями нод; в пути подзадачи группы проверок нет', () => {
  const wf = graphWithMerge(DEFAULT_ROLES)
  const v = view(DEFAULT_ROLES, wf)
  assert.deepEqual(ids(v.checks), ['reviewer'])
  assert.deepEqual(v.checks[0].checkedBy, ['Ревью'])
  assert.ok(!ids(v.work).includes('reviewer'))
  assert.deepEqual(checkRoleNodes(wf), new Map([['reviewer', ['Ревью']]]))

  const sub = stageRolesView({ roles: DEFAULT_ROLES, workflow: wf, scope: 'subtask', chosen: [] })
  assert.deepEqual(sub.checks, [])
  assert.ok(ids(sub.work).includes('reviewer'))
  assert.equal(sub.work.find((r) => r.id === 'reviewer')?.checkedBy, undefined)
})

test('3. роль проверки — по графу, а не по id: у backend QA проверяет API, у docs reviewer проверяет факты, а добавленный QA остаётся рабочим', () => {
  const b = view(backend.roles, backend.workflow)
  assert.deepEqual(ids(b.checks), ['reviewer', 'qa'])
  assert.deepEqual(b.checks.find((r) => r.id === 'qa')?.checkedBy, ['Проверка API'])
  assert.deepEqual(ids(b.work), ['developer'])

  const qa = backend.roles.find((r) => r.id === 'qa')!
  const d = view([...docs.roles, qa], docs.workflow)
  assert.deepEqual(ids(d.checks), ['reviewer'])
  assert.deepEqual(d.checks[0].checkedBy, ['Точность и примеры'])
  assert.deepEqual(ids(d.work), ['writer', 'qa'])
})

test('4. «сироты»: нет в типе — missing, служебная — service; toggle их не теряет, снятие убирает', () => {
  const wf = graphWithMerge(DEFAULT_ROLES)
  const v = view(DEFAULT_ROLES, wf, ['developer', 'old_role', 'coordinator'])
  assert.deepEqual(v.orphans, [{ id: 'old_role', reason: 'missing' }, { id: 'coordinator', reason: 'service' }])
  assert.deepEqual(view(DEFAULT_ROLES.filter((r) => r.id !== 'assistant'), wf, ['assistant']).orphans, [{ id: 'assistant', reason: 'service' }], 'служебная, даже если её нет в типе')

  const chosen = ['developer', 'old_role']
  assert.deepEqual(toggleStageRole(chosen, 'qa', true), ['developer', 'old_role', 'qa'])
  assert.deepEqual(toggleStageRole(chosen, 'developer', true), ['developer', 'old_role'], 'без повторов')
  assert.deepEqual(toggleStageRole(chosen, 'developer', false), ['old_role'], 'сирота остаётся')
  assert.deepEqual(toggleStageRole(chosen, 'old_role', false), ['developer'])
  assert.deepEqual(chosen, ['developer', 'old_role'], 'исходный список не меняется')
})

test('5. режим: пусто — координатор, есть выбор — только выбранные, localChosen при пустом — только выбранные', () => {
  const wf = graphWithMerge(DEFAULT_ROLES)
  assert.equal(view(DEFAULT_ROLES, wf).mode, 'coordinator')
  assert.equal(view(DEFAULT_ROLES, wf, ['developer']).mode, 'chosen')
  assert.equal(view(DEFAULT_ROLES, wf, [], { localChosen: true }).mode, 'chosen')
})

test('6. одиночный roleId версии 1 у «Работы» виден как отмеченная роль', () => {
  const node = { type: 'work' as const, id: 'work', x: 0, y: 0, roleId: 'developer' }
  const v = view(DEFAULT_ROLES, graphWithMerge(DEFAULT_ROLES), wfWorkRoleIds(node))
  assert.deepEqual(v.work.filter((r) => r.checked).map((r) => r.id), ['developer'])
  assert.equal(v.mode, 'chosen')
})

test('7. состояние агента: нет списка — unknown без тревог; выключен — off; у типа — по установленности', () => {
  const wf = graphWithMerge(DEFAULT_ROLES)
  const none = view(DEFAULT_ROLES, wf)
  assert.ok([...none.work, ...none.checks].every((r) => r.state === 'unknown'))
  assert.deepEqual(ids(none.pool), ids(none.work), 'неизвестный агент не выкидывает роль из выбора координатора')

  assert.equal(roleAgentState(undefined), 'unknown')
  assert.equal(roleAgentState(agent('claude', true)), 'on')
  assert.equal(roleAgentState(agent('claude', false)), 'off')

  const off = view(DEFAULT_ROLES, wf, [], { agents: [agent('claude', false)] })
  assert.ok(off.work.every((r) => r.state === 'off'))
  const lib = view(DEFAULT_ROLES, wf, [], { agents: libraryAgents([agent('claude', false, true)]) })
  assert.ok(lib.work.every((r) => r.state === 'on'), 'у типа включён установленный агент, даже если выключен в проекте')
  const notInstalled = view(DEFAULT_ROLES, wf, [], { agents: libraryAgents([agent('claude', true, false)]) })
  assert.ok(notInstalled.work.every((r) => r.state === 'off'))
})

test('8. путь подзадачи: конфликт при 2+ ролях; pickPathRole — одна роль или пусто', () => {
  const wf = graphWithMerge(DEFAULT_ROLES)
  const sub = (chosen: string[]) => stageRolesView({ roles: DEFAULT_ROLES, workflow: wf, scope: 'subtask', chosen }).pathConflict
  assert.equal(sub(['developer', 'qa']), true)
  assert.equal(sub(['developer']), false)
  assert.equal(view(DEFAULT_ROLES, wf, ['developer', 'qa']).pathConflict, false, 'у этапа графа несколько ролей — норма')
  assert.deepEqual(pickPathRole('x'), ['x'])
  assert.deepEqual(pickPathRole(null), [])
})

test('9. снятие последней роли через patchNode убирает roleIds из ноды', () => {
  const wf = graphWithMerge(DEFAULT_ROLES)
  const workOf = (w: Workflow) => w.nodes.find((n) => n.type === 'work' && n.id === 'work') as { roleIds?: string[]; roleId?: string }
  const next = patchNode(wf, 'work', { roleIds: toggleStageRole(wfWorkRoleIds(workOf(wf)), 'developer', false) })
  const n = workOf(next)
  assert.ok(!('roleIds' in n) && !('roleId' in n))
  assert.equal(view(DEFAULT_ROLES, next, wfWorkRoleIds(n)).mode, 'coordinator')
})

test('10. pool — рабочие роли без выключенного агента; noDescription — пустое или пробельное описание', () => {
  const roles: Role[] = [
    ...DEFAULT_ROLES.filter((r) => r.id === 'coordinator' || r.id === 'reviewer'),
    { id: 'a', title: 'A', agent: 'claude', description: 'x' },
    { id: 'b', title: 'B', agent: 'codex', description: '   ' },
    { id: 'c', title: 'C', agent: 'claude' }
  ]
  const wf = graphWithMerge(DEFAULT_ROLES)
  const v = view(roles, wf, [], { agents: [agent('claude', true), agent('codex', false)] })
  assert.deepEqual(ids(v.work), ['a', 'b', 'c'])
  assert.deepEqual(ids(v.pool), ['a', 'c'])
  assert.deepEqual(v.noDescription, ['b', 'c'])
  assert.equal(v.work.find((r) => r.id === 'b')?.description, undefined)
})

test('stageRoleBrief: карточка роли под select и её проблемы', () => {
  const brief = stageRoleBrief(DEFAULT_ROLES, 'reviewer', [agent('claude', true)])
  assert.ok('role' in brief && brief.role.id === 'reviewer' && brief.role.state === 'on')
  assert.deepEqual(stageRoleBrief(DEFAULT_ROLES, ''), { problem: 'empty' })
  assert.deepEqual(stageRoleBrief(DEFAULT_ROLES, 'old_role'), { problem: 'missing' })
  assert.deepEqual(stageRoleBrief(DEFAULT_ROLES, 'coordinator'), { problem: 'service' })
})

test('chosenCount: «Выбрано N из M» — по строкам (рабочие и проверки), без «сирот»', () => {
  const v = view(DEFAULT_ROLES, graphWithMerge(DEFAULT_ROLES), ['developer', 'reviewer', 'old_role'])
  assert.deepEqual(chosenCount(v), { n: 2, total: v.work.length + v.checks.length })
  assert.deepEqual(chosenCount(view(DEFAULT_ROLES, graphWithMerge(DEFAULT_ROLES))).n, 0)
})
