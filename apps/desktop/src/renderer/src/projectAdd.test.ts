import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TaskType } from '@orca-board/core'
import { findProjectForPath, preselectedType, startAddProject, type AddProjectApi } from './projectAdd'
import type { TaskTypeDetection, TaskTypesState } from '../../shared/ipc'

const type = (id: string): TaskType => ({ id, title: id, settings: {} })
const STATE: TaskTypesState = { taskTypes: [type('general'), type('frontend'), type('u_1')], defaultTaskTypeId: 'u_1' }
const PROJECTS = [{ id: 'p1', root: '/work/app' }]

function api(detection: TaskTypeDetection | null, state = STATE): AddProjectApi {
  return { projects: { detectTaskType: async () => detection }, taskTypes: { list: async () => state } }
}

test('findProjectForPath — корень проекта, папка внутри него, но не соседняя с общим префиксом', () => {
  assert.equal(findProjectForPath(PROJECTS, '/work/app')?.id, 'p1')
  assert.equal(findProjectForPath(PROJECTS, '/work/app/')?.id, 'p1')
  assert.equal(findProjectForPath(PROJECTS, '/work/app/src')?.id, 'p1')
  assert.equal(findProjectForPath(PROJECTS, '/work/app2'), undefined)
  assert.equal(findProjectForPath([{ id: 'w', root: 'C:\\work\\app' }], 'C:\\work\\app\\src')?.id, 'w')
})

test('preselectedType — угаданный, иначе тип библиотеки по умолчанию, иначе первый', () => {
  assert.equal(preselectedType(STATE, 'frontend'), 'frontend')
  assert.equal(preselectedType(STATE, 'удалённый'), 'u_1')
  assert.equal(preselectedType(STATE), 'u_1')
  assert.equal(preselectedType({ taskTypes: STATE.taskTypes, defaultTaskTypeId: 'нет' }), 'general')
  assert.equal(preselectedType({ taskTypes: [], defaultTaskTypeId: 'general' }), '')
})

test('startAddProject — старый preload без типов и старый main без хендлеров: прежний add()', async () => {
  assert.deepEqual(await startAddProject(undefined, []), { kind: 'legacy' })
  assert.deepEqual(await startAddProject({ projects: {} }, []), { kind: 'legacy' })
  // main до типов задач: у preload есть только detectTemplate и templates — тоже прежний add().
  assert.deepEqual(await startAddProject({ projects: {}, taskTypes: undefined }, []), { kind: 'legacy' })
  const staleMain: AddProjectApi = {
    projects: { detectTaskType: async () => { throw new Error("Error invoking remote method 'projects:detectTaskType': Error: No handler registered for 'projects:detectTaskType'") } },
    taskTypes: { list: async () => STATE }
  }
  assert.deepEqual(await startAddProject(staleMain, []), { kind: 'legacy' })
})

test('startAddProject — прочие ошибки пробрасываются', async () => {
  const broken: AddProjectApi = { projects: { detectTaskType: async () => { throw new Error('нет доступа') } }, taskTypes: { list: async () => STATE } }
  await assert.rejects(startAddProject(broken, []), { message: 'нет доступа' })
})

test('startAddProject — отмена диалога, уже добавленный репозиторий и выбор типа', async () => {
  assert.deepEqual(await startAddProject(api(null), PROJECTS), { kind: 'cancel' })
  assert.deepEqual(
    await startAddProject(api({ path: '/work/app/src', typeId: 'frontend', reason: '' }), PROJECTS),
    { kind: 'direct', path: '/work/app/src' }
  )
  const det = { path: '/work/new', typeId: 'frontend', reason: 'package.json: react' }
  const start = await startAddProject(api(det), PROJECTS)
  assert.equal(start.kind, 'pick')
  if (start.kind === 'pick') {
    assert.equal(start.selected, 'frontend')
    assert.equal(start.defaultTypeId, 'u_1')
    assert.deepEqual(start.detection, det)
    assert.equal(start.types.length, 3)
  }
  assert.deepEqual(
    await startAddProject(api(det, { taskTypes: [], defaultTaskTypeId: 'general' }), PROJECTS),
    { kind: 'direct', path: '/work/new' }
  )
})
