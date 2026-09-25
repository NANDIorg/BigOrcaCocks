// Запуск: pnpm --filter @orca-board/desktop test. Типы задач в ProjectManager: библиотека (засев заготовок один раз,
// правка и удаление любого типа, тип по умолчанию после удаления), типы проекта, тип нового прогона и роли по прогону,
// колонки проекта. Миграция — task-types-migration.test.ts.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DEFAULT_COLUMNS, DEFAULT_ROLES, GENERAL_TASK_TYPE_ID, presetTaskType, presetTaskTypes, defaultWorkflow,
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
  it('заготовки в библиотеке, затем свои; засев записывается в файл с первым сохранением', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    assert.deepEqual(pm.taskTypes().map((t) => t.id), presetTaskTypes().map((t) => t.id))
    assert.deepEqual(pm.taskTypes(), presetTaskTypes(), 'заготовки — обычные типы, без особых полей')
    const own = pm.saveTaskType({ title: '  Мой  ', description: ' одна строка ', settings: { agentRules: 'r' } })
    assert.equal(own.title, 'Мой')
    assert.equal(own.description, 'одна строка')
    assert.equal(pm.taskTypes().at(-1)?.id, own.id)
    assert.deepEqual(new ProjectManager(tmp).taskType(own.id), own, 'переживает перезапуск')
    const file = saved()
    assert.equal(file.taskTypesSeeded, true)
    assert.deepEqual((file.taskTypes as Array<{ id: string }>).map((t) => t.id), [...presetTaskTypes().map((t) => t.id), own.id])
  })

  it('нет projects.json — библиотека из заготовок, тип по умолчанию «Программирование»', () => {
    const pm = new ProjectManager(tmp)
    assert.deepEqual(pm.taskTypes(), presetTaskTypes())
    assert.equal(pm.defaultTaskTypeId(), GENERAL_TASK_TYPE_ID)
  })

  it('миграция файла без засева: правки встроенных остаются со всем содержимым, флаги старых версий снимаются', () => {
    const general = presetTaskType(GENERAL_TASK_TYPE_ID)!
    const docs = presetTaskType('docs')!
    writeConfig({ taskTypes: [
      { id: 'type_own', title: 'Свой', builtinBase: 'мусор', settings: {} },
      // Правка до полной правки встроенных: название менять было нельзя — берётся название заготовки.
      { id: GENERAL_TASK_TYPE_ID, title: 'Общий', description: 'Перенесён из «Настройки → Для новых проектов».', settings: { agentRules: 'r' } },
      // Правка с отпечатком: название — правка человека, остаётся.
      { ...docs, builtin: true, title: 'Моя документация', builtinBase: '00000000', settings: { agentRules: 'моё' } }
    ] })
    const pm = new ProjectManager(tmp)
    const ids = presetTaskTypes().map((t) => t.id)
    assert.deepEqual(pm.taskTypes().map((t) => t.id), [...ids, 'type_own'], 'заготовки в своём порядке, затем свои')
    const g = pm.taskType(GENERAL_TASK_TYPE_ID)!
    assert.equal(g.title, general.title)
    assert.equal(g.description, 'Перенесён из «Настройки → Для новых проектов».')
    assert.deepEqual(g.settings, { agentRules: 'r' }, 'содержимое правки не трогается')
    const d = pm.taskType('docs')!
    assert.equal(d.title, 'Моя документация')
    assert.deepEqual(d.settings, { agentRules: 'моё' })
    assert.deepEqual(pm.taskType('backend'), presetTaskType('backend'), 'неправленная заготовка — как в коде')
    for (const t of pm.taskTypes()) assert.deepEqual(Object.keys(t).filter((k) => k.startsWith('builtin')), [], t.id)
    // Засев однократный: переименование и удаление после миграции переживают перезапуск.
    pm.saveTaskType({ id: 'docs', title: 'Аналитика', settings: d.settings })
    pm.deleteTaskType('backend')
    const again = new ProjectManager(tmp)
    assert.equal(again.taskType('docs')?.title, 'Аналитика')
    assert.equal(again.taskType('backend'), undefined)
    assert.equal(again.taskType(GENERAL_TASK_TYPE_ID)?.title, general.title)
  })

  it('заготовка правится целиком: название, описание, роли, граф, разрешения, правила — и переживает перезапуск', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    const backend = presetTaskType('backend')!
    const roles = [...(backend.settings.roles ?? DEFAULT_ROLES).filter((r) => r.id !== 'qa'), DESIGNER]
      .map((r) => (r.id === 'developer' ? { ...r, title: 'Сеньор', description: 'Пишет всё', agent: 'codex' as const, model: 'gpt' } : r))
    const edited = pm.saveTaskType({
      id: 'backend', title: 'Мой бэкенд', description: 'своё описание',
      settings: { roles, workflow: defaultWorkflow(roles), permissionMode: 'bypassPermissions', agentRules: 'правила' }
    })
    assert.equal(pm.taskTypes().filter((t) => t.id === 'backend').length, 1)
    assert.equal(pm.taskTypes().findIndex((t) => t.id === 'backend'), presetTaskTypes().findIndex((t) => t.id === 'backend'), 'на своём месте')
    const again = new ProjectManager(tmp).taskType('backend')!
    assert.deepEqual(again, edited, 'правка переживает перезапуск')
    assert.equal(again.title, 'Мой бэкенд')
    assert.deepEqual(again.settings.roles?.map((r) => r.id), roles.map((r) => r.id))
    assert.equal(again.settings.permissionMode, 'bypassPermissions')
    const patched = pm.patchTaskType('frontend', { permissionMode: 'acceptEdits' })
    assert.equal(patched.settings.permissionMode, 'acceptEdits')
  })

  it('заготовка удаляется как любой тип и не возвращается после перезапуска', () => {
    writeConfig({}, { defaultTaskTypeId: 'docs' })
    const pm = new ProjectManager(tmp)
    pm.setDefaultTaskType('docs')
    const state = pm.deleteTaskType('docs')
    assert.equal(state.taskTypes.some((t) => t.id === 'docs'), false)
    assert.equal(state.defaultTaskTypeId, GENERAL_TASK_TYPE_ID, 'тип по умолчанию библиотеки — снова «Программирование»')
    assert.equal(pm.projectDefaultTypeId(PID), GENERAL_TASK_TYPE_ID, 'проект с удалённым типом по умолчанию — на типе библиотеки')
    const again = new ProjectManager(tmp)
    assert.equal(again.taskType('docs'), undefined, 'засев не повторяется')
    assert.equal(again.taskTypes().length, presetTaskTypes().length - 1)
    assert.throws(() => pm.deleteTaskType('docs'), /тип задачи не найден: docs/)
  })

  it('удалён «Программирование» — тип по умолчанию первый в библиотеке, новые проекты и прогоны на нём', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    assert.equal(pm.deleteTaskType(GENERAL_TASK_TYPE_ID).defaultTaskTypeId, 'frontend')
    assert.equal(pm.projectDefaultTypeId(PID), 'frontend')
    assert.equal(pm.runType(PID).typeId, 'frontend')
    assert.equal(pm.resolveRun(PID).typeId, 'frontend')
    assert.equal(pm.add(gitRepo('fresh')).defaultTaskTypeId, 'frontend')
    assert.equal(new ProjectManager(tmp).defaultTaskTypeId(), 'frontend', 'и после перезапуска')
  })

  it('последний тип удалить нельзя', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    const [last, ...rest] = pm.taskTypes()
    for (const t of rest) pm.deleteTaskType(t.id)
    assert.throws(() => pm.deleteTaskType(last.id), /последний в библиотеке/)
    assert.deepEqual(pm.taskTypes().map((t) => t.id), [last.id])
  })

  it('засеянный файл, в котором не осталось ни одного целого типа, засевается снова', () => {
    writeConfig({ taskTypesSeeded: true, taskTypes: [{ id: 'битый' }] })
    assert.deepEqual(new ProjectManager(tmp).taskTypes(), presetTaskTypes())
  })

  it('дублирование: копия под новым id, редактируется целиком', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    const copy = pm.duplicateTaskType('frontend')
    assert.notEqual(copy.id, 'frontend')
    assert.equal(copy.title, `${presetTaskType('frontend')!.title} (копия)`)
    assert.deepEqual(copy.settings, presetTaskType('frontend')!.settings)
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

  it('rules: правила и промпт роли заготовки правятся на месте', () => {
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
    assert.deepEqual(pm.roles(api.id), presetTaskType('backend')!.settings.roles ?? DEFAULT_ROLES, 'роли — из типа по умолчанию')
    assert.equal(pm.add(gitRepo('plain')).defaultTaskTypeId, GENERAL_TASK_TYPE_ID)
    assert.throws(() => pm.add(gitRepo('x'), 'нет-такого'), /тип задачи не найден/)
    assert.equal(pm.add(gitRepo('api'), 'frontend').defaultTaskTypeId, 'backend', 'уже добавленный — как есть')
  })

  it('detectTaskType: угаданная заготовка, без признаков — тип библиотеки по умолчанию', () => {
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
    assert.equal(pm.projectTaskTypes(PID).length, presetTaskTypes().length)
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
    assert.deepEqual(rb.roles, presetTaskType('docs')!.settings.roles ?? DEFAULT_ROLES)
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

describe('настройки приложения: язык', () => {
  it('не выбран — нет поля; выбранный переживает перезапуск; чужой язык — ошибка', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    assert.equal(pm.settings().language, undefined, 'первый запуск: язык берёт renderer из системы')
    assert.equal(pm.setSettings({ language: 'en' }).language, 'en')
    assert.equal(new ProjectManager(tmp).settings().language, 'en')
    assert.throws(() => pm.setSettings({ language: 'de' as 'en' }), /неизвестный язык «de»/)
    assert.equal(pm.settings().keepInBackground, true, 'остальные настройки не задеты')
  })
})
