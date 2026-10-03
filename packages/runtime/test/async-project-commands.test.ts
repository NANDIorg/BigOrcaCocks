import assert from 'node:assert/strict'
import { it } from 'node:test'
import { TaskStore, statusSource } from '@orca-board/core'
import * as runtime from '../src/index.ts'

function deferred() {
  let release = () => {}
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, resolve: release }
}

const context = { clientId: 'one', projectId: 'p', actor: { kind: 'operator' as const, id: 'person' } }
function fixture() {
  assert.equal(typeof runtime.createAsyncProjectCommandExecutor, 'function')
  const project = { store: new TaskStore() }; let current = true; let allow = true; let lookups = 0
  const execute = runtime.createAsyncProjectCommandExecutor({
    project: () => { lookups++; return project }, authorize: () => allow, isCurrent: () => current })
  return { execute, project, lookups: () => lookups, stale: () => { current = false }, deny: () => { allow = false } }
}
it('async executor: context/policy/payload предшествуют lookup и эффектам', async () => {
  const f = fixture()
  await assert.rejects(f.execute({}, 'test', () => () => 1), { code: 'command.invalidContext' })
  await assert.rejects(f.execute(context, 'test', () => { throw new runtime.CommandError('command.invalidInput') }), { code: 'command.invalidInput' })
  f.deny()
  await assert.rejects(f.execute(context, 'test', () => { throw new Error('не должно исполняться') }), { code: 'command.forbidden' })
  assert.equal(f.lookups(), 0)
})
it('async executor: commit после await имеет своего автора, соседняя операция не наследует его', async () => {
  const f = fixture(); const { promise, resolve } = deferred()
  const pending = f.execute(context, 'test', () => async (project, _ctx, scope) => {
    await promise
    return scope.commit(() => project.store.createTask({ title: 'человек' }))
  })
  assert.equal(statusSource(), 'app')
  const other = f.project.store.createTask({ title: 'приложение' })
  assert.equal(other.statusHistory?.[0]?.by, 'app')
  resolve(); const result = await pending
  assert.equal(result.statusHistory?.[0]?.by, 'human')
  result.title = 'испорчено клиентом'
  assert.equal(f.project.store.getTask(result.id)?.title, 'человек')
  assert.equal(statusSource(), 'app')
})
it('async executor: stale result и commit отклонены без записи', async () => {
  for (const commit of [false, true]) {
    const f = fixture(); const { promise, resolve } = deferred()
    const pending = f.execute(context, 'test', () => async (project, _ctx, scope) => {
      await promise
      return commit ? scope.commit(() => project.store.createTask({ title: 'поздняя' })) : { value: 'поздняя' }
    })
    f.stale(); resolve()
    await assert.rejects(pending, { code: 'command.stale' })
    assert.equal(f.project.store.listTasks().length, 0)
  }
})
it('async executor: отзыв policy во время await блокирует commit', async () => {
  const f = fixture(); const { promise, resolve } = deferred()
  const pending = f.execute(context, 'test', () => async (project, _ctx, scope) => {
    await promise; return scope.commit(() => project.store.createTask({ title: 'поздняя' }))
  })
  f.deny(); resolve()
  await assert.rejects(pending, { code: 'command.forbidden' })
  assert.equal(f.project.store.listTasks().length, 0)
})
it('async executor: обычная Promise ошибка имеет общий code и cause', async () => {
  const f = fixture(); const cause = new Error('disk')
  await assert.rejects(f.execute(context, 'test', () => async () => { throw cause }), (error: unknown) => {
    assert.ok(error instanceof runtime.CommandError); assert.equal(error.code, 'command.rejected'); assert.equal(error.cause, cause); return true
  })
})
