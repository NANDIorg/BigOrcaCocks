import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_COLUMNS, DEFAULT_ROLES } from '@orca-board/core'
import type { ClientCommandContext, RuntimeSettingsPatch, TaskTypeInput, TaskTypePatch, NodeTemplateInput } from '@orca-board/contracts'
import { CommandError } from '../src/index.ts'
import { operator, profileFixture, profileGraph, ProfileHostError } from './profile-command-test-host.ts'

const fixtures: Awaited<ReturnType<typeof profileFixture>>[] = []
afterEach(() => { for (const f of fixtures.splice(0)) f.close() })
async function fixture() { const f = (await profileFixture()); fixtures.push(f); return f }
const invalid = (fn: () => unknown) => assert.rejects(async () => fn(), e => e instanceof CommandError && e.code === 'command.invalidInput')
const disk = (f: Awaited<ReturnType<typeof fixture>>) => readFileSync(join(f.dataDir, 'projects.json'), 'utf8')

test('policy и контекст профиля проверяются до manager lookup', async () => {
  const f = (await fixture()); f.deny()
  assert.throws(() => f.commands.settings(operator), e => e instanceof CommandError && e.code === 'command.forbidden')
  assert.throws(() => f.commands.settings({ clientId: '', actor: operator.actor }), e => e instanceof CommandError && e.code === 'command.invalidContext')
  assert.throws(() => f.commands.settings({ clientId: 'one', actor: { kind: 'root', id: 'person' } } as unknown as ClientCommandContext), e => e instanceof CommandError && e.code === 'command.invalidContext')
  assert.equal(f.lookups(), 0)
})
test('агент не получает operator/settings/export права автоматически', async () => {
  const f = (await fixture()); const agent: ClientCommandContext = { clientId: 'agent', actor: { kind: 'agent', id: 'dispatch' } }
  assert.throws(() => f.commands.exportTaskType(agent, 'general'), e => e instanceof CommandError && e.code === 'command.forbidden')
  assert.equal(f.metaReads(), 0); assert.equal(f.lookups(), 0)
})
for (const [name, call] of [
  ['settings unknown key', (f: Awaited<ReturnType<typeof fixture>>) => f.commands.setSettings(operator, { endpoint: 'forged' } as RuntimeSettingsPatch)],
  ['settings nested unknown key', (f: Awaited<ReturnType<typeof fixture>>) => f.commands.setSettings(operator, { assistant: { cwd: '/secret' } } as RuntimeSettingsPatch)],
  ['notifications roles null', (f: Awaited<ReturnType<typeof fixture>>) => f.commands.setSettings(operator, { notifications: { roles: null } } as never)],
  ['notifications roles array', (f: Awaited<ReturnType<typeof fixture>>) => f.commands.setSettings(operator, { notifications: { roles: [] } } as never)],
  ['group collapsed type', (f: Awaited<ReturnType<typeof fixture>>) => f.commands.setGroupCollapsed(operator, 'g', 'yes' as unknown as boolean)],
  ['sparse reorder', (f: Awaited<ReturnType<typeof fixture>>) => f.commands.reorderGroups(operator, new Array<string>(1))],
  ['onboarding unknown field', (f: Awaited<ReturnType<typeof fixture>>) => f.commands.completeOnboarding(operator, { status: 'completed' } as never)],
  ['type top unknown field', (f: Awaited<ReturnType<typeof fixture>>) => f.commands.saveTaskType(operator, { title: 'T', settings: {}, revision: 'forged' } as TaskTypeInput)],
  ['type settings unknown field', (f: Awaited<ReturnType<typeof fixture>>) => f.commands.patchTaskType(operator, 'general', { ownerId: 'forged' } as TaskTypePatch)],
  ['template timestamp', (f: Awaited<ReturnType<typeof fixture>>) => f.commands.saveNodeTemplate(operator, { title: 'T', node: { type: 'merge' }, updatedAt: 1 } as NodeTemplateInput)],
  ['project path empty', async (f: Awaited<ReturnType<typeof fixture>>) => (await f.commands.addProject(operator, ''))],
  ['workflow selectors malformed', (f: Awaited<ReturnType<typeof fixture>>) => f.commands.workflowValidate(operator, profileGraph(), { typeId: 1 } as never)],
  ['workflow context unknown field', (f: Awaited<ReturnType<typeof fixture>>) => f.commands.workflowContext(operator, { mode: 'create', system: 'forged' })],
  ['workflow context sparse path', (f: Awaited<ReturnType<typeof fixture>>) => f.commands.workflowContext(operator, { mode: 'edit', typeId: 'general', title: '',
    workflow: profileGraph(), baseline: profileGraph(), dirty: false, path: new Array<string>(1) })]
] as const) test(`payload до manager/files: ${name}`, async () => {
  const f = (await fixture()); const before = disk(f); await invalid(() => call(f))
  assert.equal(f.lookups(), 0); assert.equal(disk(f), before)
})
test('list DTO не содержит active и изменение копии не затрагивает manager', async () => {
  const f = (await fixture()); const result = f.commands.listProjects(operator)
  assert.equal('active' in result, false); result.projects[0].name = 'Forged'
  result.projects[0].columns![0].title = 'Forged column'
  assert.equal(f.manager.get(f.a.id)?.name, 'A'); assert.notEqual(f.manager.columns(f.a.id)[0].title, 'Forged column')
})
test('add другого клиента не меняет legacy selection, persisted root и старый default add сохраняются', async () => {
  const f = (await fixture()); const root = f.repo('C'); const other = { ...operator, clientId: 'two' }
  const project = (await f.commands.addProject(other, root))
  assert.equal(f.manager.active()?.id, f.a.id); assert.equal(f.reload().get(project.id)?.root, root)
  assert.equal((await f.commands.addProject(operator, root)).id, project.id); assert.equal(f.manager.active()?.id, f.a.id)
  await f.manager.add(root); assert.equal(f.manager.active()?.id, project.id)
  assert.equal(f.commands.detectTaskType(operator, root).path, root)
})
test('group lifecycle сохраняет проекты, порядок и DTO после reload', async () => {
  const f = (await fixture()); const one = f.commands.createGroup(operator, ' One '); const two = f.commands.createGroup(operator, 'Two')
  f.config.setGroup({ ...operator, projectId: f.b.id }, one.id)
  assert.equal(f.manager.get(f.a.id)?.groupId, undefined); assert.equal(f.manager.get(f.b.id)?.groupId, one.id)
  assert.equal(f.commands.renameGroup(operator, one.id, 'Renamed').name, 'Renamed')
  assert.equal(f.commands.setGroupCollapsed(operator, one.id, true).collapsed, true)
  assert.deepEqual(f.commands.reorderGroups(operator, [two.id, one.id]).map(g => g.id), [two.id, one.id])
  assert.deepEqual(f.reload().groups().map(g => g.id), [two.id, one.id])
  f.commands.removeGroup(operator, one.id)
  assert.equal(f.manager.get(f.b.id)?.groupId, undefined); assert.equal(f.manager.list().length, 2)
})
test('несуществующий group и неполный reorder не изменяют файл', async () => {
  const f = (await fixture()); f.commands.createGroup(operator, 'One'); const before = disk(f)
  assert.throws(() => f.commands.renameGroup(operator, 'missing', 'x'), e => e instanceof CommandError && e.cause instanceof ProfileHostError && e.cause.key === 'projects.groupNotFound')
  assert.throws(() => f.commands.reorderGroups(operator, [])); assert.equal(disk(f), before)
})
test('настройки сохраняются между владельцами, результат не разделяет references', async () => {
  const f = (await fixture()); const patch = { language: 'en' as const, assistant: { model: ' m ', systemPrompt: ' x ' } }
  const result = f.commands.setSettings(operator, patch)
  assert.equal(result.assistant.model, 'm'); assert.equal(result.assistant.systemPrompt, ' x ')
  result.assistant.model = 'Forged'; assert.equal(f.commands.settings(operator).assistant.model, 'm')
  assert.equal(f.reload().settings().language, 'en'); assert.deepEqual(patch.assistant, { model: ' m ', systemPrompt: ' x ' })
})
test('ошибка settings persistence откатывает память/файл и не публикует событие', async () => {
  const f = (await fixture()); f.commands.setSettings(operator, { language: 'ru' }); const before = disk(f)
  let events = 0; f.manager.onDataChange(() => { events++ }); mkdirSync(join(f.dataDir, 'projects.json.tmp'))
  assert.throws(() => f.commands.setSettings(operator, { language: 'en' })); assert.equal(f.manager.settings().language, 'ru')
  assert.equal(disk(f), before); assert.equal(events, 0)
})
test('onboarding доступен без выбора проекта и complete идемпотентен', async () => {
  const f = (await fixture()); assert.equal(f.commands.onboardingState(operator).required, true)
  const completed = f.commands.completeOnboarding(operator, { skipped: true })
  assert.equal(completed.status, 'skipped'); assert.deepEqual(f.commands.completeOnboarding(operator), completed)
  assert.deepEqual(f.reload().onboardingState(), completed)
})
test('проектная конфигурация принадлежит context, чужой id не использует active', async () => {
  const f = (await fixture()); const ctx = { ...operator, projectId: f.b.id }
  f.config.setEnabledAgents(ctx, ['codex']); assert.deepEqual(f.manager.get(f.b.id)?.enabledAgents, ['codex'])
  assert.equal(f.manager.get(f.a.id)?.enabledAgents, undefined)
  const columns = structuredClone(DEFAULT_COLUMNS); columns[0].title = 'New'
  f.config.setColumns(ctx, columns); assert.equal(f.manager.columns(f.b.id)[0].title, 'New')
  assert.notEqual(f.manager.columns(f.a.id)[0].title, 'New'); assert.equal(f.manager.active()?.id, f.a.id)
  assert.throws(() => f.config.setGroup({ ...operator, projectId: 'missing' }, null), e => e instanceof CommandError && e.code === 'command.projectNotFound')
})
test('невалидные project agents/sparse columns/taskTypes отклоняются до manager', async () => {
  const f = (await fixture()); const ctx = { ...operator, projectId: f.b.id }
  invalid(() => f.config.setEnabledAgents(ctx, ['invalid'] as never))
  invalid(() => f.config.setColumns(ctx, new Array(1)))
  invalid(() => f.config.setTaskTypes(ctx, { typeIds: new Array<string>(1), defaultTypeId: 'general' }))
  assert.equal(f.lookups(), 0)
})
test('клиент не добавляет неизвестные управляющие поля колонок', async () => {
  const f = (await fixture()); const ctx = { ...operator, projectId: f.b.id }
  const columns = DEFAULT_COLUMNS.map(column => ({ ...column, locked: true }))
  invalid(() => f.config.setColumns(ctx, columns)); assert.equal(f.lookups(), 0)
})
test('task types CRUD, default и project whitelist сохраняют guards', async () => {
  const f = (await fixture()); const type = f.commands.saveTaskType(operator, { title: 'New', settings: { roles: structuredClone(DEFAULT_ROLES) } })
  const copy = f.commands.duplicateTaskType(operator, type.id); assert.notEqual(copy.id, type.id)
  f.commands.renameTaskType(operator, type.id, 'Renamed', 'Description')
  f.commands.patchTaskType(operator, type.id, { agentRules: 'Rules' })
  assert.equal(f.commands.taskTypes(operator).taskTypes.find(t => t.id === type.id)?.settings.agentRules, 'Rules')
  f.commands.setDefaultTaskType(operator, type.id)
  f.config.setTaskTypes({ ...operator, projectId: f.b.id }, { typeIds: [type.id], defaultTypeId: type.id })
  assert.equal(f.manager.projectDefaultTypeId(f.b.id), type.id); assert.equal(f.reload().defaultTaskTypeId(), type.id)
  f.commands.deleteTaskType(operator, copy.id); assert.equal(f.manager.taskType(copy.id), undefined)
})
test('template timestamp задаёт runtime, insertions и delete проходят настоящую validation', async () => {
  const f = (await fixture()); const before = Date.now()
  const template = f.commands.saveNodeTemplate(operator, { title: 'Merge', node: { type: 'merge' } })
  assert.ok(template.updatedAt >= before); assert.ok(template.updatedAt <= Date.now())
  template.title = 'Forged'; assert.equal(f.commands.nodeTemplates(operator)[0].title, 'Merge')
  assert.equal(f.reload().nodeTemplates()[0].id, template.id)
  assert.deepEqual(f.commands.deleteNodeTemplate(operator, template.id), [])
  assert.throws(() => f.commands.saveNodeTemplate(operator, { title: 'Bad', node: { type: 'start' } as never }))
  assert.deepEqual(f.manager.nodeTemplates(), [])
})
test('export metadata берёт host, exported text не пишет/меняет библиотеку', async () => {
  const f = (await fixture()); const before = disk(f); const result = f.commands.exportTaskType(operator, 'general')
  const file = JSON.parse(result.text) as Record<string, unknown>
  assert.equal(file.appVersion, '2.3.4'); assert.equal(file.exportedAt, '2026-10-04T00:00:00Z')
  assert.match(result.fileName, /\.json$/); assert.equal(f.metaReads(), 1); assert.equal(disk(f), before)
})
test('workflow validate без записи, stale revision и baseline не перезаписывают новую базу', async () => {
  const f = (await fixture()); const context = f.commands.workflowGet(operator, 'general'); const before = disk(f)
  const prepared = f.commands.workflowValidate(operator, profileGraph(), { typeId: 'general' }); assert.equal(prepared.errors.length, 0)
  assert.equal(disk(f), before)
  f.commands.workflowSet(operator, 'general', context.revision, profileGraph()); const saved = disk(f)
  assert.throws(() => f.commands.workflowSet(operator, 'general', context.revision, profileGraph()))
  assert.throws(() => f.commands.saveWorkflowDraft(operator, 'general', context.workflow, null))
  assert.equal(disk(f), saved)
  const created = f.commands.workflowCreate(operator, { title: 'Created', definition: profileGraph() })
  assert.equal(f.manager.taskType(created.typeId)?.title, 'Created')
})
test('workflow assistant context не выпускает extraArgs, draft save остаётся явным действием', async () => {
  const f = (await fixture()); const roles = structuredClone(DEFAULT_ROLES); roles[0].extraArgs = '--private'
  f.commands.patchTaskType(operator, 'general', { roles }); const context = f.commands.workflowGet(operator, 'general')
  const before = disk(f); const text = f.commands.workflowContext(operator, { mode: 'edit', typeId: 'general', title: 'Forged title',
    workflow: context.workflow, baseline: context.workflow, dirty: true, path: [] })
  assert.equal(text.includes('--private'), false); assert.equal(text.includes('"extraArgs"'), false)
  assert.equal(text.includes('Forged title'), false); assert.match(text, /"dirty":false/); assert.equal(disk(f), before)
  assert.match(f.commands.workflowContext(operator, { mode: 'create' }), /Контекст редактора/)
  f.commands.saveWorkflowDraft(operator, 'general', context.workflow, profileGraph())
  assert.deepEqual(f.manager.taskTypeWorkflow('general').workflow, profileGraph())
})
test('remove проекта чистит только его профиль, соседняя доска остаётся', async () => {
  const f = (await fixture()); const run = f.manager.store(f.b.id).createRun('Keep')
  f.commands.removeProject(operator, f.a.id)
  assert.equal(f.reload().get(f.a.id), undefined); assert.equal(f.reload().store(f.b.id).getRun(run.id)?.objective, 'Keep')
  assert.equal(f.commands.inProgressCounts(operator)[f.b.id] ?? 0, 0)
})
