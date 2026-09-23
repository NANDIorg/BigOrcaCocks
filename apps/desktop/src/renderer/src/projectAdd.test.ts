import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ProjectTemplate } from '@orca-board/core'
import { findProjectForPath, isStaleTemplatesError, preselectedTemplate, startAddProject, type AddProjectApi } from './projectAdd'
import type { TemplateDetection, TemplatesState } from '../../shared/ipc'

const tpl = (id: string): ProjectTemplate => ({ id, title: id, settings: {} })
const STATE: TemplatesState = { templates: [tpl('general'), tpl('frontend'), tpl('u_1')], defaultTemplateId: 'u_1' }
const PROJECTS = [{ id: 'p1', root: '/work/app' }]

function api(detection: TemplateDetection | null, state = STATE): AddProjectApi {
  return { projects: { detectTemplate: async () => detection }, templates: { list: async () => state } }
}

test('findProjectForPath — корень проекта, папка внутри него, но не соседняя с общим префиксом', () => {
  assert.equal(findProjectForPath(PROJECTS, '/work/app')?.id, 'p1')
  assert.equal(findProjectForPath(PROJECTS, '/work/app/')?.id, 'p1')
  assert.equal(findProjectForPath(PROJECTS, '/work/app/src')?.id, 'p1')
  assert.equal(findProjectForPath(PROJECTS, '/work/app2'), undefined)
  assert.equal(findProjectForPath([{ id: 'w', root: 'C:\\work\\app' }], 'C:\\work\\app\\src')?.id, 'w')
})

test('preselectedTemplate — угаданный, иначе по умолчанию, иначе первый', () => {
  assert.equal(preselectedTemplate(STATE, 'frontend'), 'frontend')
  assert.equal(preselectedTemplate(STATE, 'удалённый'), 'u_1')
  assert.equal(preselectedTemplate(STATE), 'u_1')
  assert.equal(preselectedTemplate({ templates: STATE.templates, defaultTemplateId: 'нет' }), 'general')
  assert.equal(preselectedTemplate({ templates: [], defaultTemplateId: 'general' }), '')
})

test('startAddProject — старый preload без шаблонов и старый main без хендлеров: прежний add()', async () => {
  assert.deepEqual(await startAddProject(undefined, []), { kind: 'legacy' })
  assert.deepEqual(await startAddProject({ projects: {} }, []), { kind: 'legacy' })
  const staleMain: AddProjectApi = {
    projects: { detectTemplate: async () => { throw new Error("Error invoking remote method 'projects:detectTemplate': Error: No handler registered for 'projects:detectTemplate'") } },
    templates: { list: async () => STATE }
  }
  assert.deepEqual(await startAddProject(staleMain, []), { kind: 'legacy' })
  assert.equal(isStaleTemplatesError("No handler registered for 'templates:list'"), true)
  assert.equal(isStaleTemplatesError('/x — не git-репозиторий'), false)
})

test('startAddProject — прочие ошибки пробрасываются', async () => {
  const broken: AddProjectApi = { projects: { detectTemplate: async () => { throw new Error('нет доступа') } }, templates: { list: async () => STATE } }
  await assert.rejects(startAddProject(broken, []), { message: 'нет доступа' })
})

test('startAddProject — отмена диалога, уже добавленный репозиторий и выбор типа', async () => {
  assert.deepEqual(await startAddProject(api(null), PROJECTS), { kind: 'cancel' })
  assert.deepEqual(
    await startAddProject(api({ path: '/work/app/src', templateId: 'frontend', reason: '' }), PROJECTS),
    { kind: 'direct', path: '/work/app/src' }
  )
  const det = { path: '/work/new', templateId: 'frontend', reason: 'package.json: react' }
  const start = await startAddProject(api(det), PROJECTS)
  assert.equal(start.kind, 'pick')
  if (start.kind === 'pick') {
    assert.equal(start.selected, 'frontend')
    assert.equal(start.defaultTemplateId, 'u_1')
    assert.deepEqual(start.detection, det)
    assert.equal(start.templates.length, 3)
  }
  assert.deepEqual(
    await startAddProject(api(det, { templates: [], defaultTemplateId: 'general' }), PROJECTS),
    { kind: 'direct', path: '/work/new' }
  )
})
