import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore, DEFAULT_ROLES } from '@orca-board/core'
import { createBoardCommands, createAgentSelection } from '@orca-board/runtime'
import * as adapter from './board-commands'
import { OrcaError, ipcError, setMainLocale } from './i18n'

type Event = { client: string | null }

function fixture() {
  assert.equal(typeof adapter.registerDesktopBoardCommands, 'function', 'IPC должен использовать общий runtime')
  let active: string | undefined
  let installed = true
  const stores = new Map(['A', 'B'].map(id => [id, new TaskStore()]))
  const commands = createBoardCommands({
    authorize: context => context.clientId === 'desktop:1' && context.actor.kind === 'operator' && context.actor.id === 'local-user',
    project: id => {
      const store = stores.get(id)
      return store ? { store, roles: () => ({ title: 'Default', roles: [DEFAULT_ROLES[0]] }), agents: () => [
        { id: DEFAULT_ROLES[0].agent, title: 'Agent', installed, enabled: true, models: [], defaults: {} }
      ] } : undefined
    },
    selection: createAgentSelection({ error: (key, params) => new OrcaError(key, params) })
  })
  const handlers = new Map<string, (event: Event, ...args: unknown[]) => unknown>()
  adapter.registerDesktopBoardCommands<Event>((channel, handler) => {
    handlers.set(channel, handler as (event: Event, ...args: unknown[]) => unknown)
  }, { commands, activeProjectId: () => active, clientId: event => event.client })
  return {
    stores, commands, select: (id?: string) => { active = id }, uninstall: () => { installed = false },
    call: (channel: string, ...args: unknown[]) => handlers.get(channel)!({ client: 'desktop:1' }, ...args),
    foreign: (channel: string, ...args: unknown[]) => handlers.get(channel)!({ client: null }, ...args)
  }
}

test('legacy IPC сохраняет чтение пустой доски и ошибку мутации без проекта', () => {
  const host = fixture()
  assert.deepEqual(host.call('board:get'), { tasks: [], dispatches: [], events: [], questions: [], runs: [] })
  assert.throws(() => host.call('tasks:create', { title: 'No' }), error => error instanceof OrcaError && error.key === 'projects.none')
})

test('все пять IPC callbacks отвергают недоверенный sender даже при пустой доске', () => {
  const host = fixture()
  for (const channel of ['board:get', 'tasks:create', 'tasks:update', 'tasks:move', 'tasks:remove']) {
    assert.throws(() => host.foreign(channel), error => error instanceof OrcaError && error.key === 'command.forbidden')
  }
  assert.equal(host.stores.get('A')!.listRuns().length, 0)
})

test('IPC выбирает проект в начале команды; отдельные runtime клиенты обходятся без activeId', () => {
  const host = fixture()
  host.select('A')
  const task = host.call('tasks:create', { title: 'A' }) as { id: string }
  host.select('B')
  host.call('tasks:create', { title: 'B' })
  assert.throws(() => host.call('tasks:update', task.id, { title: 'Wrong' }), error => error instanceof OrcaError && error.key === 'command.taskNotFound')
  host.select('A')
  host.call('tasks:update', task.id, { title: 'Updated', spec: 'Text', priority: 'high' })
  host.call('tasks:update', task.id, null)
  const moved = host.call('tasks:move', task.id, 'in_progress') as { status: string; statusHistory: { by: string }[] }
  assert.equal(moved.status, 'in_progress')
  assert.equal(moved.statusHistory.at(-1)?.by, 'human')
  assert.equal(host.stores.get('B')!.listTasks()[0].title, 'B')
  assert.equal(host.stores.get('A')!.listTasks()[0].title, 'Updated')
  assert.throws(() => host.call('tasks:update', task.id, { title: 'Running edit' }), /задача в работе/)
  assert.equal(host.call('tasks:remove', task.id), undefined)
  assert.equal(host.stores.get('A')!.listTasks().length, 0)
})

test('поддельный actor/clientId не получает доступ к embedded service', () => {
  const host = fixture()
  for (const actor of [{ kind: 'agent' as const, id: 'local-user' }, { kind: 'operator' as const, id: 'stranger' }]) {
    assert.throws(() => host.commands.get({ projectId: 'A', clientId: 'desktop:1', actor }), /Нет доступа/)
  }
  assert.throws(() => host.commands.get({ projectId: 'A', clientId: 'desktop:other', actor: { kind: 'operator', id: 'local-user' } }), /Нет доступа/)
})

test('устаревшая selection не падает обратно в соседний проект', () => {
  const host = fixture()
  host.select('removed')
  assert.throws(() => host.call('board:get'), error => error instanceof OrcaError && error.key === 'command.projectNotFound')
  assert.equal(host.stores.get('B')!.listTasks().length, 0)
})

test('boundary code и перевод роли сохраняются через существующую ipcError обёртку', () => {
  const host = fixture()
  host.select('A')
  setMainLocale('en')
  try {
    assert.throws(() => host.call('tasks:create', { title: 2 }), error => {
      const translated = ipcError(error)
      assert.ok(translated instanceof Error)
      assert.equal(translated.name, 'OrcaError[command.invalidInput]')
      assert.match(translated.message, /title/)
      assert.doesNotMatch(translated.message, /[А-Яа-я]/)
      return true
    })
    host.uninstall()
    assert.throws(() => host.call('tasks:create', { title: 'No agent' }), error => {
      const translated = ipcError(error)
      assert.ok(translated instanceof Error)
      assert.equal(translated.name, 'OrcaError[agent.notInstalled]')
      assert.doesNotMatch(translated.message, /[А-Яа-я]/)
      return true
    })
  } finally { setMainLocale('ru') }
})
