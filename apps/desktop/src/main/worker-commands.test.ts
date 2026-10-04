import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { workerFixture } from '../../../../packages/runtime/test/worker-command-test-host.ts'
import * as adapter from './worker-commands'
import { OrcaError, ipcError, setMainLocale } from './i18n'
import type { WorkerLaunchResult } from '@orca-board/contracts'

type Event = { client: string | null }
const fixtures: ReturnType<typeof workerFixture>[] = []
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); setMainLocale('ru') })
function fixture() {
  assert.equal(typeof adapter.registerDesktopWorkerCommands, 'function', 'Desktop использует общий API воркера')
  const f = workerFixture((key, params) => new OrcaError(key, params)); fixtures.push(f)
  let active: string | undefined; let selections = 0
  f.host.authorize = context => context.clientId === 'desktop:1' && context.actor.kind === 'operator' && context.actor.id === 'local-user'
  const callbacks = new Map<string, (event: Event, ...args: unknown[]) => unknown>()
  adapter.registerDesktopWorkerCommands<Event>((channel, callback) => callbacks.set(channel, callback as (event: Event, ...args: unknown[]) => unknown), {
    commands: f.commands, activeProjectId: () => { selections++; return active }, clientId: event => event.client
  })
  assert.deepEqual([...callbacks.keys()], ['worker:start'])
  return { ...f, select: (id?: string) => { active = id }, selections: () => selections,
    call: async (...args: unknown[]) => callbacks.get('worker:start')!({ client: 'desktop:1' }, ...args),
    foreign: () => callbacks.get('worker:start')!({ client: null }) }
}
test('caller проверяется раньше selection, отсутствие проекта сохраняет projects.none', async () => {
  const f = fixture()
  assert.throws(() => f.foreign(), e => e instanceof OrcaError && e.key === 'command.forbidden')
  assert.equal(f.selections(), 0); assert.deepEqual(f.counts(), { lookups: 0, spawns: 0 })
  await assert.rejects(async () => await f.call('task', 80, 24), e => e instanceof OrcaError && e.key === 'projects.none')
})
test('capture selection один раз: прежний DTO/размеры/настоящий Git/dispatch, соседний проект не меняется', async () => {
  const f = fixture(); f.select('A'); const p = f.projects.get('A')!
  const task = p.store.createTask({ title: 'A', roleId: 'developer' }); const before = structuredClone(f.projects.get('B')!.store.snapshot())
  const result = await f.call(task.id, 100, 40) as WorkerLaunchResult
  assert.equal(f.selections(), 1); assert.deepEqual(Object.keys(result).sort(), ['branch', 'dispatchId', 'ptyId', 'worktree'])
  assert.equal(p.store.getDispatch(result.dispatchId)?.ptyId, result.ptyId)
  assert.equal(f.git(result.worktree, 'branch', '--show-current'), result.branch)
  assert.equal(f.processes[0].options.cols, 100); assert.equal(f.processes[0].options.rows, 40)
  assert.equal(p.store.getTask(task.id)?.statusHistory?.at(-1)?.by, 'human')
  assert.deepEqual(f.projects.get('B')!.store.snapshot(), before)
})
test('wrong project сохраняет чужой PTY, невалидные размеры отказывают до lookup', async () => {
  const f = fixture(); f.select('A'); const t = f.projects.get('A')!.store.createTask({ title: 'A', roleId: 'developer' })
  const first = await f.call(t.id) as WorkerLaunchResult; f.select('B')
  await assert.rejects(async () => await f.call(t.id), e => e instanceof OrcaError && e.key === 'command.taskNotFound')
  assert.equal(f.sessions.isAlive(first.ptyId), true)
  const before = f.counts(); await assert.rejects(async () => await f.call(t.id, 0, 24), e => e instanceof OrcaError && e.key === 'command.invalidInput')
  assert.deepEqual(f.counts(), before)
})
test('omitted dimensions сохраняют defaults 120×30', async () => {
  const f = fixture(); f.select('A'); const t = f.projects.get('A')!.store.createTask({ title: 'A', roleId: 'developer' })
  await f.call(t.id); assert.equal(f.processes[0].options.cols, 120); assert.equal(f.processes[0].options.rows, 30)
})
for (const language of ['ru', 'en'] as const) test(`host preflight сохраняет OrcaError и перевод ${language}`, async () => {
  const f = fixture(); f.select('A'); setMainLocale(language)
  const t = f.projects.get('A')!.store.createTask({ title: 'A', roleId: 'developer' }); const before = structuredClone(f.projects.get('A')!.store.snapshot())
  f.configs.get('A')!.agents = f.configs.get('A')!.agents.map(a => ({ ...a, enabled: false }))
  await assert.rejects(async () => await f.call(t.id), e => {
    assert.ok(e instanceof OrcaError); assert.equal(e.key, 'agent.disabled')
    const ipc = ipcError(e) as Error; assert.equal(ipc.name, 'OrcaError[agent.disabled]')
    assert.match(ipc.message, language === 'ru' ? /выключен/ : /disabled/i); return true
  })
  assert.deepEqual(f.projects.get('A')!.store.snapshot(), before); assert.equal(f.processes.length, 0)
})
