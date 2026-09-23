// Запуск: pnpm --filter @orca-board/desktop test. Типы задач в ProjectManager: библиотека (встроенные и
// пользовательские, правка встроенного на месте), типы проекта, тип нового прогона и роли по прогону,
// колонки проекта. Миграция — task-types-migration.test.ts.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DEFAULT_COLUMNS, DEFAULT_ROLES, GENERAL_TASK_TYPE_ID, builtinTaskType, builtinTaskTypes, defaultWorkflow,
  type BoardColumn, type Role
} from '@orca-board/core'
import { ProjectManager } from './projects'
import { PROJECTS_FILE_VERSION } from './task-types-migration'

const PID = 'p1'
let tmp: string

/** projects.json нового формата с одним проектом без своего типа. */
function writeConfig(extra: Record<string, unknown> = {}, project: Record<string, unknown> = {}): void {
  writeFileSync(path.join(tmp, 'projects.json'), JSON.stringify({
    version: PROJECTS_FILE_VERSION,
    projects: [{ id: PID, root: path.join(tmp, 'repo'), name: 'repo', columns: DEFAULT_COLUMNS, ...project }],
    activeId: PID,
    ...extra
  }))
}

function saved(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(tmp, 'projects.json'), 'utf8')) as Record<string, unknown>
}

function gitRepo(name: string, files: Record<string, string> = {}): string {
  const dir = path.join(tmp, name)
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: dir })
  for (const [file, text] of Object.entries(files)) writeFileSync(path.join(dir, file), text)
  return dir
}

const DESIGNER: Role = { id: 'designer', title: 'Дизайнер', agent: 'claude', description: 'Макеты' }

beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'orca-types-')) })
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('библиотека типов', () => {
  it('встроенные в их порядке, затем пользовательские; копия встроенного подменяет его', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    assert.deepEqual(pm.taskTypes().map((t) => t.id), builtinTaskTypes().map((t) => t.id))
    const own = pm.saveTaskType({ title: '  Мой  ', description: ' одна строка ', settings: { agentRules: 'r' } })
    assert.equal(own.title, 'Мой')
    assert.equal(own.description, 'одна строка')
    assert.equal(pm.taskTypes().at(-1)?.id, own.id)
    assert.deepEqual(new ProjectManager(tmp).taskType(own.id), own, 'переживает перезапуск')
  })

  it('копия встроенного под старым названием получает новое: встроенные переименовали («Общий» → «Программирование»)', () => {
    const general = builtinTaskType(GENERAL_TASK_TYPE_ID)!
    const docs = builtinTaskType('docs')!
    writeConfig({ taskTypes: [
      { id: GENERAL_TASK_TYPE_ID, title: 'Общий', description: 'Перенесён из «Настройки → Для новых проектов».', settings: { agentRules: 'r' } },
      { ...docs, builtin: undefined, title: 'Документация / аналитика' }
    ] })
    const pm = new ProjectManager(tmp)
    assert.equal(pm.taskType(GENERAL_TASK_TYPE_ID)?.title, general.title)
    assert.equal(pm.taskType(GENERAL_TASK_TYPE_ID)?.settings.agentRules, 'r', 'настройки копии не трогаются')
    assert.equal(pm.taskType('docs')?.title, docs.title)
    // Правка на месте сверяется с копией — после переименования она по-прежнему проходит.
    assert.equal(pm.saveTaskTypeRules('docs', undefined, 'правила').title, docs.title)
  })

  it('встроенный на месте: исполнитель, системный промпт роли и правила — да, остальное — «Дублировать»', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    const docs = builtinTaskType('docs')!
    const roles = (docs.settings.roles ?? DEFAULT_ROLES).map((r, i) => (i === 0 ? { ...r, agent: 'codex' as const, model: 'gpt', systemPrompt: 'свой' } : r))
    const edited = pm.saveTaskType({ id: 'docs', title: docs.title, description: docs.description, settings: { ...docs.settings, roles, agentRules: 'правила' } })
    assert.equal(edited.settings.roles![0].agent, 'codex')
    assert.equal(pm.taskType('docs')?.builtin, undefined, 'изменённый встроенный — пользовательская копия с его id')
    assert.equal(pm.taskTypes().filter((t) => t.id === 'docs').length, 1)
    assert.throws(() => pm.saveTaskType({ id: 'docs', title: 'Другое', settings: docs.settings }), /Дублировать/)
    assert.throws(() => pm.patchTaskType('backend', { roles: [...(builtinTaskType('backend')!.settings.roles ?? DEFAULT_ROLES), DESIGNER] }), /Дублировать/)
    assert.throws(() => pm.patchTaskType('backend', { permissionMode: 'bypassPermissions' }), /Дублировать/)
    // Удаление копии возвращает встроенный; сам встроенный не удаляется.
    pm.deleteTaskType('docs')
    assert.equal(pm.taskType('docs')?.builtin, true)
    assert.throws(() => pm.deleteTaskType('docs'), /встроенный/)
  })

  it('дублирование: копия под новым id, редактируется целиком', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    const copy = pm.duplicateTaskType('frontend')
    assert.notEqual(copy.id, 'frontend')
    assert.equal(copy.title, `${builtinTaskType('frontend')!.title} (копия)`)
    assert.deepEqual(copy.settings, builtinTaskType('frontend')!.settings)
    const next = pm.patchTaskType(copy.id, { roles: [...DEFAULT_ROLES, DESIGNER], permissionMode: 'acceptEdits' })
    assert.equal(next.settings.permissionMode, 'acceptEdits')
  })

  it('валидация: название, роли, граф — по ролям типа; колонки и агенты старого формата отбрасываются', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    assert.throws(() => pm.saveTaskType({ title: '', settings: {} }), /пустое название/)
    assert.throws(() => pm.saveTaskType({ title: 'T', settings: { roles: [] } }), /хотя бы одна роль/)
    assert.throws(() => pm.saveTaskType({ title: 'T', settings: { permissionMode: 'x' as never } }), /режим разрешений/)
    const t = pm.saveTaskType({ title: 'Со старыми полями', settings: { columns: DEFAULT_COLUMNS, enabledAgents: ['claude'], agentRules: 'r' } as never })
    assert.deepEqual(t.settings, { agentRules: 'r' })
  })

  it('тип по умолчанию: установка, удаление сбрасывает на «Программирование»', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    const t = pm.saveTaskType({ title: 'Мой', settings: {} })
    assert.equal(pm.setDefaultTaskType(t.id).defaultTaskTypeId, t.id)
    assert.throws(() => pm.setDefaultTaskType('нет-такого'), /тип задачи не найден/)
    assert.equal(pm.deleteTaskType(t.id).defaultTaskTypeId, GENERAL_TASK_TYPE_ID)
  })

  it('rules: правила и промпт роли встроенного типа правятся на месте', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    pm.saveTaskTypeRules(GENERAL_TASK_TYPE_ID, undefined, 'общие правила')
    pm.saveTaskTypeRules(GENERAL_TASK_TYPE_ID, 'developer', 'промпт')
    const t = pm.taskType(GENERAL_TASK_TYPE_ID)!
    assert.equal(t.settings.agentRules, 'общие правила')
    assert.equal(t.settings.roles?.find((r) => r.id === 'developer')?.systemPrompt, 'промпт')
    assert.throws(() => pm.saveTaskTypeRules(GENERAL_TASK_TYPE_ID, 'ghost', 'x'), /нет роли «ghost»/)
  })

  it('пользовательский тип: граф со ссылкой на удалённую роль переживает рестарт вместе с ролями', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    const t = pm.saveTaskType({ title: 'Мой', settings: { roles: DEFAULT_ROLES, workflow: defaultWorkflow(DEFAULT_ROLES) } })
    const roles = DEFAULT_ROLES.filter((r) => r.id !== 'reviewer')
    pm.saveTaskType({ id: t.id, title: 'Мой', settings: { roles, workflow: defaultWorkflow(DEFAULT_ROLES) } })
    const loaded = new ProjectManager(tmp).taskType(t.id)
    assert.deepEqual(loaded?.settings.roles?.map((r) => r.id), roles.map((r) => r.id))
    assert.deepEqual(loaded?.settings.workflow, defaultWorkflow(DEFAULT_ROLES))
  })
})


describe('типы проекта', () => {
  it('add: колонки встроенные, тип по умолчанию — заданный или библиотеки; копии настроек нет', () => {
    const pm = new ProjectManager(tmp)
    const api = pm.add(gitRepo('api'), 'backend')
    assert.equal(api.defaultTaskTypeId, 'backend')
    assert.deepEqual(api.columns, DEFAULT_COLUMNS)
    assert.equal('roles' in api, false)
    assert.deepEqual(pm.roles(api.id), builtinTaskType('backend')!.settings.roles ?? DEFAULT_ROLES, 'роли — из типа по умолчанию')
    assert.equal(pm.add(gitRepo('plain')).defaultTaskTypeId, GENERAL_TASK_TYPE_ID)
    assert.throws(() => pm.add(gitRepo('x'), 'нет-такого'), /тип задачи не найден/)
    assert.equal(pm.add(gitRepo('api'), 'frontend').defaultTaskTypeId, 'backend', 'уже добавленный — как есть')
  })

  it('detectTaskType: угаданный встроенный, без признаков — тип библиотеки по умолчанию', () => {
    const pm = new ProjectManager(tmp)
    const front = gitRepo('front', { 'package.json': JSON.stringify({ dependencies: { react: '^18' } }) })
    assert.deepEqual(pm.detectTaskType(front), { path: front, typeId: 'frontend', reason: 'package.json: react' })
    const t = pm.saveTaskType({ title: 'Мой', settings: {} })
    pm.setDefaultTaskType(t.id)
    const empty = gitRepo('empty')
    assert.deepEqual(pm.detectTaskType(empty), { path: empty, typeId: t.id, reason: '' })
  })

  it('setProjectTaskTypes: доступные и по умолчанию; null — все; ошибки', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    pm.setProjectTaskTypes(PID, { typeIds: ['docs', 'backend'], defaultTypeId: 'docs' })
    assert.deepEqual(pm.projectTaskTypes(PID).map((t) => t.id), ['backend', 'docs'])
    assert.equal(pm.projectDefaultTypeId(PID), 'docs')
    assert.throws(() => pm.setProjectTaskTypes(PID, { typeIds: ['docs'], defaultTypeId: 'backend' }), /должен быть среди доступных/)
    assert.throws(() => pm.setProjectTaskTypes(PID, { typeIds: [], defaultTypeId: 'docs' }), /хотя бы один/)
    assert.throws(() => pm.setProjectTaskTypes(PID, { typeIds: ['ghost'], defaultTypeId: 'ghost' }), /не найден: ghost/)
    pm.setProjectTaskTypes(PID, { typeIds: null, defaultTypeId: 'backend' })
    assert.equal(pm.projectTaskTypes(PID).length, builtinTaskTypes().length)
    assert.equal('taskTypeIds' in (saved().projects as Array<Record<string, unknown>>)[0], false)
  })

  it('тип по умолчанию удалён — тип библиотеки по умолчанию', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    const t = pm.saveTaskType({ title: 'Временный', settings: {} })
    pm.setProjectTaskTypes(PID, { defaultTypeId: t.id })
    pm.deleteTaskType(t.id)
    assert.equal(pm.projectDefaultTypeId(PID), GENERAL_TASK_TYPE_ID)
  })
})

describe('тип прогона и роли по прогону', () => {
  it('runType: без типа — по умолчанию; тип вне доступных проекту — ошибка с подсказкой', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    assert.equal(pm.runType(PID).typeId, GENERAL_TASK_TYPE_ID)
    pm.setProjectTaskTypes(PID, { typeIds: ['docs'], defaultTypeId: 'docs' })
    assert.equal(pm.runType(PID).typeId, 'docs')
    assert.throws(() => pm.runType(PID, 'backend'), /недоступен в проекте «repo».*types list/)
    assert.throws(() => pm.runType(PID, 'ghost'), /не найден: ghost/)
  })

  it('два прогона разных типов — у каждого свои роли, правила, разрешения и граф', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    const mine = pm.saveTaskType({ title: 'С дизайнером', settings: { roles: [...DEFAULT_ROLES, DESIGNER], agentRules: 'макеты', permissionMode: 'acceptEdits' } })
    const store = pm.store(PID)
    const a = store.createGlobalTask({ title: 'A', type: pm.runType(PID, mine.id) })
    const b = store.createGlobalTask({ title: 'B', type: pm.runType(PID, 'docs') })
    assert.equal(store.getRun(a.id)?.typeId, mine.id)
    const ra = pm.resolveRun(PID, a.id)
    assert.ok(ra.roles.some((r) => r.id === 'designer'))
    assert.equal(ra.agentRules, 'макеты')
    assert.equal(ra.permissionMode, 'acceptEdits')
    const rb = pm.resolveRun(PID, b.id)
    assert.equal(rb.typeId, 'docs')
    assert.deepEqual(rb.roles, builtinTaskType('docs')!.settings.roles ?? DEFAULT_ROLES)
    assert.equal(pm.roles(PID, b.id).some((r) => r.id === 'designer'), false)
    // Роли «вживую»: смена исполнителя роли типа действует на уже созданный прогон.
    pm.patchTaskType(mine.id, { roles: [...DEFAULT_ROLES, { ...DESIGNER, model: 'opus' }] })
    assert.equal(pm.roles(PID, a.id).find((r) => r.id === 'designer')?.model, 'opus')
  })

  it('без прогона («Входящие») и неизвестный прогон — тип проекта по умолчанию', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    pm.setProjectTaskTypes(PID, { defaultTypeId: 'docs' })
    assert.equal(pm.resolveRun(PID).typeId, 'docs')
    assert.equal(pm.resolveRun(PID, 'run_ghost').source, 'default')
  })
})

describe('проект', () => {
  it('колонки остаются у проекта: задачи из исчезнувших колонок — в backlog', () => {
    const cols: BoardColumn[] = [...DEFAULT_COLUMNS, { id: 'qa', title: 'QA', color: '#fff', kind: 'custom' }]
    writeConfig({}, { columns: cols })
    const pm = new ProjectManager(tmp)
    const task = pm.store(PID).createTask({ title: 't' })
    pm.store(PID).moveTask(task.id, 'qa')
    pm.setColumns(PID, DEFAULT_COLUMNS)
    const status = pm.store(PID).getTask(task.id)?.status
    assert.ok(DEFAULT_COLUMNS.some((c) => c.id === status && (c.kind === 'backlog' || c.kind === 'ready')), String(status))
  })
})
