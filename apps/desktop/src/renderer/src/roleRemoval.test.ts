import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_ROLES, defaultWorkflow, type Role, type Workflow } from '@orca-board/core'
import { setLocale } from './i18n'
import { taskTypeRunsLoss, isSystemRole, missingSystemRoles, removalConsequences, removeBlocker, restoreSystemRoles, workflowNodesWithRole } from './roleRemoval'

afterEach(() => setLocale('ru'))

const ids = (roles: readonly Role[]): string[] => roles.map((r) => r.id)
const custom: Role = { id: 'role_x', title: 'Аналитик', agent: 'codex' }

test('системные роли — все из DEFAULT_ROLES, пользовательская — нет', () => {
  for (const r of DEFAULT_ROLES) assert.equal(isSystemRole(r.id), true, r.id)
  assert.equal(isSystemRole(custom.id), false)
})

test('удалить можно любую роль, кроме последней', () => {
  assert.equal(removeBlocker(DEFAULT_ROLES), undefined)
  assert.equal(removeBlocker([custom]), 'Нельзя удалить последнюю роль')
})

test('у каждой системной роли есть последствия удаления и подсказка про возврат', () => {
  for (const r of DEFAULT_ROLES) {
    const lines = removalConsequences(r.id)
    assert.ok(lines.length >= 2, r.id)
    assert.ok(lines.some((l) => l.includes('Вернуть системные роли')), r.id)
  }
  assert.match(removalConsequences('coordinator').join('\n'), /запустить прогон/)
  assert.match(removalConsequences('reviewer').join('\n'), /задачи ревью/)
})

test('пользовательская роль: без задач подтверждать нечего, с задачами — предупреждение', () => {
  assert.deepEqual(removalConsequences(custom.id), [])
  assert.deepEqual(removalConsequences(custom.id, 0), [])
  assert.deepEqual(removalConsequences(custom.id, 3), ['Задачи на этой роли (3) не запустятся, пока роль не вернут.'])
})

test('недостающие системные роли — копии дефолта', () => {
  const roles = DEFAULT_ROLES.filter((r) => r.id !== 'reviewer' && r.id !== 'coordinator')
  const missing = missingSystemRoles(roles)
  assert.deepEqual(ids(missing), ['coordinator', 'reviewer'])
  missing[0].title = 'изменено'
  assert.equal(DEFAULT_ROLES[0].title, 'Координатор')
  assert.deepEqual(missingSystemRoles(DEFAULT_ROLES), [])
})

test('возврат ставит роли на место из дефолта и не трогает остальные', () => {
  const edited: Role = { ...DEFAULT_ROLES.find((r) => r.id === 'developer')!, model: 'opus' }
  const roles = [edited, custom, DEFAULT_ROLES.find((r) => r.id === 'qa')!]
  const next = restoreSystemRoles(roles)
  assert.deepEqual(ids(next), ['coordinator', 'assistant', 'developer', 'role_x', 'reviewer', 'qa'])
  assert.equal(next[2], edited)
  assert.deepEqual(ids(roles), ['developer', 'role_x', 'qa'])
})

test('без оставшихся системных ролей возвращённые встают в конец в порядке дефолта', () => {
  assert.deepEqual(ids(restoreSystemRoles([custom])), ['role_x', ...ids(DEFAULT_ROLES)])
  assert.deepEqual(ids(restoreSystemRoles(DEFAULT_ROLES)), ids(DEFAULT_ROLES))
})

test('роль, занятая в своём воркфлоу, попадает в последствия удаления', () => {
  const wf = defaultWorkflow([{ id: 'developer' }, { id: 'reviewer' }])
  const withCond: Workflow = {
    ...wf,
    nodes: [...wf.nodes, { id: 'c', type: 'condition', title: 'Аналитик?', x: 0, y: 0, test: { kind: 'role', roleIds: ['role_x'] } }]
  }
  assert.deepEqual(workflowNodesWithRole(withCond, 'reviewer'), ['Ревью'])
  assert.deepEqual(workflowNodesWithRole(withCond, 'role_x'), ['Аналитик?'])
  assert.deepEqual(workflowNodesWithRole(undefined, 'reviewer'), [])

  const lines = removalConsequences('reviewer', undefined, withCond)
  assert.ok(lines.some((l) => l.startsWith('Роль занята в воркфлоу: «Ревью».')), lines.join('\n'))
  assert.match(removalConsequences(custom.id, 0, withCond).join('\n'), /«Аналитик\?»/)
  // Дефолтный граф не передаётся: без своего графа строки про воркфлоу нет.
  assert.ok(!removalConsequences('reviewer').some((l) => l.includes('воркфлоу')))
})

test('граф с ролью отправляет во вкладку «Воркфлоу» типа, а не в удалённый раздел «О проекте»', () => {
  const lines = removalConsequences('reviewer', undefined, defaultWorkflow([{ id: 'developer' }, { id: 'reviewer' }])).join('\n')
  assert.match(lines, /вкладке «Воркфлоу» типа \(Настройки → Типы задач\)/)
  assert.ok(!lines.includes('О проекте'), lines)
})

test('удаление роли из типа задачи предупреждает про незакрытые глобальные задачи', () => {
  assert.deepEqual(removalConsequences(custom.id, undefined, undefined, true), [taskTypeRunsLoss()])
  assert.match(taskTypeRunsLoss(), /^Незакрытые глобальные задачи этого типа потеряют роль со следующего запуска агента\.$/)
  assert.ok(removalConsequences('developer', undefined, undefined, true).includes(taskTypeRunsLoss()))
  // Без типа (роль не из библиотеки) строки нет.
  assert.ok(!removalConsequences('developer').includes(taskTypeRunsLoss()))
})

test('последствия удаления — на языке интерфейса', () => {
  setLocale('en')
  assert.equal(removeBlocker([custom]), 'Can’t delete the last role')
  assert.deepEqual(removalConsequences(custom.id, 3), ['Tasks with this role (3) won’t start until the role is back.'])
  const lines = removalConsequences('reviewer', undefined, defaultWorkflow([{ id: 'developer' }, { id: 'reviewer' }])).join('\n')
  // Встроенное название ноды «Ревью» из core на английском показывается переведённым (defaultTitles.ts).
  assert.match(lines, /used in the workflow: “Review”/)
  assert.match(lines, /Restore system roles/)
})

test('роль на этапе «Вопрос человеку» тоже считается занятой', () => {
  const wf = defaultWorkflow([{ id: 'developer' }, { id: 'reviewer' }])
  const withAsk: Workflow = {
    ...wf,
    nodes: [...wf.nodes, { id: 'ask', type: 'ask', title: 'Уточнение', x: 0, y: 0, roleId: 'role_x', instructions: 'о чём спросить' }]
  }
  assert.deepEqual(workflowNodesWithRole(withAsk, 'role_x'), ['Уточнение'])
  assert.match(removalConsequences('role_x', undefined, withAsk).join('\n'), /«Уточнение»/)
  // ask без роли роль не занимает.
  const noRole: Workflow = { ...wf, nodes: [...wf.nodes, { id: 'ask', type: 'ask', x: 0, y: 0, instructions: 'x' }] }
  assert.deepEqual(workflowNodesWithRole(noRole, 'role_x'), [])
})
