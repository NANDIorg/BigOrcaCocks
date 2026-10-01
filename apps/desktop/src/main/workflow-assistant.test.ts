import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_ROLES, legacyDefaultWorkflow, type WorkflowAssistantSaved } from '@orca-board/core'
import { ProjectManager, WorkflowValidationError } from './projects'
import { PROJECTS_FILE_VERSION } from './task-types-migration'

let tmp: string
let pm: ProjectManager
const graph = () => ({ version: 2, nodes: [{ id: 's', type: 'start' }, { id: 'w', type: 'work', roleIds: ['developer'] }, { id: 'e', type: 'end' }],
  edges: [{ id: 'sw', from: 's', outcome: 'next', to: 'w' }, { id: 'we', from: 'w', outcome: 'next', to: 'e' }] })

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'orca-wf-assistant-'))
  writeFileSync(path.join(tmp, 'projects.json'), JSON.stringify({ version: PROJECTS_FILE_VERSION, taskTypesSeeded: true,
    projects: [{ id: 'p1', root: tmp, name: 'repo' }], activeId: 'p1', taskTypes: [{ id: 'mine', title: 'Мой тип', description: 'Описание',
      settings: { roles: DEFAULT_ROLES.map((r) => ({ ...r, extraArgs: '--verbose' })), agentRules: 'Правила', permissionMode: 'acceptEdits' } }] }))
  pm = new ProjectManager(tmp)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('воркфлоу через ассистента: библиотека и сохранение', () => {
  it('get отдаёт полный дефолтный граф и безопасные роли, ревизия переживает рестарт', () => {
    const context = pm.workflowGet('mine')
    assert.equal(context.title, 'Мой тип')
    assert.equal(context.custom, false)
    assert.ok(context.workflow.edges.length)
    assert.equal(JSON.stringify(context).includes('extraArgs'), false)
    assert.match(context.revision, /^[a-f0-9]{64}$/)
    assert.equal(new ProjectManager(tmp).workflowGet('mine').revision, context.revision)
  })

  it('set меняет только граф, а существующий прогон хранит прежний снимок', () => {
    const before = pm.taskType('mine')!
    const store = pm.store('p1')
    const run = store.createGlobalTask({ title: 'Уже создана', type: pm.runType('p1', 'mine') })
    const snapshot = structuredClone(store.getRun(run.id)?.workflow)
    const context = pm.workflowGet('mine')
    const saved = pm.workflowSet('mine', context.revision, graph())
    assert.notEqual(saved.revision, context.revision)
    assert.deepEqual(pm.taskType('mine')!.settings.roles, before.settings.roles)
    assert.equal(pm.taskType('mine')!.settings.agentRules, 'Правила')
    assert.equal(pm.taskType('mine')!.settings.permissionMode, 'acceptEdits')
    assert.equal(pm.taskType('mine')!.description, 'Описание')
    assert.deepEqual(store.getRun(run.id)?.workflow, snapshot)
    assert.deepEqual(new ProjectManager(tmp).workflowGet('mine').workflow, saved.workflow)
  })

  it('validate не пишет память и диск даже с ошибками формы и вложенных путей', () => {
    const before = readFileSync(path.join(tmp, 'projects.json'), 'utf8')
    const types = pm.taskTypes()
    for (const definition of [graph(), null, { ...graph(), nodes: [{ id: 'c', type: 'condition' }] },
      { ...graph(), nodes: [{ id: 'w', type: 'work', subflow: { nodes: [null], edges: [] } }] }]) {
      const result = pm.workflowValidate(definition, { typeId: 'mine' })
      assert.ok(Array.isArray(result.errors))
    }
    assert.deepEqual(pm.taskTypes(), types)
    assert.equal(readFileSync(path.join(tmp, 'projects.json'), 'utf8'), before)
  })

  it('конфликт ревизии после изменения ролей, названия и графа не затирает библиотеку', () => {
    for (const change of ['roles', 'title', 'graph']) {
      const context = pm.workflowGet('mine')
      if (change === 'roles') pm.updateRole('mine', 'developer', { model: 'new-model' })
      if (change === 'title') pm.renameTaskType('mine', { title: 'Новое имя' })
      if (change === 'graph') pm.workflowSet('mine', context.revision, graph())
      const before = readFileSync(path.join(tmp, 'projects.json'), 'utf8')
      assert.throws(() => pm.workflowSet('mine', context.revision, graph()), /измен[ёе]н|ревиз|конфликт/)
      assert.equal(readFileSync(path.join(tmp, 'projects.json'), 'utf8'), before)
    }
  })

  it('не восстанавливает удалённый тип и не сохраняет невалидный граф', () => {
    const context = pm.workflowGet('mine')
    const before = readFileSync(path.join(tmp, 'projects.json'), 'utf8')
    assert.throws(() => pm.workflowSet('mine', context.revision, { ...graph(), edges: [] }), /воркфлоу/)
    assert.equal(readFileSync(path.join(tmp, 'projects.json'), 'utf8'), before)
    pm.saveTaskType({ title: 'Запасной', settings: {} })
    pm.deleteTaskType('mine')
    assert.throws(() => pm.workflowSet('mine', context.revision, graph()), /не найден/)
    assert.equal(pm.taskType('mine'), undefined)
  })

  it('create проверяет до вставки и берёт роли выбранного базового типа, не запуская задачи', () => {
    const count = pm.taskTypes().length
    const before = readFileSync(path.join(tmp, 'projects.json'), 'utf8')
    assert.throws(() => pm.workflowCreate({ title: 'Ошибка', definition: { ...graph(), edges: [] } }), /воркфлоу/)
    assert.equal(pm.taskTypes().length, count)
    assert.equal(readFileSync(path.join(tmp, 'projects.json'), 'utf8'), before)
    const made = pm.workflowCreate({ title: ' Новый ', description: ' Готовый ', baseTypeId: 'mine', definition: graph() })
    assert.equal(made.title, 'Новый')
    assert.match(made.typeId, /^type_/)
    assert.deepEqual(pm.taskType(made.typeId)!.settings.roles, pm.taskType('mine')!.settings.roles)
    assert.equal(pm.store('p1').listRuns().length, 0)
    assert.equal(pm.store('p1').listTasks().length, 0)
    assert.equal(new ProjectManager(tmp).workflowGet(made.typeId).revision, made.revision)
  })

  it('новый граф использует default roles без проекта, конфликт type/base-type отвергается', () => {
    const prepared = pm.workflowValidate(graph())
    assert.deepEqual(prepared.errors, [])
    assert.throws(() => pm.workflowValidate(graph(), { typeId: 'mine', baseTypeId: 'mine' }), /type.*base-type/)
    assert.throws(() => pm.workflowValidate(graph(), { baseTypeId: 'gone' }), /не найден/)
    const made = pm.workflowCreate({ title: 'Без базы', definition: graph() })
    assert.deepEqual(pm.workflowGet(made.typeId).roles, DEFAULT_ROLES)
  })

  it('неудачная запись откатывает память и не сообщает о сохранении', () => {
    const context = pm.workflowGet('mine')
    const before = pm.taskTypes()
    const disk = readFileSync(path.join(tmp, 'projects.json'), 'utf8')
    const events: WorkflowAssistantSaved[] = []
    pm.onWorkflowSaved((event) => events.push(event))
    mkdirSync(path.join(tmp, 'projects.json.tmp'))
    assert.throws(() => pm.workflowSet('mine', context.revision, graph()))
    assert.deepEqual(pm.taskTypes(), before)
    assert.equal(readFileSync(path.join(tmp, 'projects.json'), 'utf8'), disk)
    assert.throws(() => pm.workflowCreate({ title: 'Не записан', definition: graph() }))
    assert.deepEqual(pm.taskTypes(), before)
    assert.deepEqual(events, [])
  })

  it('событие сохранения содержит только метаданные; validate и обычная правка его не создают', () => {
    const events: WorkflowAssistantSaved[] = []
    const unsubscribe = pm.onWorkflowSaved((event) => events.push(event))
    pm.workflowValidate(graph())
    pm.renameTaskType('mine', { title: 'Имя' })
    const saved = pm.workflowSet('mine', pm.workflowGet('mine').revision, graph())
    assert.deepEqual(events, [{ typeId: 'mine', title: 'Имя', revision: saved.revision }])
    unsubscribe()
    pm.workflowCreate({ title: 'После отписки', definition: graph() })
    assert.equal(events.length, 1)
  })

  it('validate/set/create сохраняют structured unknown-type errors без записи, включая subflow', () => {
    for (const type of ['__proto__', 'constructor', 'toString']) {
      const invalid = { version: 2,
        nodes: [{ id: 's', type: 'start' }, { id: 'bad', type }, { id: 'w', type: 'work' }, { id: 'e', type: 'end' }],
        edges: [{ id: 'sb', from: 's', outcome: 'next', to: 'bad' }, { id: 'bw', from: 'bad', outcome: 'next', to: 'w' },
          { id: 'be', from: 'bad', outcome: 'other', to: 'e' }, { id: 'we', from: 'w', outcome: 'next', to: 'e' }] }
      for (const nested of [false, true]) {
        const raw = nested ? { ...graph(), nodes: [{ id: 's', type: 'start' },
          { id: 'w', type: 'work', subflow: { nodes: invalid.nodes, edges: invalid.edges } }, { id: 'e', type: 'end' }] } : invalid
        const before = readFileSync(path.join(tmp, 'projects.json'), 'utf8')
        const result = pm.workflowValidate(raw, { typeId: 'mine' })
        assert.ok(result.errors.some((issue) => issue.code === 'nodeUnknownType'))
        const isUnknownType = (error: unknown): boolean => error instanceof WorkflowValidationError && error.validation.errors.some((issue) => issue.code === 'nodeUnknownType')
        assert.throws(() => pm.workflowSet('mine', pm.workflowGet('mine').revision, raw), isUnknownType)
        assert.throws(() => pm.workflowCreate({ title: 'Ошибочный', definition: raw }), isUnknownType)
        assert.equal(readFileSync(path.join(tmp, 'projects.json'), 'utf8'), before)
      }
    }
  })
})

/** Старая неоткрытая доска: её настоящее открытие должно по-прежнему эскалировать вопрос и добрать проверку. */
function unopenedLegacyBoard(): { file: string; raw: Record<string, unknown> } {
  const config = JSON.parse(readFileSync(path.join(tmp, 'projects.json'), 'utf8')) as { projects: Record<string, unknown>[] }
  config.projects[0].legacyTypeId = 'mine'
  writeFileSync(path.join(tmp, 'projects.json'), JSON.stringify(config))
  const file = path.join(tmp, 'boards', 'p1.json')
  mkdirSync(path.dirname(file), { recursive: true })
  const raw = {
    formatVersion: 1,
    runs: [{ id: 'run_legacy', objective: 'Старая цель', status: 'in_progress', createdAt: 1, updatedAt: 2, workflow: legacyDefaultWorkflow(DEFAULT_ROLES) }],
    tasks: [{ id: 'task_legacy', title: 'Ждёт проверки', spec: '', roleId: 'developer', runId: 'run_legacy', status: 'review',
      createdAt: 1, updatedAt: 2, stage: { nodeId: 'review', visits: { work: 1, review: 1 } } }],
    dispatches: [],
    questions: [{ id: 'q_legacy', taskId: 'task_legacy', question: 'Как проверить?', options: [], to: 'coordinator', createdAt: 2 }],
    requests: [], events: [], extraFutureMetadata: { untouched: true }
  }
  writeFileSync(file, JSON.stringify(raw, null, 2))
  pm = new ProjectManager(tmp)
  return { file, raw }
}

describe('сохранение workflow не открывает тихую legacy-доску', () => {
  it('успешная запись снимает прежний снимок офлайн, recovery происходит лишь при явном открытии', async () => {
    const { file, raw } = unopenedLegacyBoard()
    const oldRoles = pm.taskType('mine')!.settings.roles
    const opened: string[] = []
    const events: unknown[] = []
    let scheduledResume = 0
    pm.onStoreOpened((id) => { opened.push(id); setImmediate(() => scheduledResume++) })
    pm.onEvents((_id, additions) => events.push(...additions))
    pm.workflowSet('mine', pm.workflowGet('mine').revision, graph())
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(opened, [])
    assert.equal(scheduledResume, 0)
    assert.deepEqual(pm.loadedStores(), [])
    assert.deepEqual(events, [])
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(stored.runs[0].typeId, 'mine')
    assert.deepEqual(stored.runs[0].taskType.roles, oldRoles)
    assert.deepEqual(stored.runs[0].workflow, (raw.runs as { workflow: unknown }[])[0].workflow)
    assert.deepEqual(stored.tasks, raw.tasks)
    assert.deepEqual(stored.questions, raw.questions)
    assert.deepEqual(stored.requests, [])
    assert.deepEqual(stored.events, [])
    assert.deepEqual(stored.extraFutureMetadata, { untouched: true })
    const store = pm.store('p1')
    assert.deepEqual(opened, ['p1'])
    assert.ok(store.pendingRequests().some((request) => request.questionId === 'q_legacy'), 'настоящее открытие сохраняет восстановление вопросов')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(scheduledResume, 1)
    assert.equal(pm.store('p1'), store)
    assert.deepEqual(opened, ['p1'])
  })

  it('write failure не меняет raw board, cache, события и запланированное recovery', async () => {
    const { file } = unopenedLegacyBoard()
    const boardBefore = readFileSync(file, 'utf8')
    const configBefore = readFileSync(path.join(tmp, 'projects.json'), 'utf8')
    const typesBefore = pm.taskTypes()
    const opened: string[] = []
    const events: unknown[] = []
    let scheduledResume = 0
    pm.onStoreOpened((id) => { opened.push(id); setImmediate(() => scheduledResume++) })
    pm.onEvents((_id, additions) => events.push(...additions))
    mkdirSync(path.join(tmp, 'projects.json.tmp'))
    assert.throws(() => pm.workflowSet('mine', pm.workflowGet('mine').revision, graph()))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(readFileSync(file, 'utf8'), boardBefore)
    assert.equal(readFileSync(path.join(tmp, 'projects.json'), 'utf8'), configBefore)
    assert.deepEqual(pm.taskTypes(), typesBefore)
    assert.deepEqual(pm.loadedStores(), [])
    assert.deepEqual(opened, [])
    assert.equal(scheduledResume, 0)
    assert.deepEqual(events, [])
    assert.deepEqual(readdirSync(path.dirname(file)), ['p1.json'])
  })

  for (const operation of ['save', 'delete']) {
    it(`обычный ${operation} сохраняет старые snapshots без открытия доски`, () => {
      const { file } = unopenedLegacyBoard()
      const oldRoles = pm.taskType('mine')!.settings.roles
      pm.saveTaskType({ id: 'fallback', title: 'Запасной', settings: {} })
      let opened = 0
      pm.onStoreOpened(() => opened++)
      if (operation === 'save') pm.saveTaskType({ id: 'mine', title: 'Новое имя', settings: { roles: DEFAULT_ROLES } })
      else pm.deleteTaskType('mine')
      assert.equal(opened, 0)
      const stored = JSON.parse(readFileSync(file, 'utf8'))
      assert.equal(stored.runs[0].taskType.title, 'Мой тип')
      assert.deepEqual(stored.runs[0].taskType.roles, oldRoles)
      assert.deepEqual(pm.loadedStores(), [])
    })
  }
})
