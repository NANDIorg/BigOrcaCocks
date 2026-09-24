import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_COLUMNS, DEFAULT_ROLES, GENERAL_TASK_TYPE_ID, builtinTaskType, type AgentInfo, type Role, type TaskType
} from '@orca-board/core'
import type { OrcaApi, Project, TaskTypesState } from '../../shared/ipc'
import {
  TASK_TYPES_STALE_MESSAGE, TASK_TYPE_TABS, allTypesInput, defaultTypeInput, typeRemovalConfirm,
  hasProjectTaskTypes, isTypeAvailable, libraryAgents, libraryRoles, overridesBuiltinType, patchedTaskType, pickTaskTypeId,
  projectDefaultTypeId, renamedTaskType, resolveTypeSettings, rolesWithAgentOff, splitTaskTypes, taskTypeLibraryApi,
  taskTypeUsage, taskTypesError, toggledProjectTypes, typeColumnChoices, typeEditorKey
} from './taskTypeEdit'

const general = builtinTaskType('general')!
const frontend = builtinTaskType('frontend')!
const own: TaskType = {
  id: 'type_1', title: 'Мой', description: 'для сервисов',
  settings: { permissionMode: 'acceptEdits', agentRules: 'правило' }
}
const state: TaskTypesState = { taskTypes: [general, frontend, own], defaultTaskTypeId: 'general' }
const project = (id: string, extra: Partial<Project> = {}): Project => ({ id, root: `/${id}`, name: id, ...extra })

test('старый preload без taskTypes — понятная ошибка, старый main — «перезапустите»', () => {
  assert.throws(() => taskTypeLibraryApi({} as Partial<OrcaApi>), { message: TASK_TYPES_STALE_MESSAGE })
  assert.throws(() => taskTypeLibraryApi(undefined), { message: TASK_TYPES_STALE_MESSAGE })
  assert.equal(taskTypesError("Error: No handler registered for 'taskTypes:list'"), TASK_TYPES_STALE_MESSAGE)
  assert.equal(taskTypesError("Error: No handler registered for 'projects:setTaskTypes'"), TASK_TYPES_STALE_MESSAGE)
  assert.equal(taskTypesError('тип задачи: пустое название'), 'тип задачи: пустое название')
  assert.equal(hasProjectTaskTypes({ projects: {} } as unknown as Partial<OrcaApi>), false)
})

test('у типа нет вкладок колонок и агентов — они у проекта', () => {
  assert.deepEqual([...TASK_TYPE_TABS], ['roles', 'workflow', 'perm', 'rules'])
})

test('незаданные разделы типа — встроенные значения', () => {
  const r = resolveTypeSettings({})
  assert.equal(r.permissionMode, 'auto')
  assert.equal(r.roles, DEFAULT_ROLES)
  assert.equal(r.agentRules, '')
  assert.equal('workflow' in r, false)
})

test('правка собирает тип целиком: null и пустые правила удаляют поле, остальное не трогается', () => {
  const input = patchedTaskType(own, { permissionMode: null, agentRules: '  \n', roles: DEFAULT_ROLES })
  assert.deepEqual(input, { id: 'type_1', title: 'Мой', description: 'для сервисов', settings: { roles: DEFAULT_ROLES } })
  assert.equal(own.settings.agentRules, 'правило')
})

test('переименование: пустое название — ошибка, пустое описание убирает поле', () => {
  assert.deepEqual(renamedTaskType(own, '  ', 'x'), { error: 'Название типа не может быть пустым' })
  const r = renamedTaskType(own, ' Сервисы ', ' ')
  assert.ok(!('error' in r))
  assert.equal(r.title, 'Сервисы')
  assert.equal('description' in r, false)
})

test('встроенные отдельно от своих; изменённый встроенный — среди встроенных, удаление сбросит к системному', () => {
  const generalCopy: TaskType = { ...general, builtin: undefined }
  assert.deepEqual(splitTaskTypes([generalCopy, frontend, own]).builtin.map((t) => t.id), ['general', 'frontend'])
  assert.deepEqual(splitTaskTypes([generalCopy, frontend, own]).own.map((t) => t.id), ['type_1'])
  assert.equal(overridesBuiltinType(generalCopy), true)
  assert.equal(overridesBuiltinType(general), false)
  assert.equal(overridesBuiltinType(own), false)
})

test('ключ редакторов не меняется, когда встроенный становится изменённым, и меняется по rev', () => {
  const copy: TaskType = { ...frontend, builtin: undefined }
  assert.equal(typeEditorKey(copy), typeEditorKey(frontend))
  assert.notEqual(typeEditorKey(frontend, 1), typeEditorKey(frontend, 0))
  assert.notEqual(typeEditorKey(own), typeEditorKey(frontend))
})

test('встроенный тип правится целиком: patchedTaskType и renamedTaskType сохраняют его id', () => {
  const roles = [...(frontend.settings.roles ?? DEFAULT_ROLES).filter((r) => r.id !== 'qa'), { id: 'designer', title: 'Дизайнер', agent: 'claude' as const }]
  const input = patchedTaskType(frontend, { roles, permissionMode: 'acceptEdits', workflow: null })
  assert.equal(input.id, 'frontend')
  assert.deepEqual(input.settings.roles?.map((r) => r.id), roles.map((r) => r.id))
  assert.equal(input.settings.permissionMode, 'acceptEdits')
  assert.equal('workflow' in input.settings, false)
  const renamed = renamedTaskType(frontend, 'Мой фронт', 'своё')
  assert.ok(!('error' in renamed))
  assert.equal(renamed.id, 'frontend')
  assert.equal(renamed.title, 'Мой фронт')
})

test('использование: тип по умолчанию и доступность по проектам', () => {
  const usage = taskTypeUsage([
    project('a', { defaultTaskTypeId: 'type_1' }),
    project('b', { taskTypeIds: ['frontend'], defaultTaskTypeId: 'frontend' }),
    project('c', { defaultTaskTypeId: 'type_gone' })
  ], state)
  assert.deepEqual(usage.type_1, { asDefault: 1, available: 2 })
  assert.deepEqual(usage.frontend, { asDefault: 1, available: 3 })
  assert.deepEqual(usage.general, { asDefault: 1, available: 2 })
})

test('выбранный тип: запомненный, если есть, иначе по умолчанию', () => {
  assert.equal(pickTaskTypeId(state, 'frontend'), 'frontend')
  assert.equal(pickTaskTypeId(state, 'type_gone'), 'general')
  assert.equal(pickTaskTypeId(state, null), 'general')
})

test('тип проекта по умолчанию — как в main', () => {
  assert.equal(projectDefaultTypeId(project('a', { defaultTaskTypeId: 'type_1' }), state), 'type_1')
  assert.equal(projectDefaultTypeId(project('a', { defaultTaskTypeId: 'gone' }), state), 'general')
  assert.equal(projectDefaultTypeId(project('a', { taskTypeIds: ['type_1', 'frontend'] }), state), 'frontend')
})

test('включение и выключение типа в проекте', () => {
  const all = project('a', { defaultTaskTypeId: 'general' })
  assert.deepEqual(toggledProjectTypes(all, state, 'frontend', false), { typeIds: ['general', 'type_1'], defaultTypeId: 'general' })
  assert.match((toggledProjectTypes(all, state, 'general', false) as { error: string }).error, /по умолчанию нельзя выключить/)
  const one = project('b', { taskTypeIds: ['general'], defaultTaskTypeId: 'general' })
  // Включили все — снова «все типы библиотеки», в том числе будущие.
  const two = toggledProjectTypes(one, state, 'frontend', true)
  assert.deepEqual(two, { typeIds: ['general', 'frontend'], defaultTypeId: 'general' })
  assert.deepEqual(toggledProjectTypes({ ...one, taskTypeIds: ['general', 'frontend'] }, state, 'type_1', true), { typeIds: null, defaultTypeId: 'general' })
  assert.equal(isTypeAvailable(one, 'frontend'), false)
  assert.equal(isTypeAvailable(all, 'frontend'), true)
  assert.deepEqual(allTypesInput(one, state, true), { typeIds: null, defaultTypeId: 'general' })
  assert.deepEqual(allTypesInput(all, state, false), { typeIds: ['general', 'frontend', 'type_1'], defaultTypeId: 'general' })
  assert.deepEqual(defaultTypeInput(one, 'type_1'), { typeIds: ['general', 'type_1'], defaultTypeId: 'type_1' })
  assert.deepEqual(defaultTypeInput(all, 'type_1'), { typeIds: null, defaultTypeId: 'type_1' })
})

test('роли с выключенным в проекте агентом; роли библиотеки для уведомлений без повторов', () => {
  const a = (id: string, enabled: boolean): AgentInfo => ({ id, title: id, installed: true, enabled }) as unknown as AgentInfo
  const roles: Role[] = [{ id: 'developer', title: 'Dev', agent: 'claude' }, { id: 'qa', title: 'QA', agent: 'codex' }]
  assert.deepEqual(rolesWithAgentOff(roles, [a('claude', true), a('codex', false)]).map((r) => r.id), ['qa'])
  assert.deepEqual(libraryAgents([a('codex', false)]).map((x) => x.enabled), [true])
  const ids = libraryRoles([general, frontend, own]).map((r) => r.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.includes('developer'))
})

test('колонки для графа типа — встроенные плюс колонки проектов без повторов', () => {
  const cols = typeColumnChoices([project('a', { columns: [...DEFAULT_COLUMNS, { id: 'qa', title: 'QA', color: '#fff', kind: 'custom' }] })])
  assert.equal(cols.length, DEFAULT_COLUMNS.length + 1)
  assert.equal(cols.at(-1)?.id, 'qa')
})

test('подтверждение удаления говорит о проектах и снимке глобальных задач', () => {
  const c = typeRemovalConfirm(own, { ...state, defaultTaskTypeId: 'type_1' }, { asDefault: 2, available: 3 })
  assert.equal(c.title, 'Удалить тип «Мой»?')
  assert.equal(c.action, 'Удалить')
  const text = c.lines.join('\n')
  assert.ok(text.includes(`им станет «${builtinTaskType(GENERAL_TASK_TYPE_ID)?.title}»`))
  assert.match(text, /проектах \(2\)/)
  assert.match(text, /по снимку/)
})

test('изменённый встроенный: вместо удаления — «Сбросить к системному», проекты остаются на типе', () => {
  const c = typeRemovalConfirm({ ...general, builtin: undefined, title: 'Мой общий' }, state, { asDefault: 2, available: 3 })
  assert.equal(c.title, 'Сбросить «Мой общий» к системному?')
  assert.equal(c.action, 'Сбросить')
  const text = c.lines.join('\n')
  assert.match(text, new RegExp(`к встроенному типу «${general.title}»`))
  assert.match(text, /останутся на нём/)
  assert.doesNotMatch(text, /перейдут на тип библиотеки/)
})
