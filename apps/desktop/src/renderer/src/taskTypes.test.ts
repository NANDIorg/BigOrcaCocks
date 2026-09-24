import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_ROLES, presetTaskType, type Role, type TaskType } from '@orca-board/core'
import type { TaskTypesState } from '../../shared/ipc'
import {
  availableTypes, globalTypeTitle, isStaleTaskTypesError, libraryDefaultRoles, loadTaskTypes, projectDefaultTypeId,
  rolesForRun, rolesWithDisabledAgent, taskTypesApi, workflowForRun
} from './taskTypes'

const role = (id: string, agent: Role['agent'] = 'claude'): Role => ({ id, title: id, agent })
const type = (id: string, roles: Role[]): TaskType => ({ id, title: `Тип ${id}`, settings: { roles } })
const DOCS = type('docs', [role('coordinator'), role('writer', 'codex')])
const BACK = type('back', [role('coordinator'), role('developer'), role('qa')])
const STATE: TaskTypesState = { taskTypes: [presetTaskType('general')!, DOCS, BACK], defaultTaskTypeId: 'back' }
const ids = (roles: Role[]): string[] => roles.map((r) => r.id)

test('taskTypesApi / loadTaskTypes — старый preload или старый main: null, прочие ошибки пробрасываются', async () => {
  assert.equal(taskTypesApi(undefined), undefined)
  assert.equal(taskTypesApi({}), undefined)
  assert.equal(await loadTaskTypes({}), null)
  const stale = { taskTypes: { list: async () => { throw new Error("Error invoking remote method 'taskTypes:list': Error: No handler registered for 'taskTypes:list'") } } }
  assert.equal(await loadTaskTypes(stale), null)
  const ok = { taskTypes: { list: async () => STATE } }
  assert.deepEqual(await loadTaskTypes(ok), STATE)
  const broken = { taskTypes: { list: async () => { throw new Error('projects.json повреждён') } } }
  await assert.rejects(loadTaskTypes(broken), { message: 'projects.json повреждён' })
  assert.equal(isStaleTaskTypesError("No handler registered for 'projects:detectTaskType'"), true)
  assert.equal(isStaleTaskTypesError('тип задачи не найден: x'), false)
})

test('projectDefaultTypeId — свой, иначе библиотечный (если доступен), иначе первый доступный', () => {
  assert.equal(projectDefaultTypeId({ defaultTaskTypeId: 'docs' }, STATE), 'docs')
  assert.equal(projectDefaultTypeId({ defaultTaskTypeId: 'удалён' }, STATE), 'back')
  assert.equal(projectDefaultTypeId({}, STATE), 'back')
  assert.equal(projectDefaultTypeId({ taskTypeIds: ['general', 'docs'] }, STATE), 'general')
})

test('availableTypes — вся библиотека, список проекта без висячих id, пустой список — тип по умолчанию', () => {
  assert.deepEqual(availableTypes({}, STATE).map((t) => t.id), ['general', 'docs', 'back'])
  assert.deepEqual(availableTypes({ taskTypeIds: ['docs', 'удалён'] }, STATE).map((t) => t.id), ['docs'])
  assert.deepEqual(availableTypes({ taskTypeIds: ['удалён'], defaultTaskTypeId: 'docs' }, STATE).map((t) => t.id), ['docs'])
})

test('rolesForRun — задачи разных глобальных задач получают роли своего типа', () => {
  const runs = [
    { id: 'r_docs', typeId: 'docs' },
    { id: 'r_back', typeId: 'back' },
    // Тип удалён из библиотеки — роли из снимка прогона.
    { id: 'r_gone', typeId: 'gone', taskType: { id: 'gone', title: 'Старый', roles: [role('coordinator'), role('analyst')] } },
    // Прогон до типов / «Входящие» — тип проекта по умолчанию.
    { id: 'inbox' }
  ]
  const project = { defaultTaskTypeId: 'docs', roles: [role('старая')] }
  assert.deepEqual(ids(rolesForRun('r_docs', runs, project, STATE)), ['coordinator', 'writer'])
  assert.deepEqual(ids(rolesForRun('r_back', runs, project, STATE)), ['coordinator', 'developer', 'qa'])
  assert.deepEqual(ids(rolesForRun('r_gone', runs, project, STATE)), ['coordinator', 'analyst'])
  assert.deepEqual(ids(rolesForRun('inbox', runs, project, STATE)), ['coordinator', 'writer'])
  assert.deepEqual(ids(rolesForRun(undefined, runs, project, STATE)), ['coordinator', 'writer'])
  // Нет проекта — тип библиотеки по умолчанию.
  assert.deepEqual(ids(rolesForRun(undefined, [], null, STATE)), ['coordinator', 'developer', 'qa'])
})

test('rolesForRun — старый main без типов: встроенные роли (ролей у проекта больше нет)', () => {
  const runs = [{ id: 'r_docs', typeId: 'docs' }]
  assert.deepEqual(rolesForRun('r_docs', runs, {}, null), DEFAULT_ROLES)
  assert.deepEqual(rolesForRun(undefined, [], null, null), DEFAULT_ROLES)
})

test('libraryDefaultRoles — роли типа библиотеки по умолчанию (ассистент)', () => {
  assert.deepEqual(ids(libraryDefaultRoles(STATE)), ['coordinator', 'developer', 'qa'])
  assert.deepEqual(libraryDefaultRoles({ taskTypes: [], defaultTaskTypeId: 'нет' }).map((r) => r.id), ids(presetTaskType('general')!.settings.roles ?? DEFAULT_ROLES))
})

test('globalTypeTitle — из библиотеки, тип удалён — из снимка, «Входящие» и старый main — без бейджа', () => {
  assert.equal(globalTypeTitle({ inbox: false, typeId: 'docs', typeTitle: 'Старое имя' }, STATE), 'Тип docs')
  assert.equal(globalTypeTitle({ inbox: false, typeId: 'gone', typeTitle: 'Старое имя' }, STATE), 'Старое имя')
  assert.equal(globalTypeTitle({ inbox: false, typeId: 'gone', typeTitle: 'Старое имя' }, null), 'Старое имя')
  assert.equal(globalTypeTitle({ inbox: false, typeId: 'gone' }, STATE), 'gone')
  assert.equal(globalTypeTitle({ inbox: true, typeId: 'docs' }, STATE), undefined)
  assert.equal(globalTypeTitle({ inbox: false }, STATE), undefined)
})

test('rolesWithDisabledAgent — роли, чей агент выключен или не установлен; список агентов не пришёл — пусто', () => {
  const agents = [
    { id: 'claude' as const, installed: true, enabled: true },
    { id: 'codex' as const, installed: true, enabled: false }
  ]
  assert.deepEqual(ids(rolesWithDisabledAgent(DOCS, agents)), ['writer'])
  assert.deepEqual(rolesWithDisabledAgent(BACK, agents), [])
  assert.deepEqual(ids(rolesWithDisabledAgent(DOCS, [{ id: 'claude', installed: false, enabled: true }])), ['coordinator', 'writer'])
  assert.deepEqual(rolesWithDisabledAgent(DOCS, []), [])
})

test('workflowForRun — снимок графа прогона, иначе граф типа; нет типов и снимка — undefined', () => {
  const snapshot = { version: 1, nodes: [{ id: 'n1', type: 'start' as const, x: 0, y: 0 }], edges: [] }
  const withSnapshot = { id: 'r1', typeId: 'docs', workflow: snapshot }
  const byType = { id: 'r2', typeId: 'docs' }
  assert.equal(workflowForRun('r1', [withSnapshot], {}, STATE), snapshot)
  // Снимок есть — типы не нужны (старый main).
  assert.equal(workflowForRun('r1', [withSnapshot], {}, null), snapshot)
  assert.ok(workflowForRun('r2', [byType], {}, STATE)?.nodes.some((n) => n.type === 'work'))
  assert.equal(workflowForRun('r2', [byType], {}, null), undefined)
})
