// Запуск: pnpm --filter @orca-board/desktop test. Автомиграция графов сохранённых типов v1 → v2 при загрузке
// projects.json (`migrateTypeWorkflows`): предупреждения человеку в `TaskType.workflowNotes`, запись файла и бэкап,
// правка типа. И то, чего миграция не трогает: копии графа в прогонах (`Run.workflow`) — старые прогоны без
// `workflowScope` доживают на движке по подзадачам.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DEFAULT_COLUMNS, DEFAULT_ROLES, TaskStore, WORKFLOW_VERSION, WORKFLOW_VERSION_TASK_SCOPE, defaultWorkflow, legacyDefaultWorkflow,
  type TaskType, type Workflow
} from '@orca-board/core'
import { migrateTypeWorkflows, PROJECTS_FILE_VERSION } from './task-types-migration'
import { PROJECTS_BACKUP_NAME, PROJECTS_WORKFLOW_BACKUP_NAME, ProjectManager } from './projects'
import { jsonPersistence } from './persistence'

const PID = 'p1'
const TID = 'type_old'

/** Пользовательский тип с графом версии 1: работа с ролью, ревью, мерж, «Конфликт мержа» и условие по роли. */
function v1Graph(): Workflow {
  const wf = legacyDefaultWorkflow(DEFAULT_ROLES)
  const work = wf.nodes.find((n) => n.id === 'work')
  if (work?.type === 'work') work.roleId = 'developer'
  return wf
}

const typeOf = (settings: TaskType['settings'], extra: Partial<TaskType> = {}): TaskType => ({ id: TID, title: 'Старый', settings, ...extra })

describe('migrateTypeWorkflows: чистая функция', () => {
  it('граф v1 → v2 с предупреждениями в workflowNotes; роль работы переезжает в roleIds; исходный тип не мутируется', () => {
    const t = typeOf({ workflow: v1Graph() })
    const snapshot = structuredClone(t)
    const { types, changed } = migrateTypeWorkflows([t])
    assert.equal(changed, true)
    assert.deepEqual(t, snapshot)
    const wf = types[0].settings.workflow!
    assert.equal(wf.version, WORKFLOW_VERSION)
    assert.ok(!wf.nodes.some((n) => n.type === 'merge'))
    const work = wf.nodes.find((n) => n.id === 'work')
    assert.deepEqual(work?.type === 'work' ? work.roleIds : undefined, ['developer'])
    assert.deepEqual(types[0].workflowNotes?.map((n) => n.code), ['mergeRemoved', 'nodeOrphaned', 'noHumanBeforeEnd'])
    assert.ok(types[0].workflowNotes!.every((n) => n.message.length > 0), 'сообщения — готовый русский текст')
  })

  it('условие по роли снимается с переходом по «Да» и попадает в предупреждения', () => {
    const wf = legacyDefaultWorkflow(DEFAULT_ROLES)
    wf.nodes.push({ id: 'cond', type: 'condition', test: { kind: 'role', roleIds: ['qa'] }, x: 0, y: 0 })
    wf.edges = wf.edges.map((e) => (e.id === 'e_review_accept' ? { ...e, to: 'cond' } : e))
    wf.edges.push({ id: 'e_cond_yes', from: 'cond', outcome: 'yes', to: 'merge' }, { id: 'e_cond_no', from: 'cond', outcome: 'no', to: 'end' })
    const { types } = migrateTypeWorkflows([typeOf({ workflow: wf })])
    assert.ok(!types[0].settings.workflow!.nodes.some((n) => n.id === 'cond'))
    assert.ok(types[0].workflowNotes!.some((n) => n.code === 'roleConditionRemoved' && n.nodeId === 'cond'))
  })

  it('вопрос без роли получает роль по ролям типа', () => {
    const wf = legacyDefaultWorkflow(DEFAULT_ROLES)
    wf.nodes.push({ id: 'q', type: 'ask', instructions: 'спроси', x: 0, y: 0 })
    const roles = DEFAULT_ROLES.filter((r) => r.id !== 'developer')
    const { types } = migrateTypeWorkflows([typeOf({ workflow: wf, roles })])
    const ask = types[0].settings.workflow!.nodes.find((n) => n.id === 'q')
    assert.notEqual(ask?.type === 'ask' ? ask.roleId : undefined, 'developer', 'роли developer у типа нет')
    assert.ok(types[0].workflowNotes!.some((n) => n.code === 'askRoleSet'))
  })

  it('граф v2, будущей версии и тип без графа не трогаются; changed=false', () => {
    const v2 = typeOf({ workflow: defaultWorkflow(DEFAULT_ROLES) })
    const future = typeOf({ workflow: { ...defaultWorkflow(DEFAULT_ROLES), version: WORKFLOW_VERSION + 1 } }, { id: 'future' })
    const none = typeOf({}, { id: 'none' })
    const res = migrateTypeWorkflows([v2, future, none])
    assert.equal(res.changed, false)
    assert.deepEqual(res.types, [v2, future, none])
    assert.equal(res.types[0], v2, 'тот же объект — ничего не копировалось')
  })

  it('идемпотентна; прежние предупреждения остаются, повторы не добавляются', () => {
    const once = migrateTypeWorkflows([typeOf({ workflow: v1Graph() })])
    const twice = migrateTypeWorkflows(once.types)
    assert.equal(twice.changed, false)
    assert.deepEqual(twice.types, once.types)
    const kept = typeOf({ workflow: v1Graph() }, { workflowNotes: [{ code: 'mergeRemoved', nodeId: 'merge', message: 'старая пометка' }] })
    const merged = migrateTypeWorkflows([kept]).types[0].workflowNotes!
    assert.equal(merged[0].message, 'старая пометка')
    assert.ok(merged.length > 1)
  })
})

describe('ProjectManager: автомиграция графов типов при загрузке', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'orca-wf-mig-')) })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  const projectsPath = (): string => path.join(tmp, 'projects.json')
  const saved = (): { taskTypes: TaskType[]; version: number } => JSON.parse(readFileSync(projectsPath(), 'utf8'))

  /** projects.json нового формата (`version` 2) с типом на графе v1: приложение до воркфлоу глобальной задачи. */
  function writeV1Types(): string {
    const text = JSON.stringify({
      version: PROJECTS_FILE_VERSION,
      taskTypesSeeded: true,
      projects: [{ id: PID, root: path.join(tmp, 'repo'), name: 'repo', defaultTaskTypeId: TID }],
      activeId: PID,
      taskTypes: [{ id: TID, title: 'Старый', settings: { roles: DEFAULT_ROLES, workflow: v1Graph() } }]
    })
    writeFileSync(projectsPath(), text)
    return text
  }

  it('тип на v1: граф v2, предупреждения в workflowNotes, файл переписан, бэкап — исходный текст', () => {
    const text = writeV1Types()
    const pm = new ProjectManager(tmp)
    const type = pm.taskType(TID)!
    assert.equal(type.settings.workflow!.version, WORKFLOW_VERSION)
    assert.ok(type.workflowNotes!.some((n) => n.code === 'mergeRemoved'))
    assert.equal(pm.taskTypeWorkflow(TID).workflow.version, WORKFLOW_VERSION)
    assert.equal(pm.taskTypesState().taskTypes.find((t) => t.id === TID)?.workflowNotes?.length, type.workflowNotes!.length, 'renderer получает их вместе со списком типов')
    // Файл уже на v2: предупреждения не пересчитываются при каждом запуске.
    const onDisk = saved().taskTypes.find((t) => t.id === TID)!
    assert.equal(onDisk.settings.workflow!.version, WORKFLOW_VERSION)
    assert.deepEqual(onDisk.workflowNotes, type.workflowNotes)
    assert.equal(readFileSync(path.join(tmp, PROJECTS_WORKFLOW_BACKUP_NAME), 'utf8'), text)
    assert.equal(existsSync(path.join(tmp, PROJECTS_BACKUP_NAME)), false, 'формат файла не менялся — бэкап «до типов» не нужен')
  })

  it('повторная загрузка: тот же файл, предупреждения на месте, бэкап не перезаписывается', () => {
    writeV1Types()
    const first = new ProjectManager(tmp).taskType(TID)!
    const after = readFileSync(projectsPath(), 'utf8')
    writeFileSync(path.join(tmp, PROJECTS_WORKFLOW_BACKUP_NAME), 'чужой бэкап')
    const again = new ProjectManager(tmp).taskType(TID)!
    assert.equal(readFileSync(projectsPath(), 'utf8'), after)
    assert.equal(readFileSync(path.join(tmp, PROJECTS_WORKFLOW_BACKUP_NAME), 'utf8'), 'чужой бэкап')
    assert.deepEqual(again, first)
  })

  it('файл без графов v1 не перезаписывается и бэкапа не даёт', () => {
    const pm0 = new ProjectManager(tmp)
    pm0.saveTaskType({ id: TID, title: 'Свой', settings: { workflow: defaultWorkflow(DEFAULT_ROLES) } })
    const before = readFileSync(projectsPath(), 'utf8')
    const pm = new ProjectManager(tmp)
    assert.equal(readFileSync(projectsPath(), 'utf8'), before)
    assert.equal(pm.taskType(TID)!.workflowNotes, undefined)
    assert.equal(existsSync(path.join(tmp, PROJECTS_WORKFLOW_BACKUP_NAME)), false)
  })

  it('файл до типов: граф проекта, ставший типом, мигрирует с ролями проекта; бэкап один — исходный', () => {
    const roles = DEFAULT_ROLES.map((r) => (r.id === 'developer' ? { ...r, model: 'x' } : r))
    const text = JSON.stringify({
      projects: [{ id: PID, root: path.join(tmp, 'repo'), name: 'repo', roles, workflow: v1Graph() }],
      activeId: PID
    })
    writeFileSync(projectsPath(), text)
    const pm = new ProjectManager(tmp)
    const type = pm.taskType(`type_${PID}`)!
    assert.equal(type.settings.workflow!.version, WORKFLOW_VERSION)
    assert.ok(type.workflowNotes!.some((n) => n.code === 'mergeRemoved'))
    assert.equal(readFileSync(path.join(tmp, PROJECTS_BACKUP_NAME), 'utf8'), text)
    assert.equal(existsSync(path.join(tmp, PROJECTS_WORKFLOW_BACKUP_NAME)), false, 'отдельная копия не нужна: исходный текст уже сохранён')
    assert.deepEqual(new ProjectManager(tmp).taskType(`type_${PID}`)!.workflowNotes, type.workflowNotes, 'и после рестарта')
  })

  it('шаблон проекта старого формата с графом v1 тоже мигрирует', () => {
    writeFileSync(projectsPath(), JSON.stringify({
      projects: [],
      templates: [{ id: 'tpl', title: 'Шаблон', settings: { workflow: v1Graph() } }]
    }))
    const type = new ProjectManager(tmp).taskType('tpl')!
    assert.equal(type.settings.workflow!.version, WORKFLOW_VERSION)
    assert.ok(type.workflowNotes!.length > 0)
  })

  it('тип из будущей версии формата остаётся как есть и не блокирует остальные', () => {
    const future = { ...defaultWorkflow(DEFAULT_ROLES), version: WORKFLOW_VERSION + 1 }
    writeFileSync(projectsPath(), JSON.stringify({
      version: PROJECTS_FILE_VERSION, taskTypesSeeded: true, projects: [], activeId: null,
      taskTypes: [
        { id: 'fut', title: 'Будущий', settings: { workflow: future } },
        { id: TID, title: 'Старый', settings: { workflow: v1Graph() } }
      ]
    }))
    const pm = new ProjectManager(tmp)
    assert.equal(pm.taskType('fut')!.settings.workflow!.version, WORKFLOW_VERSION + 1)
    assert.equal(pm.taskType('fut')!.workflowNotes, undefined)
    assert.equal(pm.taskType(TID)!.settings.workflow!.version, WORKFLOW_VERSION)
  })

  it('правка типа: роли и название оставляют предупреждения, правка графа их снимает, явный список — закрывает', () => {
    writeV1Types()
    const pm = new ProjectManager(tmp)
    const notes = pm.taskType(TID)!.workflowNotes!
    assert.ok(notes.length > 0)
    pm.patchTaskType(TID, { agentRules: 'новые правила' })
    assert.deepEqual(pm.taskType(TID)!.workflowNotes, notes, 'граф не менялся')
    // Человек открыл тип и сохранил его целиком, как это делает редактор: без поля workflowNotes — граф тот же.
    const t = pm.taskType(TID)!
    pm.saveTaskType({ id: t.id, title: 'Переименован', settings: t.settings })
    assert.deepEqual(new ProjectManager(tmp).taskType(TID)!.workflowNotes, notes)
    // Правка графа.
    pm.patchTaskType(TID, { workflow: defaultWorkflow(DEFAULT_ROLES) })
    assert.equal(pm.taskType(TID)!.workflowNotes, undefined)
    assert.equal(new ProjectManager(tmp).taskType(TID)!.workflowNotes, undefined)
    // Явно переданный список — как есть, пустой — «закрыть»; битые записи выпадают.
    const kept = pm.taskType(TID)!
    pm.saveTaskType({ id: kept.id, title: kept.title, settings: kept.settings, workflowNotes: [{ code: 'mergeRemoved', message: 'вручную' }, { code: '', message: 'нет кода' } as never] })
    assert.deepEqual(pm.taskType(TID)!.workflowNotes, [{ code: 'mergeRemoved', message: 'вручную' }])
    pm.saveTaskType({ id: kept.id, title: kept.title, settings: kept.settings, workflowNotes: [] })
    assert.equal(pm.taskType(TID)!.workflowNotes, undefined)
  })

  it('копия типа предупреждений не наследует, а в прогоны они не попадают', () => {
    writeV1Types()
    const pm = new ProjectManager(tmp)
    assert.equal(pm.duplicateTaskType(TID).workflowNotes, undefined)
    const input = pm.runType(PID, TID)
    assert.equal('workflowNotes' in input, false)
    assert.equal(JSON.stringify(input).includes('mergeRemoved'), false)
  })

  it('сохранение графа старой версии (renderer до обновления): переводится на v2 по ролям типа', () => {
    const pm = new ProjectManager(tmp)
    const type = pm.saveTaskType({ id: 'stale', title: 'Stale', settings: { roles: DEFAULT_ROLES, workflow: legacyDefaultWorkflow(DEFAULT_ROLES) } })
    assert.equal(type.settings.workflow!.version, WORKFLOW_VERSION)
    assert.ok(!type.settings.workflow!.nodes.some((n) => n.type === 'merge'))
  })
})

describe('старые прогоны после миграции типа: снимок графа не тронут, движок — по подзадачам', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'orca-wf-mig-runs-')) })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('Run.workflow остаётся v1 (без workflowScope); прогон без снимка берёт граф типа по-старому (merge и конфликт возвращаются)', () => {
    const PID2 = 'p2'
    writeFileSync(path.join(tmp, 'projects.json'), JSON.stringify({
      version: PROJECTS_FILE_VERSION, taskTypesSeeded: true, activeId: PID2,
      projects: [{ id: PID2, root: path.join(tmp, 'repo'), name: 'repo', defaultTaskTypeId: TID }],
      taskTypes: [{ id: TID, title: 'Старый', settings: { roles: DEFAULT_ROLES, workflow: v1Graph() } }]
    }))
    const boards = path.join(tmp, 'boards')
    mkdirSync(boards)
    const old = new TaskStore(jsonPersistence(path.join(boards, `${PID2}.json`)), () => DEFAULT_COLUMNS)
    const withSnapshot = old.createRun('со снимком', undefined, v1Graph())
    const noSnapshot = old.createRun('без снимка')
    const t1 = old.createTask({ title: 'A', runId: withSnapshot.id })
    const t2 = old.createTask({ title: 'B', runId: noSnapshot.id })

    const pm = new ProjectManager(tmp)
    const store = pm.store(PID2)
    const a = store.getRun(withSnapshot.id)!
    assert.deepEqual(a.workflow, v1Graph(), 'копия графа старого прогона не мигрирует')
    assert.equal(a.workflow!.version, WORKFLOW_VERSION_TASK_SCOPE)
    assert.equal(a.workflowScope, undefined)
    assert.equal(store.getRun(noSnapshot.id)!.workflowScope, undefined)
    // Граф типа уже v2, но подзадачи прогона без снимка ходят по нему как по графу задач: мерж и конфликт на месте.
    const wf = store.runWorkflow(noSnapshot.id, { workflow: pm.taskType(TID)!.settings.workflow })
    assert.equal(wf.version, WORKFLOW_VERSION_TASK_SCOPE)
    assert.ok(wf.nodes.some((n) => n.type === 'merge'))
    assert.ok(wf.nodes.some((n) => n.id === 'conflict'))
    // Подзадачи по-прежнему входят в граф сами (стар. движок): stage у задачи, а не у прогона.
    store.advanceStage(t1.id, 'next')
    store.advanceStage(t2.id, 'next', { workflow: pm.taskType(TID)!.settings.workflow })
    assert.equal(store.getTask(t1.id)!.stage?.nodeId, 'work')
    assert.equal(store.getRun(withSnapshot.id)!.stage, undefined)
    // Новый прогон типа идёт по графу прогона.
    const fresh = store.createRun('новый', undefined, pm.runType(PID2, TID))
    assert.equal(fresh.workflowScope, 'run')
    assert.equal(fresh.workflow!.version, WORKFLOW_VERSION)
  })
})
