import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_COLUMNS } from '@orca-board/core'
import { createProfileCommands, createProjectConfigCommands, createWorkflowAssistantServices, writeFileAtomic } from '@orca-board/runtime'
import type { ClientCommandContext, Project, TaskTypesState } from '@orca-board/contracts'
import type { AppSettings } from '../shared/ipc'
import { ProjectManager } from './projects'
import { OrcaError, ipcError, setMainLocale } from './i18n'
import * as adapter from './profile-commands'

type Event = { client: string | null }
const close: (() => void)[] = []
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); setMainLocale('ru') })
const channels = ['app:getSettings', 'app:setSettings', 'onboarding:getState', 'onboarding:complete',
  'projects:list', 'projects:createGroup', 'projects:renameGroup', 'projects:removeGroup', 'projects:setGroupCollapsed',
  'projects:setProjectGroup', 'projects:reorderGroups', 'projects:inProgressCounts', 'projects:setActive', 'projects:remove',
  'projects:setEnabledAgents', 'projects:setColumns', 'projects:add', 'projects:detectTaskType', 'projects:setTaskTypes',
  'taskTypes:list', 'taskTypes:patch', 'taskTypes:rename', 'workflowAssistant:save', 'taskTypes:save', 'taskTypes:delete',
  'taskTypes:duplicate', 'taskTypes:setDefault', 'taskTypes:export', 'nodeTemplates:list', 'nodeTemplates:save', 'nodeTemplates:delete']

function fixture() {
  assert.equal(typeof adapter.registerDesktopProfileCommands, 'function', 'Desktop подключает общий profile/config API')
  const dir = mkdtempSync(join(tmpdir(), 'orca-desktop-profile-commands-'))
  close.push(() => rmSync(dir, { recursive: true, force: true }))
  const pm = new ProjectManager(join(dir, 'profile'))
  const repo = (name: string) => { const root = join(dir, name); mkdirSync(root); execFileSync('git', ['init', '-q', root], { stdio: 'pipe' }); return realpathSync(root) }
  const a = pm.add(repo('A')); const b = pm.add(repo('B')); pm.setActive(a.id)
  let lookups = 0; let selections = 0; let folders = 0; let files = 0; let settingsEffects = 0
  let folder: string | null = null; let file: string | null = null; let selection: Project | null = a
  const authorize = (ctx: ClientCommandContext) => ctx.clientId === 'desktop:1' && ctx.actor.kind === 'operator' && ctx.actor.id === 'local-user'
  const host = { manager: () => { lookups++; return pm }, authorize, settingsKeys: ['keepInBackground', 'updates'],
    workflowAssistant: createWorkflowAssistantServices({ messages: { Error: OrcaError } }),
    exportMeta: () => ({ appVersion: '1.1.3', exportedAt: '2026-10-04T00:00:00Z' }) }
  const callbacks = new Map<string, (event: Event, ...args: unknown[]) => unknown>()
  adapter.registerDesktopProfileCommands<Event>((channel, fn) => callbacks.set(channel, fn as (event: Event, ...args: unknown[]) => unknown), {
    commands: createProfileCommands(host), config: createProjectConfigCommands(host), clientId: e => e.client,
    activeProject: () => { selections++; return selection }, setActive: id => { selection = pm.setActive(id); return structuredClone(selection) },
    chooseFolder: async () => { folders++; return folder }, chooseExportFile: async () => { files++; return file },
    writeExport: writeFileAtomic, settingsChanged: (_settings: AppSettings) => { settingsEffects++ }
  })
  assert.deepEqual([...callbacks.keys()].sort(), [...channels].sort())
  return { dir, pm, a, b, repo, lookups: () => lookups, selections: () => selections, folders: () => folders, files: () => files,
    effects: () => settingsEffects, chooseFolder: (path: string | null) => { folder = path }, chooseFile: (path: string | null) => { file = path },
    select: (project: Project | null) => { selection = project },
    call: (channel: string, ...args: unknown[]) => callbacks.get(channel)!({ client: 'desktop:1' }, ...args),
    foreign: (channel: string) => callbacks.get(channel)!({ client: null }) }
}
test('caller всех 31 каналов проверяется до selection/manager/native dialogs', async () => {
  const f = fixture()
  for (const channel of channels) await assert.rejects(async () => f.foreign(channel), e => e instanceof OrcaError && e.key === 'command.forbidden')
  assert.equal(f.lookups(), 0); assert.equal(f.selections(), 0); assert.equal(f.folders(), 0); assert.equal(f.files(), 0)
})
test('профиль/onboarding/list доступны без выбранного проекта, legacy list содержит active=null', () => {
  const f = fixture(); f.select(null)
  assert.equal((f.call('app:getSettings') as AppSettings).keepInBackground, true)
  assert.equal((f.call('onboarding:complete', null) as { status: string }).status, 'completed')
  const result = f.call('projects:list') as { active: Project | null; projects: Project[] }
  assert.equal(result.active, null); assert.equal(result.projects.length, 2)
  result.projects[0].name = 'Forged'; assert.equal(f.pm.get(f.a.id)?.name, 'A')
})
test('Desktop settings fields и refresh вызываются после успешной записи', () => {
  const f = fixture(); const result = f.call('app:setSettings', { keepInBackground: false, updates: { autoDownload: false }, language: 'en' }) as AppSettings
  assert.equal(result.keepInBackground, false); assert.equal(result.updates.autoDownload, false); assert.equal(result.language, 'en'); assert.equal(f.effects(), 1)
  f.call('app:setSettings', null); assert.equal(f.effects(), 2)
  assert.throws(() => f.call('app:setSettings', { assistant: { agent: 'invalid' } }), e => e instanceof OrcaError && e.key === 'assistant.unknownAgent')
  assert.equal(f.effects(), 2); assert.equal(f.pm.settings().language, 'en')
})
test('explicit project ids не используют legacy active при configuration/group', () => {
  const f = fixture(); f.call('projects:setEnabledAgents', f.b.id, ['codex'])
  const columns = structuredClone(DEFAULT_COLUMNS); columns[0].title = 'New'
  f.call('projects:setColumns', f.b.id, columns)
  const group = f.call('projects:createGroup', 'Group') as { id: string }
  f.call('projects:setProjectGroup', f.b.id, group.id)
  f.call('projects:setTaskTypes', f.b.id, { typeIds: ['general'], defaultTypeId: 'general' })
  assert.equal(f.pm.get(f.a.id)?.enabledAgents, undefined); assert.equal(f.pm.get(f.a.id)?.groupId, undefined)
  assert.deepEqual(f.pm.get(f.b.id)?.enabledAgents, ['codex']); assert.equal(f.pm.get(f.b.id)?.groupId, group.id)
  assert.equal(f.selections(), 0)
})
test('native folder cancel не меняет библиотеку; explicit path не открывает dialog, add выбирает его в Desktop', async () => {
  const f = fixture(); const before = f.pm.list()
  assert.equal(await f.call('projects:add'), null); assert.equal(await f.call('projects:detectTaskType'), null)
  assert.deepEqual(f.pm.list(), before); assert.equal(f.folders(), 2)
  const root = f.repo('C'); const project = await f.call('projects:add', undefined, root) as Project
  assert.equal(f.pm.active()?.id, project.id); assert.equal(f.folders(), 2)
  assert.equal((f.call('projects:list') as { active: Project }).active.id, project.id)
  f.chooseFolder(root); assert.equal((await f.call('projects:detectTaskType') as { path: string }).path, root)
})
test('native export cancel и successful write сохраняют old DTO и host metadata', async () => {
  const f = fixture(); assert.equal(await f.call('taskTypes:export', 'general'), null)
  const file = join(f.dir, 'export.json'); f.chooseFile(file)
  assert.deepEqual(await f.call('taskTypes:export', 'general'), { path: file })
  const exported = JSON.parse(readFileSync(file, 'utf8')) as { appVersion: string }; assert.equal(exported.appVersion, '1.1.3')
  assert.equal(f.files(), 2)
  await assert.rejects(async () => f.call('taskTypes:export', 'missing'), e => e instanceof OrcaError && e.key === 'type.notFound')
  assert.equal(f.files(), 2)
})
test('ошибка native export write сохраняет прежний type.exportFailed с путём', async () => {
  const f = fixture(); const block = join(f.dir, 'blocked'); writeFileSync(block, 'block')
  const file = join(block, 'export.json'); f.chooseFile(file)
  await assert.rejects(async () => f.call('taskTypes:export', 'general'), e => e instanceof OrcaError && e.key === 'type.exportFailed' && e.params?.path === file)
  assert.equal(existsSync(file), false)
})
test('types/templates CRUD и guards идут через общий manager, old return DTO сохраняется', () => {
  const f = fixture(); const type = f.call('taskTypes:save', { title: 'New', settings: {} }) as { id: string }
  f.call('taskTypes:rename', type.id, 'Renamed', 'Desc'); f.call('taskTypes:patch', type.id, { agentRules: 'Rules' })
  const copy = f.call('taskTypes:duplicate', type.id) as { id: string }; assert.notEqual(copy.id, type.id)
  assert.equal((f.call('taskTypes:setDefault', type.id) as TaskTypesState).defaultTaskTypeId, type.id)
  f.call('taskTypes:delete', copy.id); assert.equal(f.pm.taskType(copy.id), undefined)
  const template = f.call('nodeTemplates:save', { title: 'Merge', node: { type: 'merge' } }) as { id: string }
  assert.equal((f.call('nodeTemplates:list') as unknown[]).length, 1); assert.deepEqual(f.call('nodeTemplates:delete', template.id), [])
})
for (const language of ['ru', 'en'] as const) test(`workflow baseline conflict сохраняет локализацию ${language} и прежний граф`, () => {
  const f = fixture(); setMainLocale(language); const baseline = f.pm.workflowGet('general').workflow
  const next = structuredClone(baseline); next.nodes[0].title = 'Changed'; f.pm.patchTaskType('general', { workflow: next })
  assert.throws(() => f.call('workflowAssistant:save', 'general', baseline, null), e => {
    assert.ok(e instanceof OrcaError); assert.equal(e.key, 'workflow.conflict')
    assert.match((ipcError(e) as Error).message, language === 'ru' ? /измен/ : /changed/); return true
  })
  assert.deepEqual(f.pm.workflowGet('general').workflow, next)
})
