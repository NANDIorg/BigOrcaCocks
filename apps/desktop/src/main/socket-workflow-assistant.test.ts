import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { connect, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type WorkflowTypeContext, type WorkflowSaveResult, type WorkflowPreparation, type WorkflowSchema, type TaskType } from '@orca-board/core'
import { ProjectManager } from './projects'
import { startSocketServer } from './socket'

let tmp: string
let socket: string
let server: Server
let manager: ProjectManager
const definition = { version: 2, nodes: [{ id: 's', type: 'start' }, { id: 'w', type: 'work' }, { id: 'e', type: 'end' }],
  edges: [{ id: 'sw', from: 's', outcome: 'next', to: 'w' }, { id: 'we', from: 'w', outcome: 'next', to: 'e' }] }
interface Reply<T> { ok: boolean; result: T; error?: string; validation?: WorkflowPreparation }

function call<T>(method: string, params: Record<string, unknown> = {}): Promise<Reply<T>> {
  return new Promise((resolve, reject) => {
    const sock = connect(socket)
    let buffer = ''
    sock.on('connect', () => sock.write(JSON.stringify({ method, params, projectId: 'deleted' }) + '\n'))
    sock.setEncoding('utf8')
    sock.on('data', (chunk: string) => {
      buffer += chunk
      if (!buffer.includes('\n')) return
      sock.destroy()
      resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as Reply<T>)
    })
    sock.on('error', reject)
  })
}

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'orca-sock-wf-assistant-'))
  socket = process.platform === 'win32' ? `\\\\.\\pipe\\orca-wf-assistant-${process.pid}-${Date.now()}` : path.join(tmp, 'orca.sock')
  manager = new ProjectManager(tmp)
  server = startSocketServer(socket, {
    resolve: () => { throw new Error('нет проекта') }, projects: () => [],
    settings: () => manager.settings(), setSettings: (patch) => manager.setSettings(patch),
    libraryTaskTypes: () => ({ taskTypes: manager.taskTypes(), defaultTypeId: manager.defaultTaskTypeId() }),
    workflowGet: (id) => manager.workflowGet(id),
    workflowValidate: (raw, selection) => manager.workflowValidate(raw, selection),
    workflowSet: (id, revision, raw) => manager.workflowSet(id, revision, raw),
    workflowCreate: (input) => manager.workflowCreate(input)
  })
  await new Promise((resolve) => server.once('listening', resolve))
})
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(tmp, { recursive: true, force: true })
})

describe('app-level инструменты графа', () => {
  it('schema/get и types.list --all работают без проекта, старые project commands требуют проект', async () => {
    const schema = await call<WorkflowSchema>('workflow.schema')
    assert.equal(schema.ok, true, schema.error)
    assert.equal(schema.result.version, 2)
    const list = await call<TaskType[]>('types.list', { all: true })
    assert.equal(list.ok, true, list.error)
    assert.ok(list.result.some((type) => type.id === 'general'))
    const get = await call<WorkflowTypeContext>('workflow.get', { type: 'general' })
    assert.equal(get.ok, true, get.error)
    assert.ok(get.result.workflow.edges.length)
    assert.equal(JSON.stringify(get.result).includes('extraArgs'), false)
    assert.equal((await call('types.list')).ok, false)
    assert.equal((await call('workflow.show')).ok, false)
  })

  it('validate возвращает errors/warnings, set проверяет ревизию, create атомарно создаёт без запуска', async () => {
    const current = (await call<WorkflowTypeContext>('workflow.get', { type: 'general' })).result
    const invalid = await call<WorkflowPreparation>('workflow.validate', { type: 'general', definition: { ...definition, nodes: [null] } })
    assert.equal(invalid.ok, true, invalid.error)
    assert.equal(invalid.result.errors[0].code, 'invalidDefinition')
    const checked = await call<WorkflowPreparation>('workflow.validate', { definition })
    assert.deepEqual(checked.result.errors, [])
    assert.ok(checked.result.warnings.length)
    const saved = await call<WorkflowSaveResult>('workflow.set', { type: 'general', revision: current.revision, definition })
    assert.equal(saved.ok, true, saved.error)
    assert.notEqual(saved.result.revision, current.revision)
    assert.equal((await call('workflow.set', { type: 'general', revision: current.revision, definition })).ok, false)
    const invalidSave = await call('workflow.set', { type: 'general', revision: saved.result.revision, definition: { ...definition, edges: [] } })
    assert.equal(invalidSave.ok, false)
    assert.ok(invalidSave.validation?.errors.length)
    const count = manager.taskTypes().length
    const made = await call<WorkflowSaveResult>('workflow.create', { title: 'Новый', 'base-type': 'general', definition })
    assert.equal(made.ok, true, made.error)
    assert.equal(manager.taskTypes().length, count + 1)
    assert.equal(manager.list().length, 0)
    assert.equal(manager.taskType(made.result.typeId)?.title, 'Новый')
  })

  it('отсутствующие значения и конфликт выбора ролей отвергаются без записи', async () => {
    const count = manager.taskTypes().length
    for (const [method, params] of [
      ['workflow.get', {}], ['workflow.set', { type: 'general', definition }],
      ['workflow.create', { definition }], ['workflow.validate', { type: 'general', 'base-type': 'general', definition }]
    ] as [string, Record<string, unknown>][]) assert.equal((await call(method, params)).ok, false)
    assert.equal(manager.taskTypes().length, count)
  })
})
