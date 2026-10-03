import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore, DEFAULT_ROLES } from '@orca-board/core'
import * as runtime from '../src/index.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const operator = (projectId = 'A') => ({ projectId, clientId: `client-${projectId}`, actor: { kind: 'operator' as const, id: 'local-user' } })

test('разреженные deps отклоняются до открытия проекта', () => {
  const { service, stores, lookedUp } = fixture()
  const before = stores.get('A')!.snapshot()
  assert.throws(() => service.createTask(operator(), { title: 'No', deps: new Array<string>(1) }), code('command.invalidInput', 'deps'))
  assert.deepEqual(lookedUp, [])
  assert.deepEqual(stores.get('A')!.snapshot(), before)
})

function fixture(authorize = (_context: unknown, _command: unknown) => true) {
  assert.equal(typeof runtime.createBoardCommands, 'function', 'Нужен исполняемый API доски без Desktop')
  const dir = mkdtempSync(join(tmpdir(), 'orca-board-commands-'))
  dirs.push(dir)
  const stores = new Map(['A', 'B'].map(id => [id, new TaskStore(runtime.jsonPersistence(join(dir, `${id}.json`)))]))
  const lookedUp: string[] = []
  const service = runtime.createBoardCommands({
    authorize,
    project(id) {
      lookedUp.push(id)
      const store = stores.get(id)
      return store ? { store, roles: () => ({ title: 'Test type', roles: [DEFAULT_ROLES[0]] }), agents: () => [
        { id: DEFAULT_ROLES[0].agent, installed: true, enabled: true, title: 'Test agent', version: 'test', models: [], defaults: {} }
      ] } : undefined
    },
    selection: runtime.createAgentSelection({ error: key => new Error(key) })
  })
  return { dir, service, stores, lookedUp }
}

function code(expected: string, field?: string) {
  return (error: unknown) => error instanceof runtime.BoardCommandError && error.code === expected
    && (field === undefined || error.details.field === field)
}

test('два клиента сохраняют и читают свои проекты без глобального activeId', () => {
  const { dir, service, stores } = fixture()
  const a = service.createTask(operator('A'), { title: 'Alpha', spec: 'A', priority: 'high' })
  const b = service.createTask(operator('B'), { title: 'Beta' })
  service.updateTask(operator('B'), b.id, { title: 'Changed Beta' })
  service.moveTask(operator('A'), a.id, 'ready')
  assert.equal(service.get(operator('A')).tasks[0].title, 'Alpha')
  assert.equal(service.get(operator('A')).tasks[0].status, 'ready')
  assert.equal(service.get(operator('B')).tasks[0].title, 'Changed Beta')
  const restored = new TaskStore(runtime.jsonPersistence(join(dir, 'B.json')))
  assert.equal(restored.getTask(b.id)?.title, 'Changed Beta')
  service.removeTask(operator('B'), b.id)
  assert.equal(stores.get('B')!.listTasks().length, 0)
  assert.equal(stores.get('A')!.listTasks().length, 1)
})

test('политика доступа обязательна и вызывается до открытия проекта для каждой команды', () => {
  const checked: unknown[] = []
  const { service, lookedUp } = fixture((context, command) => { checked.push([context, command]); return false })
  for (const action of [
    () => service.get(operator()), () => service.createTask(operator(), { title: 'No' }),
    () => service.updateTask(operator(), 'task', {}), () => service.moveTask(operator(), 'task', 'ready'),
    () => service.removeTask(operator(), 'task')
  ]) assert.throws(action, code('command.forbidden'))
  assert.equal(checked.length, 5)
  assert.deepEqual(lookedUp, [])
})

test('мутирующий callback политики не может подменить уже проверенный проект и автора', () => {
  const { service } = fixture(context => {
    const request = context as { projectId: string; actor: { kind: string } }
    request.projectId = 'B'
    request.actor.kind = 'system'
    return true
  })
  const task = service.createTask(operator(), { title: 'A' })
  assert.equal(task.statusHistory?.[0].by, 'human')
  assert.equal(service.get(operator('A')).tasks.length, 1)
  assert.equal(service.get(operator('B')).tasks.length, 0)
})

for (const context of [null, [], {}, { ...operator(), projectId: '' }, { ...operator(), clientId: 2 },
  { ...operator(), actor: { kind: 'admin', id: 'user' } }, { ...operator(), actor: { kind: ['operator'], id: 'user' } }, { ...operator(), actor: { kind: 'operator', id: '' } }]) {
  test(`невалидный контекст ${JSON.stringify(context)} не открывает store`, () => {
    const { service, lookedUp } = fixture()
    assert.throws(() => service.get(context as never), code('command.invalidContext'))
    assert.deepEqual(lookedUp, [])
  })
}

for (const [input, field] of [
  [null, 'input'], [[], 'input'], [{ title: ' ' }, 'title'], [{ title: 1 }, 'title'],
  [{ title: 'x', deps: 'id' }, 'deps'], [{ title: 'x', deps: [1] }, 'deps'],
  [{ title: 'x', priority: 'panic' }, 'priority'], [{ title: 'x', spec: {} }, 'spec'],
  [{ title: 'x', runId: 'other' }, 'runId'], [{ title: 'x', agent: 'other' }, 'agent'],
  [{ title: 'x', gateFor: {} }, 'gateFor']
] as const) {
  test(`create отклоняет ${field} до создания inbox и persistence`, () => {
    const { service, stores, lookedUp } = fixture()
    assert.throws(() => service.createTask(operator(), input as never), code('command.invalidInput', field))
    assert.equal(stores.get('A')!.listRuns().length, 0)
    assert.deepEqual(lookedUp, [])
  })
}

test('patch whitelist не позволяет менять роль, статус и зависимости', () => {
  const { service } = fixture()
  const task = service.createTask(operator(), { title: 'safe' })
  for (const patch of [{ roleId: 'evil' }, { status: 'done' }, { deps: [] }, { title: 2 }, { spec: null }, { priority: '' }]) {
    assert.throws(() => service.updateTask(operator(), task.id, patch as never), code('command.invalidInput'))
  }
  assert.equal(service.get(operator()).tasks[0].title, 'safe')
})

test('неизвестный проект и чужая задача отвергаются без fallback', () => {
  const { service } = fixture()
  const task = service.createTask(operator('B'), { title: 'B' })
  assert.throws(() => service.get(operator('gone')), code('command.projectNotFound'))
  for (const action of [() => service.updateTask(operator('A'), task.id, {}),
    () => service.moveTask(operator('A'), task.id, 'done'), () => service.removeTask(operator('A'), task.id)]) {
    assert.throws(action, code('command.taskNotFound'))
  }
  assert.equal(service.get(operator('B')).tasks.length, 1)
})

test('runtime сохраняет guards store: in_progress и неизвестная колонка', () => {
  const { service } = fixture()
  const task = service.createTask(operator(), { title: 'Original' })
  service.moveTask(operator(), task.id, 'in_progress')
  assert.throws(() => service.updateTask(operator(), task.id, { title: 'Changed' }), code('command.rejected'))
  assert.throws(() => service.moveTask(operator(), task.id, 'missing-column'), code('command.rejected'))
  assert.equal(service.updateTask(operator(), task.id, { priority: 'urgent' }).priority, 'urgent')
  assert.equal(service.get(operator()).tasks[0].title, 'Original')
})

test('выбор роли использует guards runtime до создания задачи', () => {
  const { service, stores } = fixture()
  assert.throws(() => service.createTask(operator(), { title: 'No', roleId: 'missing' }), code('command.rejected'))
  assert.equal(stores.get('A')!.listRuns().length, 0)
})

for (const [kind, source] of [['operator', 'human'], ['agent', 'cli'], ['system', 'app']] as const) {
  test(`история команды ${kind} принадлежит ${source}`, () => {
    const { service } = fixture()
    const context = { ...operator(), actor: { kind, id: 'trusted-by-host' } }
    const task = service.createTask(context, { title: 'Task' })
    const moved = service.moveTask(context, task.id, 'in_progress')
    assert.equal(task.statusHistory?.[0].by, source)
    assert.equal(moved.statusHistory?.at(-1)?.by, source)
  })
}

test('результаты commands и вложенный snapshot отделены от mutable store', () => {
  const { service, stores } = fixture()
  const task = service.createTask(operator(), { title: 'Original', deps: [] })
  task.title = 'Changed externally'
  task.statusHistory![0].by = 'worker'
  const snapshot = service.get(operator())
  snapshot.tasks[0].spec = 'external'
  snapshot.tasks[0].deps.push('external')
  snapshot.runs[0].objective = 'external'
  snapshot.events.length = 0
  assert.equal(stores.get('A')!.getTask(task.id)?.title, 'Original')
  assert.equal(service.get(operator()).tasks[0].spec, '')
  assert.deepEqual(service.get(operator()).tasks[0].deps, [])
  assert.equal(service.get(operator()).tasks[0].statusHistory![0].by, 'human')
  assert.notEqual(service.get(operator()).runs[0].objective, 'external')
  assert.ok(service.get(operator()).events.length > 0)
})

test('причина host/store rejection доступна локально; DTO ошибки не содержит stack', () => {
  const reason = new Error('host policy unavailable')
  const { service, lookedUp } = fixture(() => { throw reason })
  assert.throws(() => service.get(operator()), error => {
    assert.ok(error instanceof runtime.BoardCommandError)
    assert.equal(error.code, 'command.rejected')
    assert.equal(error.cause, reason)
    assert.deepEqual(error.toJSON(), { code: 'command.rejected', details: { reason: 'host policy unavailable' } })
    return true
  })
  assert.deepEqual(lookedUp, [])
})
