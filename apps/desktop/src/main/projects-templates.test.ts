// Запуск: pnpm --filter @orca-board/desktop test. Шаблоны проектов в ProjectManager: хранение в projects.json,
// миграция старого `defaults`, добавление проекта из шаблона, выборочное применение разделов.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  BUILTIN_TEMPLATES, DEFAULT_COLUMNS, DEFAULT_ROLES, GENERAL_TEMPLATE_ID, TEMPLATE_SECTIONS, builtinTemplate, defaultWorkflow,
  type BoardColumn, type Role, type Workflow
} from '@orca-board/core'
import { ProjectManager } from './projects'

const PID = 'p1'
let tmp: string

function writeConfig(extra: Record<string, unknown> = {}, project: Record<string, unknown> = {}): void {
  writeFileSync(path.join(tmp, 'projects.json'), JSON.stringify({
    projects: [{ id: PID, root: path.join(tmp, 'repo'), name: 'repo', roles: DEFAULT_ROLES, columns: DEFAULT_COLUMNS, ...project }],
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
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), text)
  }
  return dir
}

const DESIGNER: Role = { id: 'designer', title: 'Дизайнер', agent: 'claude', description: 'Макеты' }
const LEGACY_ROLES: Role[] = [...DEFAULT_ROLES, DESIGNER]
const LEGACY_COLUMNS: BoardColumn[] = [...DEFAULT_COLUMNS, { id: 'qa', title: 'QA', color: '#fff', kind: 'custom' }]

/** Дефолтный граф с гейтом QA вместо ревью — не совпадает с дефолтным, валиден при ролях по умолчанию. */
function qaWorkflow(): Workflow {
  const wf = defaultWorkflow(DEFAULT_ROLES)
  return { ...wf, nodes: wf.nodes.map((n) => (n.id === 'review' ? { id: 'review', type: 'gate', roleId: 'qa', x: n.x, y: n.y } : n)) }
}

beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'orca-tpl-')) })
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('миграция старого defaults', () => {
  const legacy = {
    permissionMode: 'acceptEdits', enabledAgents: ['claude'], roles: LEGACY_ROLES, columns: LEGACY_COLUMNS,
    agentRules: 'общие правила', workflow: qaWorkflow()
  }

  it('defaults → пользовательский «Общий» по умолчанию; после рестарта ничего не теряется', () => {
    writeConfig({ defaults: legacy, settings: { keepInBackground: false } }, { agentRules: 'свои', permissionMode: 'auto' })
    const pm = new ProjectManager(tmp)
    const before = pm.defaults()
    assert.equal(before.permissionMode, 'acceptEdits')
    assert.deepEqual(before.enabledAgents, ['claude'])
    assert.deepEqual(before.roles.map((r) => r.id), LEGACY_ROLES.map((r) => r.id))
    assert.deepEqual(before.columns, LEGACY_COLUMNS)
    assert.equal(before.agentRules, 'общие правила')
    assert.deepEqual(before.workflow, qaWorkflow())

    const state = pm.templatesState()
    assert.equal(state.defaultTemplateId, GENERAL_TEMPLATE_ID)
    const general = state.templates.filter((t) => t.id === GENERAL_TEMPLATE_ID)
    assert.equal(general.length, 1, '«Общий» один: пользовательский подменил встроенный')
    assert.equal(general[0].builtin, undefined)
    assert.equal(state.templates.length, BUILTIN_TEMPLATES.length)

    pm.setActive(PID) // любое сохранение пишет новый формат
    const file = saved()
    assert.equal(file.defaults, undefined, 'старого поля в файле больше нет')
    assert.equal(file.defaultTemplateId, GENERAL_TEMPLATE_ID)
    assert.deepEqual(file.settings, { keepInBackground: false })

    const again = new ProjectManager(tmp)
    assert.deepEqual(again.defaults(), before)
    const p = again.get(PID)!
    assert.equal(p.agentRules, 'свои')
    assert.equal(p.templateId, undefined, 'существующим проектам тип не проставляется')
    assert.equal(again.baseTemplate(PID).id, GENERAL_TEMPLATE_ID)
  })

  it('пустой или битый defaults шаблона не создаёт — «Общий» встроенный, дефолт прежний', () => {
    writeConfig({ defaults: { workflow: { nodes: 1 } } })
    const pm = new ProjectManager(tmp)
    assert.equal(pm.template(GENERAL_TEMPLATE_ID)?.builtin, true)
    const d = pm.defaults()
    assert.deepEqual(d.roles, DEFAULT_ROLES)
    assert.deepEqual(d.columns, DEFAULT_COLUMNS)
    assert.equal(d.permissionMode, 'auto')
    assert.equal(d.workflow, undefined, 'граф «Общего» совпадает с дефолтным — не копируется')
  })

  it('мусорные шаблоны и поля отбрасываются', () => {
    writeConfig({ templates: [{ id: '', title: 'x', settings: {} }, { id: 't1', title: 'Мой', builtin: true, settings: { agentRules: 5 } }, 7], defaultTemplateId: 42 })
    const pm = new ProjectManager(tmp)
    const own = pm.templates().filter((t) => !t.builtin)
    assert.deepEqual(own, [{ id: 't1', title: 'Мой', settings: {} }])
    assert.equal(pm.defaultTemplateId(), GENERAL_TEMPLATE_ID)
  })
})

describe('CRUD шаблонов', () => {
  it('встроенные только читаются; дублирование даёт редактируемую копию', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    const front = builtinTemplate('frontend')!
    assert.throws(() => pm.saveTemplate({ id: 'frontend', title: 'x', settings: {} }), /встроенный и только для чтения/)
    assert.throws(() => pm.deleteTemplate('frontend'), /только для чтения/)
    const copy = pm.duplicateTemplate('frontend')
    assert.notEqual(copy.id, 'frontend')
    assert.equal(copy.title, `${front.title} (копия)`)
    assert.equal(copy.builtin, undefined)
    assert.deepEqual(copy.settings, front.settings)
    const renamed = pm.saveTemplate({ ...copy, title: '  Мой фронт  ', settings: { ...copy.settings, permissionMode: 'bypassPermissions' } })
    assert.equal(renamed.title, 'Мой фронт')
    assert.deepEqual(new ProjectManager(tmp).template(copy.id), renamed, 'переживает перезапуск')
    assert.equal(pm.templates().at(-1)?.id, copy.id, 'пользовательские — после встроенных')
  })

  it('настройки валидируются как у проекта', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    assert.throws(() => pm.saveTemplate({ title: '', settings: {} }), /пустое название/)
    assert.throws(() => pm.saveTemplate({ title: 'T', settings: { roles: [] } }), /хотя бы одна роль/)
    assert.throws(() => pm.saveTemplate({ title: 'T', settings: { columns: DEFAULT_COLUMNS.filter((c) => c.kind !== 'backlog') } }), /backlog/)
    assert.throws(
      () => pm.saveTemplate({ title: 'T', settings: { roles: DEFAULT_ROLES.filter((r) => r.id !== 'qa'), workflow: qaWorkflow() } }),
      /qa/
    )
  })

  it('шаблон по умолчанию: установка, удаление сбрасывает на «Общий»', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    const t = pm.saveTemplate({ title: 'Мой', settings: { agentRules: 'r' } })
    assert.equal(pm.setDefaultTemplate(t.id).defaultTemplateId, t.id)
    assert.equal(pm.defaults().agentRules, 'r')
    assert.throws(() => pm.setDefaultTemplate('нет-такого'), /шаблон не найден/)
    assert.equal(pm.deleteTemplate(t.id).defaultTemplateId, GENERAL_TEMPLATE_ID)
    assert.equal(pm.template(t.id), undefined)
  })

  it('setDefaults правит копию «Общего», удаление копии возвращает встроенный', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    assert.equal(pm.setDefaults({ agentRules: 'новые' }).agentRules, 'новые')
    assert.equal(pm.template(GENERAL_TEMPLATE_ID)?.builtin, undefined)
    pm.deleteTemplate(GENERAL_TEMPLATE_ID)
    assert.equal(pm.template(GENERAL_TEMPLATE_ID)?.builtin, true)
    assert.equal(pm.defaults().agentRules, undefined)
    pm.setDefaultTemplate('backend')
    assert.throws(() => pm.setDefaults({ agentRules: 'x' }), /только для чтения/)
  })
})

describe('add и applyTemplate', () => {
  it('новый проект получает копию шаблона и его templateId; без шаблона — по умолчанию', () => {
    const pm = new ProjectManager(tmp)
    const back = builtinTemplate('backend')!
    const p = pm.add(gitRepo('api'), 'backend')
    assert.equal(p.templateId, 'backend')
    assert.deepEqual(p.roles, back.settings.roles)
    assert.deepEqual(p.workflow, back.settings.workflow)
    assert.equal(p.agentRules, back.settings.agentRules)
    const plain = pm.add(gitRepo('plain'))
    assert.equal(plain.templateId, GENERAL_TEMPLATE_ID)
    assert.equal(plain.workflow, undefined)
    assert.throws(() => pm.add(gitRepo('x'), 'нет-такого'), /шаблон не найден/)
    assert.equal(pm.add(gitRepo('api'), 'frontend').templateId, 'backend', 'уже добавленный — как есть')
  })

  it('разделы по отдельности: только правила — роли и граф не трогаются', () => {
    writeConfig({}, { agentRules: 'свои' })
    const pm = new ProjectManager(tmp)
    const p = pm.applyTemplate(PID, 'backend', ['agentRules'])
    assert.equal(p.agentRules, builtinTemplate('backend')!.settings.agentRules)
    assert.deepEqual(p.roles, DEFAULT_ROLES)
    assert.equal(p.workflow, undefined)
    assert.equal(p.templateId, undefined, 'частичное применение тип не меняет')
  })

  it('граф без нужных ролей не применяется, проект не меняется; с ролями — применяется', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    assert.throws(() => pm.applyTemplate(PID, 'fullstack', ['workflow']), /примените вместе с разделами: роли/)
    assert.equal(pm.get(PID)?.workflow, undefined)
    const p = pm.applyTemplate(PID, 'fullstack', ['roles', 'workflow'])
    assert.deepEqual(p.roles, builtinTemplate('fullstack')!.settings.roles)
    assert.deepEqual(new ProjectManager(tmp).get(PID)?.workflow, builtinTemplate('fullstack')!.settings.workflow)
  })

  it('одна роль из шаблона: заменяется на месте, остальные остаются', () => {
    writeConfig({}, { roles: [...DEFAULT_ROLES, DESIGNER] })
    const pm = new ProjectManager(tmp)
    const p = pm.applyTemplate(PID, 'backend', ['roles'], ['reviewer'])
    const tplReviewer = builtinTemplate('backend')!.settings.roles!.find((r) => r.id === 'reviewer')
    assert.deepEqual(p.roles?.find((r) => r.id === 'reviewer'), tplReviewer)
    assert.ok(p.roles?.some((r) => r.id === 'designer'))
    assert.equal(p.roles?.length, DEFAULT_ROLES.length + 1)
  })

  it('колонки — через setColumns: задачи из исчезнувших колонок уходят в backlog', () => {
    writeConfig({}, { columns: LEGACY_COLUMNS })
    const pm = new ProjectManager(tmp)
    const task = pm.store(PID).createTask({ title: 't' })
    pm.store(PID).moveTask(task.id, 'qa')
    pm.applyTemplate(PID, GENERAL_TEMPLATE_ID, ['columns'])
    assert.deepEqual(pm.get(PID)?.columns, DEFAULT_COLUMNS)
    // reassignColumn переносит в backlog, promoteReady сразу продвигает задачу без зависимостей в ready.
    const status = pm.store(PID).getTask(task.id)?.status
    assert.ok(DEFAULT_COLUMNS.some((c) => c.id === status && (c.kind === 'backlog' || c.kind === 'ready')), String(status))
  })

  it('все разделы — смена типа: templateId меняется; applyDefaults — то же с шаблоном по умолчанию', () => {
    writeConfig({}, { templateId: 'удалённый' })
    const pm = new ProjectManager(tmp)
    assert.equal(pm.baseTemplate(PID).id, GENERAL_TEMPLATE_ID, 'висячий templateId — база шаблон по умолчанию')
    assert.equal(pm.applyTemplate(PID, 'docs', [...TEMPLATE_SECTIONS]).templateId, 'docs')
    assert.equal(pm.baseTemplate(PID).id, 'docs')
    pm.setDefaultTemplate('backend')
    const p = pm.applyDefaults(PID)
    assert.equal(p.templateId, 'backend')
    assert.deepEqual(p.roles, builtinTemplate('backend')!.settings.roles)
  })

  it('неизвестный раздел и пустой список — ошибка', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    assert.throws(() => pm.applyTemplate(PID, 'backend', []), /ни один раздел/)
    assert.throws(() => pm.applyTemplate(PID, 'backend', ['мусор' as never]), /неизвестный раздел/)
  })

  it('detectTemplate: угаданный встроенный, без признаков — шаблон по умолчанию', () => {
    const pm = new ProjectManager(tmp)
    const front = gitRepo('front', { 'package.json': JSON.stringify({ dependencies: { react: '^18' } }) })
    assert.deepEqual(pm.detectTemplate(front), { path: front, templateId: 'frontend', reason: 'package.json: react' })
    const empty = gitRepo('empty')
    const t = pm.saveTemplate({ title: 'Мой', settings: {} })
    pm.setDefaultTemplate(t.id)
    assert.deepEqual(pm.detectTemplate(empty), { path: empty, templateId: t.id, reason: '' })
  })
})
