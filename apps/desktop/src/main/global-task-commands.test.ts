import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore, DEFAULT_ROLES, type GlobalTask } from '@orca-board/core'
import { createGlobalTaskCommands, createAgentSelection } from '@orca-board/runtime'
import * as adapter from './global-task-commands'
import { executionResources } from './execution-resources'
import { OrcaError, ipcError, setMainLocale } from './i18n'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
type Event = { client: string | null }
const channels = ['list', 'get', 'create', 'update', 'changeType', 'move', 'remove', 'tasks', 'createTask', 'addImages', 'removeImage', 'image']

function fixture(native = false) {
  assert.equal(typeof adapter.registerDesktopGlobalTaskCommands, 'function', 'Нужен Desktop adapter общего API')
  const dir = mkdtempSync(join(tmpdir(), 'orca-desktop-global-commands-')); dirs.push(dir)
  let active: string | undefined; let installed = true; let selections = 0; let lookups = 0
  const stores = new Map(['A', 'B'].map(id => [id, new TaskStore()]))
  const commands = createGlobalTaskCommands({
    isCurrent: (project, context) => stores.get(context.projectId) === project.store,
    authorize: ctx => ctx.clientId === 'desktop:1' && ctx.actor.kind === 'operator' && ctx.actor.id === 'local-user',
    dataDir: dir, resources: executionResources, messages: { error: key => new OrcaError(key) },
    sessions: { isAlive: () => false, kill: () => {} },
    selection: createAgentSelection({ error: (key, params) => new OrcaError(key, params) }),
    project: id => {
      lookups++
      const store = stores.get(id)
      return store ? { store, root: dir, runType: (typeId = 'default') => {
        if (typeId !== 'default') throw new OrcaError('global.typeRequired')
        return { typeId, snapshot: { id: typeId, title: 'Default', roles: [DEFAULT_ROLES[0]] } }
      }, roles: () => ({ title: 'Default', roles: [DEFAULT_ROLES[0]] }), agents: () => [
        { id: DEFAULT_ROLES[0].agent, title: 'Agent', installed, enabled: true, models: [], defaults: {} }
      ] } : undefined
    }
  })
  const handlers = new Map<string, (event: Event, ...args: unknown[]) => unknown>()
  const opened: string[] = []; const revealed: string[] = []
  adapter.registerDesktopGlobalTaskCommands<Event>((channel, handler) => {
    handlers.set(channel, handler as (event: Event, ...args: unknown[]) => unknown)
  }, { commands, activeProjectId: () => { selections++; return active }, clientId: event => event.client,
    ...(native ? { attachments: {
      reveal: (ctx: { projectId: string }, id: string, imageId: string) => { revealed.push(executionResources.revealTaskAttachment(stores.get(ctx.projectId)!, executionResources.runImagesRoot(dir), ctx.projectId, id, imageId)) },
      open: async (ctx: { projectId: string }, id: string, imageId: string) => { opened.push(executionResources.openTaskAttachment(stores.get(ctx.projectId)!, executionResources.runImagesRoot(dir), ctx.projectId, id, imageId)) }
    } } : {}) })
  return { stores, commands, opened, revealed, select: (id?: string) => { active = id }, uninstall: () => { installed = false },
    counts: () => ({ selections, lookups }),
    call: async (channel: string, ...args: unknown[]) => handlers.get(`globalTasks:${channel}`)!({ client: 'desktop:1' }, ...args),
    foreign: (channel: string) => handlers.get(`globalTasks:${channel}`)!({ client: null }) }
}

test('legacy list пуст без проекта; все 12 callbacks отвергают чужого caller прежде selection', async () => {
  const f = fixture()
  for (const channel of channels) assert.throws(() => f.foreign(channel), e => e instanceof OrcaError && e.key === 'command.forbidden')
  assert.deepEqual(f.counts(), { selections: 0, lookups: 0 })
  assert.deepEqual(await f.call('list'), [])
  await assert.rejects(async () => await f.call('create', { title: 'No' }), e => e instanceof OrcaError && e.key === 'projects.none')
})

test('legacy channels выполняют CRUD/types/subtasks/attachments через настоящие common services', async () => {
  const f = fixture(); f.select('A')
  const images = [{ mime: 'image/jpeg', name: 'shot.png', data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) }]
  const run = await f.call('create', { title: 'A' }, images) as GlobalTask
  assert.equal((await f.call('image', run.id, run.images![0].id) as { mime: string }).mime, 'image/png')
  await f.call('addImages', run.id, images); await f.call('removeImage', run.id, run.images![0].id)
  await f.call('changeType', run.id, 'default'); await f.call('update', run.id, { title: 'Updated', priority: 'high' })
  assert.equal((await f.call('get', run.id) as GlobalTask).title, 'Updated')
  assert.equal((await f.call('list') as GlobalTask[]).length, 1)
  const child = await f.call('createTask', run.id, { title: 'Child', answerFor: 'human' }) as { id: string; runId: string; statusHistory: { by: string }[] }
  assert.equal(child.runId, run.id); assert.equal(child.statusHistory[0].by, 'human')
  assert.equal((await f.call('tasks', run.id) as unknown[]).length, 1)
  await f.call('move', run.id, 'in_progress')
  await assert.rejects(async () => await f.call('remove', run.id, null), /cascade/)
  await assert.rejects(async () => await f.call('update', run.id, null), /укажи/)
  assert.deepEqual(await f.call('remove', run.id, { cascade: true }), { deleted: run.id, tasks: [child.id] })
  assert.equal(f.stores.get('A')!.listRuns().length, 0)
})

test('переключение legacy selection не меняет run соседнего проекта и не даёт mass assignment', async () => {
  const f = fixture(); f.select('A'); const run = await f.call('create', { title: 'A' }) as GlobalTask
  f.select('B'); await f.call('create', { title: 'B' })
  await assert.rejects(async () => await f.call('get', run.id), e => e instanceof OrcaError && e.key === 'command.globalTaskNotFound')
  f.select('A')
  await assert.rejects(async () => await f.call('createTask', run.id, { title: 'No', runId: 'other', agent: 'claude' }), e => e instanceof OrcaError && e.key === 'command.invalidInput')
  assert.equal(f.stores.get('A')!.listTasks().length, 0); assert.equal(f.stores.get('B')!.listGlobalTasks()[0].title, 'B')
  const ctx = { projectId: 'A', clientId: 'desktop:1', actor: { kind: 'agent' as const, id: 'local-user' } }
  assert.throws(() => f.commands.list(ctx), /Нет доступа/)
})

test('локализация boundary/type/role ошибок сохраняется в старой IPC обёртке', async () => {
  const f = fixture(); f.select('A'); const run = await f.call('create', { title: 'A' }) as GlobalTask
  setMainLocale('en')
  try {
    for (const [action, key] of [
      [async () => await f.call('get', 'missing'), 'command.globalTaskNotFound'],
      [async () => await f.call('create', { title: 'No', typeId: 'missing' }), 'global.typeRequired']
    ] as const) await assert.rejects(async () => await (action)(), error => {
      const translated = ipcError(error); assert.ok(translated instanceof Error)
      assert.equal(translated.name, `OrcaError[${key}]`); assert.doesNotMatch(translated.message, /[А-Яа-я]/); return true
    })
    f.uninstall()
    await assert.rejects(async () => await f.call('createTask', run.id, { title: 'No' }), error => {
      const translated = ipcError(error); assert.ok(translated instanceof Error)
      assert.equal(translated.name, 'OrcaError[agent.notInstalled]'); assert.doesNotMatch(translated.message, /[А-Яа-я]/); return true
    })
  } finally { setMainLocale('ru') }
})

test('legacy ошибка вложения сохраняет причину и не создаёт задачу', async () => {
  const f = fixture(); f.select('A')
  await assert.rejects(async () => await f.call('create', { title: 'No' }, [{ name: 'empty.txt', data: new Uint8Array() }]), /нет данных/)
  assert.equal(f.stores.get('A')!.listRuns().length, 0)
})

test('native attachment channels verify caller before selection and shared file guards before OS effect', async () => {
  const f = fixture(true)
  for (const name of ['revealAttachment', 'openAttachment']) await assert.rejects(async () => f.foreign(name), e => e instanceof OrcaError && e.key === 'command.forbidden')
  assert.deepEqual(f.counts(), { selections: 0, lookups: 0 }); assert.deepEqual(f.opened, []); assert.deepEqual(f.revealed, [])
  f.select('A'); const bytes = new Uint8Array(Buffer.from('hello'))
  const run = await f.call('create', { title: 'A' }, [{ name: 'hello.md', data: bytes }]) as GlobalTask
  const id = run.images![0].id
  await f.call('revealAttachment', run.id, id); await f.call('openAttachment', run.id, id)
  assert.equal(readFileSync(f.opened[0], 'utf8'), 'hello'); assert.equal(readFileSync(f.revealed[0], 'utf8'), 'hello')
  f.select('B'); await assert.rejects(async () => await f.call('openAttachment', run.id, id))
  f.select('A'); await assert.rejects(async () => await f.call('openAttachment', run.id, '../foreign'))
  assert.equal(f.opened.length, 1); assert.equal(f.revealed.length, 1)
})
