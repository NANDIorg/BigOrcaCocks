// Запуск: pnpm --filter @orca-board/desktop test. Миграция projects.json на типы задач: чистая функция
// `migrateProjectsFile` и она же в `ProjectManager` на настоящих файлах (бэкап, запись сразу, повторная загрузка,
// прогоны старой доски получают тип проекта).
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DEFAULT_COLUMNS, DEFAULT_ROLES, GENERAL_TASK_TYPE_ID, LEGACY_TASK_TYPE_DESCRIPTION, TaskStore, builtinTaskTypes,
  defaultWorkflow, type Role, type Workflow
} from '@orca-board/core'
import { PROJECTS_FILE_VERSION, legacyTaskTypeId, migrateProjectsFile, type LegacyProjectsFile } from './task-types-migration'
import { PROJECTS_BACKUP_NAME, ProjectManager } from './projects'
import { jsonPersistence } from './persistence'

const DESIGNER: Role = { id: 'designer', title: 'Дизайнер', agent: 'claude', description: 'Макеты' }

/** Дефолтный граф с гейтом QA вместо ревью. */
function qaWorkflow(): Workflow {
  const wf = defaultWorkflow(DEFAULT_ROLES)
  return { ...wf, nodes: wf.nodes.map((n) => (n.id === 'review' ? { id: 'review', type: 'gate', roleId: 'qa', x: n.x, y: n.y } : n)) }
}

describe('migrateProjectsFile', () => {
  const legacy = (): LegacyProjectsFile => ({
    activeId: 'a',
    projects: [
      { id: 'a', root: '/a', name: 'api', roles: [...DEFAULT_ROLES, DESIGNER], workflow: qaWorkflow(), agentRules: 'правила', permissionMode: 'acceptEdits', templateId: 'backend', columns: DEFAULT_COLUMNS },
      { id: 'b', root: '/b', name: 'Общий' },
      { id: 'c', root: '/c', name: 'api' }
    ],
    templates: [{ id: 'tpl_1', title: 'Мой', settings: { agentRules: 'x' } }],
    defaultTemplateId: 'tpl_1'
  })

  it('каждый проект → тип «<имя>» с его настройками; тип — по умолчанию и legacyTypeId; старые поля удаляются', () => {
    const { data, changed } = migrateProjectsFile(legacy())
    assert.equal(changed, true)
    assert.equal(data.version, PROJECTS_FILE_VERSION)
    const a = data.projects[0]
    assert.deepEqual(Object.keys(a).sort(), ['columns', 'defaultTaskTypeId', 'id', 'legacyTypeId', 'name', 'root'])
    assert.equal(a.defaultTaskTypeId, legacyTaskTypeId('a'))
    assert.equal(a.legacyTypeId, legacyTaskTypeId('a'))
    assert.equal(a.taskTypeIds, undefined, 'доступны все типы библиотеки')
    const type = data.taskTypes!.find((t) => t.id === legacyTaskTypeId('a'))!
    assert.equal(type.title, 'api')
    assert.equal(type.description, LEGACY_TASK_TYPE_DESCRIPTION)
    assert.deepEqual(type.settings, { roles: [...DEFAULT_ROLES, DESIGNER], workflow: qaWorkflow(), agentRules: 'правила', permissionMode: 'acceptEdits' })
  })

  it('проект без своих настроек тоже получает тип: встроенные роли и зафиксированный дефолтный граф', () => {
    const { data } = migrateProjectsFile(legacy())
    const type = data.taskTypes!.find((t) => t.id === legacyTaskTypeId('b'))!
    assert.deepEqual(type.settings, { roles: DEFAULT_ROLES, workflow: defaultWorkflow(DEFAULT_ROLES) })
  })

  it('названия уникальны, в том числе среди встроенных', () => {
    const { data } = migrateProjectsFile(legacy())
    const title = (id: string): string => data.taskTypes!.find((t) => t.id === legacyTaskTypeId(id))!.title
    assert.equal(title('a'), 'api')
    assert.equal(title('c'), 'api (2)')
    assert.ok(builtinTaskTypes().some((t) => t.title === 'Общий'))
    assert.equal(title('b'), 'Общий (2)')
  })

  it('шаблоны → типы с теми же id, defaultTemplateId → defaultTaskTypeId', () => {
    const { data } = migrateProjectsFile(legacy())
    assert.deepEqual(data.taskTypes![0], { id: 'tpl_1', title: 'Мой', settings: { agentRules: 'x' } })
    assert.equal(data.defaultTaskTypeId, 'tpl_1')
    assert.equal('templates' in data, false)
    assert.equal('defaultTemplateId' in data, false)
  })

  it('повторная миграция ничего не меняет', () => {
    const once = migrateProjectsFile(legacy()).data
    const twice = migrateProjectsFile(JSON.parse(JSON.stringify(once)) as LegacyProjectsFile)
    assert.equal(twice.changed, false)
    assert.deepEqual(twice.data, once)
  })
})

describe('миграция в ProjectManager', () => {
  const PID = 'p1'
  let tmp: string

  beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'orca-types-mig-')) })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  function writeLegacy(extra: Record<string, unknown> = {}): string {
    const text = JSON.stringify({
      projects: [{ id: PID, root: path.join(tmp, 'repo'), name: 'repo', roles: [...DEFAULT_ROLES, DESIGNER], workflow: qaWorkflow(), agentRules: 'свои', permissionMode: 'bypassPermissions', templateId: 'backend' }],
      activeId: PID,
      defaults: { agentRules: 'общие', columns: DEFAULT_COLUMNS, enabledAgents: ['claude'] },
      settings: { keepInBackground: false },
      ...extra
    })
    writeFileSync(path.join(tmp, 'projects.json'), text)
    return text
  }

  function saved(): Record<string, unknown> {
    return JSON.parse(readFileSync(path.join(tmp, 'projects.json'), 'utf8')) as Record<string, unknown>
  }

  it('файл переписывается сразу, бэкап — исходный текст; настройки проекта — в его типе', () => {
    const text = writeLegacy()
    const pm = new ProjectManager(tmp)
    assert.equal(readFileSync(path.join(tmp, PROJECTS_BACKUP_NAME), 'utf8'), text)
    const file = saved()
    assert.equal(file.version, PROJECTS_FILE_VERSION)
    assert.equal(file.defaults, undefined)
    assert.deepEqual(file.settings, { keepInBackground: false })
    const r = pm.resolveRun(PID)
    assert.equal(r.typeId, `type_${PID}`)
    assert.equal(r.title, 'repo')
    assert.deepEqual(r.roles.map((x) => x.id), [...DEFAULT_ROLES, DESIGNER].map((x) => x.id))
    assert.equal(r.agentRules, 'свои')
    assert.equal(r.permissionMode, 'bypassPermissions')
    assert.deepEqual(pm.workflow(PID), qaWorkflow())
    // Старый `defaults` → пользовательский «Общий» (без колонок и агентов), он же тип библиотеки по умолчанию.
    const general = pm.taskType(GENERAL_TASK_TYPE_ID)!
    assert.equal(general.builtin, undefined)
    assert.deepEqual(general.settings, { agentRules: 'общие' })
    assert.equal(pm.defaultTaskTypeId(), GENERAL_TASK_TYPE_ID)
  })

  it('повторная загрузка ничего не меняет, бэкап не перезаписывается', () => {
    const text = writeLegacy()
    new ProjectManager(tmp)
    const after = readFileSync(path.join(tmp, 'projects.json'), 'utf8')
    writeFileSync(path.join(tmp, PROJECTS_BACKUP_NAME), 'чужой бэкап')
    const pm = new ProjectManager(tmp)
    assert.equal(readFileSync(path.join(tmp, 'projects.json'), 'utf8'), after)
    assert.equal(readFileSync(path.join(tmp, PROJECTS_BACKUP_NAME), 'utf8'), 'чужой бэкап')
    assert.notEqual(text, after)
    assert.equal(pm.taskTypes().filter((t) => t.id === `type_${PID}`).length, 1)
  })

  it('новый файл: без миграции и бэкапа', () => {
    const pm = new ProjectManager(tmp)
    assert.deepEqual(pm.list(), [])
    assert.equal(existsSync(path.join(tmp, PROJECTS_BACKUP_NAME)), false)
  })

  it('прогоны старой доски получают тип проекта (legacyTypeId), даже если тип по умолчанию успели сменить', () => {
    writeLegacy()
    // Доска старого формата: прогон с задачей и снимком графа, «Входящие».
    const boards = path.join(tmp, 'boards')
    mkdirSync(boards)
    const old = new TaskStore(jsonPersistence(path.join(boards, `${PID}.json`)), () => DEFAULT_COLUMNS)
    const run = old.createRun('старая цель', undefined, qaWorkflow())
    old.createTask({ title: 'дизайн', roleId: 'designer', agent: 'claude', runId: run.id })
    old.createTask({ title: 'во входящих' })

    const pm = new ProjectManager(tmp)
    pm.setProjectTaskTypes(PID, { defaultTypeId: 'docs' })
    const store = pm.store(PID)
    const migrated = store.getRun(run.id)!
    assert.equal(migrated.typeId, `type_${PID}`)
    assert.equal(migrated.taskType?.title, 'repo')
    assert.deepEqual(migrated.workflow, qaWorkflow(), 'снимок графа не тронут')
    assert.ok(pm.roles(PID, run.id).some((r) => r.id === 'designer'), 'роли прогона — роли проекта')
    assert.equal(pm.resolveRun(PID).typeId, 'docs', '«Входящие» — новый тип проекта по умолчанию')
    const inbox = store.listRuns().find((r) => r.inbox)
    assert.equal(inbox?.typeId, undefined, '«Входящие» тип не получают')
  })

  it('тип удалён — прогон дорабатывает по снимку', () => {
    writeLegacy()
    const pm = new ProjectManager(tmp)
    const run = pm.store(PID).createRun('цель', undefined, pm.runType(PID))
    pm.setProjectTaskTypes(PID, { defaultTypeId: GENERAL_TASK_TYPE_ID })
    pm.deleteTaskType(`type_${PID}`)
    const r = pm.resolveRun(PID, run.id)
    assert.equal(r.source, 'snapshot')
    assert.ok(r.roles.some((x) => x.id === 'designer'))
    assert.equal(r.agentRules, 'свои')
  })

  it('граф проекта ссылается на удалённую роль — тип «<имя>» и его роли не теряются', () => {
    // До типов `setRoles` не сверял граф с ролями: гейт reviewer остался, а роли reviewer уже нет.
    const roles = DEFAULT_ROLES.filter((r) => r.id !== 'reviewer').map((r) => (r.id === 'developer' ? { ...r, model: 'x' } : r))
    writeLegacy({ projects: [{ id: PID, root: path.join(tmp, 'repo'), name: 'repo', roles, workflow: defaultWorkflow(DEFAULT_ROLES), agentRules: 'свои' }] })
    const pm = new ProjectManager(tmp)
    assert.equal(pm.projectDefaultTypeId(PID), `type_${PID}`)
    assert.equal(pm.roles(PID).find((r) => r.id === 'developer')?.model, 'x')
    assert.equal(pm.resolveRun(PID).agentRules, 'свои')
    assert.deepEqual(pm.taskType(`type_${PID}`)?.settings.workflow, defaultWorkflow(DEFAULT_ROLES), 'граф сохранён как был')
    const again = new ProjectManager(tmp)
    assert.equal(again.roles(PID).find((r) => r.id === 'developer')?.model, 'x', 'и после рестарта')
  })

  it('битые разделы типа отбрасываются по одному, тип остаётся', () => {
    const bad = {
      id: 'type_bad', title: 'Битый',
      settings: { roles: [DESIGNER, { id: 'x', title: 'X', agent: 'нет такого' }, { ...DESIGNER, title: 'Второй' }], permissionMode: 'нет', agentRules: 1, workflow: 'мусор' }
    }
    const empty = { id: 'type_empty', title: 'Пустой', settings: { roles: [], agentRules: 'правила' } }
    writeFileSync(path.join(tmp, 'projects.json'), JSON.stringify({ version: PROJECTS_FILE_VERSION, projects: [], activeId: null, taskTypes: [bad, empty, { id: 'type_no', title: 'Без настроек' }] }))
    const pm = new ProjectManager(tmp)
    assert.deepEqual(pm.taskType('type_bad')?.settings, { roles: [DESIGNER] })
    assert.deepEqual(pm.taskType('type_empty')?.settings, { agentRules: 'правила' })
    assert.equal(pm.taskType('type_no'), undefined, 'без объекта настроек типа нет')
  })
})
