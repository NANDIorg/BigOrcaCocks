import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { coordinatorFixture, feedbackFile } from '../../../../packages/runtime/test/coordinator-command-test-host.ts'
import * as adapter from './coordinator-commands'
import { OrcaError, ipcError, setMainLocale } from './i18n'

type Event = { client: string | null }
const fixtures: ReturnType<typeof coordinatorFixture>[] = []
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); setMainLocale('ru') })
const channels = ['coordinator:start', 'globalTasks:startCoordinator', 'globalTasks:accept', 'globalTasks:returnToWork']
function fixture() {
  assert.equal(typeof adapter.registerDesktopCoordinatorCommands, 'function', 'Desktop использует общий API координатора')
  const f = coordinatorFixture(key => new OrcaError(key)); fixtures.push(f)
  let active: string | undefined; let selections = 0
  f.host.authorize = context => context.clientId === 'desktop:1' && context.actor.kind === 'operator' && context.actor.id === 'local-user'
  const callbacks = new Map<string, (event: Event, ...args: unknown[]) => unknown>()
  adapter.registerDesktopCoordinatorCommands<Event>((channel, callback) => callbacks.set(channel, callback as (event: Event, ...args: unknown[]) => unknown), {
    commands: f.commands, activeProjectId: () => { selections++; return active }, clientId: event => event.client
  })
  return { ...f, select: (id?: string) => { active = id }, selections: () => selections,
    call: (channel: string, ...args: unknown[]) => callbacks.get(channel)!({ client: 'desktop:1' }, ...args),
    foreign: (channel: string) => callbacks.get(channel)!({ client: null }) }
}
test('четыре legacy callback отвергают caller прежде selection, без проекта сохраняют projects.none', () => {
  const f = fixture()
  for (const channel of channels) assert.throws(() => f.foreign(channel), e => e instanceof OrcaError && e.key === 'command.forbidden')
  assert.equal(f.selections(), 0); assert.deepEqual(f.counts(), { lookups: 0, spawns: 0 })
  assert.throws(() => f.call('coordinator:start', 'X', 80, 24), e => e instanceof OrcaError && e.key === 'projects.none')
})
test('старые launch DTO — ptyId строка; callback captures selection один раз и не меняет соседний проект', () => {
  const f = fixture(); f.select('A')
  const first = f.call('coordinator:start', 'A', 100, 40, feedbackFile)
  assert.equal(typeof first, 'string'); assert.equal(f.selections(), 1)
  const run = f.projects.get('A')!.store.listRuns()[0]
  assert.equal(run.coordinatorPtyId, first); assert.equal(f.processes[0].options.cols, 100)
  f.sessions.killPty(first as string)
  const second = f.call('globalTasks:startCoordinator', run.id, 90, 30)
  assert.equal(typeof second, 'string'); assert.notEqual(second, first); assert.equal(f.selections(), 2)
  f.select('B')
  assert.throws(() => f.call('globalTasks:returnToWork', run.id, 'Fix', 90, 30), e => e instanceof OrcaError && e.key === 'command.globalTaskNotFound')
  assert.equal(f.projects.get('B')!.store.listRuns().length, 0)
})
test('legacy accept decision fallback остаётся только в adapter, результат — GlobalTask', () => {
  const f = fixture(); f.select('A'); const store = f.projects.get('A')!.store
  const run = store.createGlobalTask({ title: 'Legacy', status: 'review' })
  const result = f.call('globalTasks:accept', run.id, 42) as { id: string; status: string }
  assert.equal(result.id, run.id); assert.equal(result.status, 'done')
  assert.equal(store.getRun(run.id)?.statusHistory?.at(-1)?.by, 'human')
})
test('legacy return нестроковый текст становится пустым; замечания с файлами проходят общий runtime', () => {
  const f = fixture(); f.select('A'); const store = f.projects.get('A')!.store
  const run = store.createGlobalTask({ title: 'Legacy', status: 'review' })
  assert.throws(() => f.call('globalTasks:returnToWork', run.id, 42, 80, 24), /уточнени/)
  assert.equal(store.getRun(run.id)?.status, 'review')
  const pty = f.call('globalTasks:returnToWork', run.id, 'Fix legacy', 80, 24, feedbackFile)
  assert.equal(typeof pty, 'string'); assert.equal(store.getRun(run.id)?.returns?.at(-1)?.text, 'Fix legacy')
  assert.ok(existsSync(store.getRun(run.id)!.returns!.at(-1)!.images![0]))
})
test('legacy run scope return возвращает живой терминал, failed restart сохраняет files и host код ru/en', () => {
  const f = fixture(); f.select('A'); const store = f.projects.get('A')!.store
  const first = f.call('coordinator:start', 'X', 80, 24) as string; const run = store.listRuns()[0]
  f.finishWork(run.id)
  assert.equal(f.call('globalTasks:returnToWork', run.id, 'First fix', 80, 24), first)
  f.finishWork(run.id); f.sessions.killPty(first); f.fail()
  setMainLocale('en')
  assert.throws(() => f.call('globalTasks:returnToWork', run.id, 'Retry', 80, 24, feedbackFile), e => {
    assert.ok(e instanceof OrcaError); assert.equal(e.key, 'workflow.coordinatorNotRunning')
    const ipc = ipcError(e) as Error; assert.equal(ipc.name, 'OrcaError[workflow.coordinatorNotRunning]'); assert.match(ipc.message, /coordinator/i)
    return true
  })
  assert.equal(store.getRun(run.id)?.stageInput?.feedback, 'Retry'); assert.ok(existsSync(store.getRun(run.id)!.stageInput!.images![0]))
})
test('invalid dimensions сохраняют локализованный boundary отказ до store и запуска', () => {
  const f = fixture(); f.select('A'); setMainLocale('en')
  assert.throws(() => f.call('coordinator:start', 'X', 0, 24), e => {
    assert.ok(e instanceof OrcaError); assert.equal(e.key, 'command.invalidInput')
    assert.equal((ipcError(e) as Error).name, 'OrcaError[command.invalidInput]'); return true
  })
  assert.deepEqual(f.counts(), { lookups: 0, spawns: 0 })
})
test('invalid return files сохраняют прежний attachments.invalid код и перевод', () => {
  const f = fixture(); f.select('A'); setMainLocale('en')
  assert.throws(() => f.call('globalTasks:returnToWork', 'run', 'Fix', 80, 24, [{ name: 'empty.txt', data: [] }]), e => {
    assert.ok(e instanceof OrcaError); assert.equal(e.key, 'attachments.invalid')
    const ipc = ipcError(e) as Error; assert.equal(ipc.name, 'OrcaError[attachments.invalid]'); assert.match(ipc.message, /attachment/i)
    return true
  })
  assert.deepEqual(f.counts(), { lookups: 0, spawns: 0 })
})
