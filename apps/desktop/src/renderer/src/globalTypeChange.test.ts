import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GlobalTask, TaskType } from '@orca-board/core'
import { STALE_TYPE_CHANGE_MESSAGE, changeTypeApi, typeChangeOptions } from './globalTypeChange'

const types = [
  { id: 'dev', title: 'Разработка', roles: [] },
  { id: 'docs', title: 'Документация', roles: [] }
] as unknown as TaskType[]

const fresh = { inbox: false, typeId: 'dev', progress: { total: 0, done: 0, byStatus: {}, byKind: {} } }

test('typeChangeOptions: не начатая задача в бэклоге — селект с типами проекта', () => {
  assert.deepEqual(typeChangeOptions(fresh, 'backlog', types), [
    { id: 'dev', title: 'Разработка' },
    { id: 'docs', title: 'Документация' }
  ])
})

test('typeChangeOptions: начатая, с координатором, с подзадачами, «Входящие», не бэклог — только бейдж', () => {
  assert.equal(typeChangeOptions({ ...fresh, startedAt: 1 }, 'backlog', types), undefined)
  assert.equal(typeChangeOptions({ ...fresh, coordinatorPtyId: 'pty' }, 'backlog', types), undefined)
  assert.equal(typeChangeOptions({ ...fresh, progress: { ...fresh.progress, total: 1 } }, 'backlog', types), undefined)
  assert.equal(typeChangeOptions({ ...fresh, inbox: true }, 'backlog', types), undefined)
  assert.equal(typeChangeOptions(fresh, 'in_progress', types), undefined)
})

test('typeChangeOptions: старый main без типов — только бейдж', () => {
  assert.equal(typeChangeOptions(fresh, 'backlog', undefined), undefined)
  assert.equal(typeChangeOptions(fresh, 'backlog', []), undefined)
})

test('typeChangeOptions: текущий тип вне проекта остаётся первым вариантом', () => {
  const opts = typeChangeOptions({ ...fresh, typeId: 'gone' }, 'backlog', types, 'Удалённый')
  assert.deepEqual(opts?.[0], { id: 'gone', title: 'Удалённый' })
  assert.equal(opts?.length, 3)
})

test('changeTypeApi: старый preload или старый main — «перезапустите приложение»', async () => {
  assert.throws(() => changeTypeApi(undefined), { message: STALE_TYPE_CHANGE_MESSAGE })
  assert.throws(() => changeTypeApi({ globalTasks: {} }), { message: STALE_TYPE_CHANGE_MESSAGE })
  const oldMain = changeTypeApi({
    globalTasks: { changeType: () => Promise.reject(new Error("Error invoking remote method 'globalTasks:changeType': Error: No handler registered for 'globalTasks:changeType'")) }
  })
  await assert.rejects(oldMain('run_1', 'docs'), { message: STALE_TYPE_CHANGE_MESSAGE })
  const other = changeTypeApi({ globalTasks: { changeType: () => Promise.reject(new Error('нельзя сменить')) } })
  await assert.rejects(other('run_1', 'docs'), /нельзя сменить/)
  const ok = changeTypeApi({ globalTasks: { changeType: (id, typeId) => Promise.resolve({ id, typeId } as GlobalTask) } })
  assert.deepEqual(await ok('run_1', 'docs'), { id: 'run_1', typeId: 'docs' })
})
