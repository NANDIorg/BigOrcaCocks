// Запуск: pnpm --filter @orca-board/desktop test. Сквозные сценарии «типов проектов» на ProjectManager с настоящими
// projects.json и досками на диске: рестарт = новый ProjectManager на той же папке. Юнит-проверки отдельных
// методов — в projects-templates.test.ts, встроенных шаблонов самих по себе — в core/templates.test.ts.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  BUILTIN_TEMPLATES, DEFAULT_COLUMNS, DEFAULT_ROLES, GENERAL_TEMPLATE_ID, SYSTEM_COLUMN_KINDS, TEMPLATE_SECTIONS,
  builtinTemplate, defaultWorkflow, sectionsDiff, startStage, validateWorkflow,
  type BoardColumn, type Role, type TemplateSection, type Workflow
} from '@orca-board/core'
import { ProjectManager, type Project } from './projects'

let tmp: string

beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'orca-tpl-e2e-')) })
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function gitRepo(name: string): string {
  const dir = path.join(tmp, name)
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

function saved(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(tmp, 'projects.json'), 'utf8')) as Record<string, unknown>
}

/** Отвязанная копия проекта — сравнивать состояние до и после рестарта. */
function snapshot(p: Project | undefined): Project | undefined {
  return p && (JSON.parse(JSON.stringify(p)) as Project)
}

const DESIGNER: Role = { id: 'designer', title: 'Дизайнер', agent: 'claude', description: 'Макеты' }
const QA_COLUMN: BoardColumn = { id: 'qa', title: 'QA', color: '#fff', kind: 'custom' }

/** Граф с гейтом дизайнера, который кладёт задачу в колонку QA: зависит и от роли, и от колонки. */
function designWorkflow(): Workflow {
  const wf = defaultWorkflow(DEFAULT_ROLES)
  return {
    ...wf,
    nodes: wf.nodes.map((n) => (n.id === 'review' ? { id: 'review', type: 'gate', roleId: 'designer', column: 'qa', x: n.x, y: n.y } : n))
  }
}

/** Все настройки проекта, которые трогает шаблон. */
function sectionsOf(p: Project): Record<TemplateSection, unknown> {
  return {
    agents: p.enabledAgents, roles: p.roles, columns: p.columns,
    permissions: p.permissionMode, agentRules: p.agentRules, workflow: p.workflow
  }
}

describe('миграция старого projects.json и рестарты', () => {
  it('defaults → «Общий»; проекты, доски и настройки переживают несколько рестартов', () => {
    const root = gitRepo('repo')
    const legacyDefaults = {
      permissionMode: 'bypassPermissions', enabledAgents: ['claude'],
      roles: [...DEFAULT_ROLES, DESIGNER], columns: [...DEFAULT_COLUMNS, QA_COLUMN],
      agentRules: 'правила из старого дефолта', workflow: designWorkflow()
    }
    const legacyProject = { id: 'p1', root, name: 'repo', permissionMode: 'auto', agentRules: 'свои правила', roles: DEFAULT_ROLES, columns: DEFAULT_COLUMNS }
    writeFileSync(path.join(tmp, 'projects.json'), JSON.stringify({ projects: [legacyProject], activeId: 'p1', defaults: legacyDefaults }))

    // Доска старого проекта заводится до миграции — миграция не должна её трогать.
    const first = new ProjectManager(tmp)
    const task = first.store('p1').createTask({ title: 'старая задача', roleId: 'developer' })
    const projectBefore = snapshot(first.get('p1'))

    // Новый проект после миграции получает бывший дефолт — как раньше.
    const added = first.add(gitRepo('new'))
    assert.equal(added.templateId, GENERAL_TEMPLATE_ID)
    assert.equal(added.permissionMode, 'bypassPermissions')
    assert.deepEqual(added.enabledAgents, ['claude'])
    assert.deepEqual(added.roles?.map((r) => r.id), legacyDefaults.roles.map((r) => r.id))
    assert.deepEqual(added.columns, legacyDefaults.columns)
    assert.equal(added.agentRules, 'правила из старого дефолта')
    assert.deepEqual(added.workflow, designWorkflow())

    const file = saved()
    assert.equal(file.defaults, undefined)
    assert.equal(file.defaultTemplateId, GENERAL_TEMPLATE_ID)

    for (let i = 0; i < 3; i++) {
      const pm = new ProjectManager(tmp)
      assert.deepEqual(snapshot(pm.get('p1')), projectBefore, `рестарт ${i + 1}: старый проект не изменился`)
      assert.deepEqual(snapshot(pm.get(added.id)), snapshot(added), `рестарт ${i + 1}: новый проект не изменился`)
      assert.equal(pm.store('p1').getTask(task.id)?.title, 'старая задача', `рестарт ${i + 1}: доска на месте`)
      assert.equal(pm.defaultTemplateId(), GENERAL_TEMPLATE_ID)
      assert.equal(pm.templates().filter((t) => t.id === GENERAL_TEMPLATE_ID).length, 1)
      assert.deepEqual(pm.defaults().columns, legacyDefaults.columns)
      pm.setActive(i % 2 ? 'p1' : added.id) // сохранение на каждом шаге — формат устойчив к перезаписи
    }
  })

  it('старый проект без templateId сравнивается с мигрированным «Общим», как раньше с дефолтом', () => {
    const root = gitRepo('repo')
    const legacyDefaults = { roles: [...DEFAULT_ROLES, DESIGNER], agentRules: 'r' }
    const project = { id: 'p1', root, name: 'repo', roles: legacyDefaults.roles, agentRules: 'r' }
    writeFileSync(path.join(tmp, 'projects.json'), JSON.stringify({ projects: [project], activeId: 'p1', defaults: legacyDefaults }))
    const pm = new ProjectManager(tmp)
    const base = pm.baseTemplate('p1')
    assert.equal(base.id, GENERAL_TEMPLATE_ID)
    const p = pm.get('p1')!
    assert.deepEqual(sectionsDiff(p, base.settings, []), [], 'проект, совпадавший с дефолтом, совпадает с «Общим»')
  })

  it('старый defaults не затирает уже сохранённый пользовательский «Общий»', () => {
    writeFileSync(path.join(tmp, 'projects.json'), JSON.stringify({
      projects: [], activeId: null,
      defaults: { agentRules: 'старое' },
      templates: [{ id: GENERAL_TEMPLATE_ID, title: 'Общий', settings: { agentRules: 'новое' } }]
    }))
    const pm = new ProjectManager(tmp)
    assert.equal(pm.defaults().agentRules, 'новое')
  })
})

describe('добавление проекта с каждым встроенным шаблоном', () => {
  for (const tpl of BUILTIN_TEMPLATES) {
    it(`«${tpl.title}»: валидные роли, колонки и граф, задача входит в воркфлоу; переживает рестарт`, () => {
      const pm = new ProjectManager(tmp)
      const p = pm.add(gitRepo(tpl.id), tpl.id)
      assert.equal(p.templateId, tpl.id)

      const roles = pm.roles(p.id)
      const roleIds = roles.map((r) => r.id)
      assert.equal(new Set(roleIds).size, roleIds.length, 'id ролей уникальны')
      for (const service of ['coordinator', 'assistant']) assert.ok(roleIds.includes(service), `есть роль ${service}`)

      const columns = pm.columns(p.id)
      for (const kind of SYSTEM_COLUMN_KINDS) assert.equal(columns.filter((c) => c.kind === kind).length, 1, `колонка ${kind}`)

      const wf = pm.workflow(p.id)
      const v = validateWorkflow(wf, { roles, columns, enabledAgents: p.enabledAgents })
      assert.deepEqual(v.errors, [])
      for (const roleId of roleIds.filter((id) => id !== 'coordinator' && id !== 'assistant')) {
        const step = startStage(wf, { roleId, roleIds })
        assert.notEqual(step.action.type, 'blocked', `роль ${roleId}: ${JSON.stringify(step.action)}`)
      }

      // Сразу после добавления проект совпадает со своим шаблоном — в «Обзоре» нет отличий.
      assert.deepEqual(sectionsDiff(p, pm.baseTemplate(p.id).settings, []), [])

      // Задача проходит по доске нового проекта, колонки store — колонки проекта.
      const store = pm.store(p.id)
      const t = store.createTask({ title: 't', roleId: roleIds.find((id) => id !== 'coordinator' && id !== 'assistant') })
      assert.ok(columns.some((c) => c.id === store.getTask(t.id)?.status))

      const again = new ProjectManager(tmp)
      assert.deepEqual(snapshot(again.get(p.id)), snapshot(p))
      assert.equal(again.store(p.id).getTask(t.id)?.title, 't')
    })
  }

  it('изменение шаблона после добавления не доходит до проекта (копия, а не ссылка)', () => {
    const pm = new ProjectManager(tmp)
    const own = pm.saveTemplate({ title: 'Мой', settings: { roles: [...DEFAULT_ROLES, DESIGNER], agentRules: 'v1' } })
    const p = pm.add(gitRepo('repo'), own.id)
    pm.saveTemplate({ ...own, settings: { ...own.settings, agentRules: 'v2', roles: DEFAULT_ROLES } })
    const after = new ProjectManager(tmp).get(p.id)!
    assert.equal(after.agentRules, 'v1')
    assert.ok(after.roles?.some((r) => r.id === 'designer'))
  })
})

describe('applyTemplate по разделам', () => {
  /** Проект, отличный от шаблона «Бэкенд» во всех разделах. */
  function customProject(pm: ProjectManager): Project {
    const p = pm.add(gitRepo('repo'), GENERAL_TEMPLATE_ID)
    pm.setPermissionMode(p.id, 'acceptEdits')
    pm.setEnabledAgents(p.id, ['codex'])
    pm.setRoles(p.id, [...DEFAULT_ROLES, DESIGNER])
    pm.setColumns(p.id, [...DEFAULT_COLUMNS, QA_COLUMN])
    pm.setAgentRules(p.id, 'свои правила')
    return pm.get(p.id)!
  }

  // Граф отдельно: он зависит от ролей и колонок, его одиночное применение — в следующем тесте.
  for (const section of TEMPLATE_SECTIONS.filter((s) => s !== 'workflow')) {
    it(`только «${section}»: меняется этот раздел, остальные и templateId — нет`, () => {
      const pm = new ProjectManager(tmp)
      const before = sectionsOf(customProject(pm))
      const id = pm.list()[0].id
      const tpl = builtinTemplate('backend')!.settings
      const p = pm.applyTemplate(id, 'backend', [section])
      const after = sectionsOf(new ProjectManager(tmp).get(id)!)
      const expected: Record<TemplateSection, unknown> = {
        agents: tpl.enabledAgents, roles: tpl.roles, columns: tpl.columns ?? DEFAULT_COLUMNS,
        permissions: tpl.permissionMode ?? 'auto', agentRules: tpl.agentRules, workflow: tpl.workflow
      }
      for (const s of TEMPLATE_SECTIONS) {
        if (s === section) assert.deepEqual(after[s], expected[s], `раздел ${s} взят из шаблона`)
        else assert.deepEqual(after[s], before[s], `раздел ${s} не тронут`)
      }
      assert.equal(p.templateId, GENERAL_TEMPLATE_ID, 'частичное применение тип не меняет')
    })
  }

  it('одна роль: заменяется на месте, свои роли и граф остаются; роли нет в шаблоне — удаляется', () => {
    const pm = new ProjectManager(tmp)
    const p = customProject(pm)
    const rolesBefore = p.roles!
    const tplReviewer = builtinTemplate('backend')!.settings.roles!.find((r) => r.id === 'reviewer')!
    const after = pm.applyTemplate(p.id, 'backend', ['roles'], ['reviewer'])
    assert.deepEqual(after.roles?.map((r) => r.id), rolesBefore.map((r) => r.id), 'порядок и состав тот же')
    assert.deepEqual(after.roles?.find((r) => r.id === 'reviewer'), tplReviewer)
    for (const r of rolesBefore.filter((x) => x.id !== 'reviewer')) assert.deepEqual(after.roles?.find((x) => x.id === r.id), r)
    assert.equal(after.agentRules, 'свои правила')
    assert.deepEqual(after.columns, [...DEFAULT_COLUMNS, QA_COLUMN])

    // designer есть в проекте, но не в шаблоне: применение «этой роли» из шаблона её убирает.
    const without = pm.applyTemplate(p.id, 'backend', ['roles'], ['designer'])
    assert.equal(without.roles?.some((r) => r.id === 'designer'), false)
    assert.equal(without.roles?.length, rolesBefore.length - 1)
  })

  it('новая роль из шаблона добавляется в конец', () => {
    const pm = new ProjectManager(tmp)
    const p = pm.add(gitRepo('repo'), GENERAL_TEMPLATE_ID)
    const tplRoles = builtinTemplate('docs')!.settings.roles!
    const after = pm.applyTemplate(p.id, 'docs', ['roles'], ['writer'])
    assert.deepEqual(after.roles?.at(-1), tplRoles.find((r) => r.id === 'writer'))
    assert.equal(after.roles?.length, DEFAULT_ROLES.length + 1)
  })
})

describe('воркфлоу и зависимые разделы', () => {
  it('граф без нужной роли: понятная ошибка с подсказкой, проект и файл не меняются', () => {
    const pm = new ProjectManager(tmp)
    const own = pm.saveTemplate({ title: 'Дизайн', settings: { roles: [...DEFAULT_ROLES, DESIGNER], columns: [...DEFAULT_COLUMNS, QA_COLUMN], workflow: designWorkflow() } })
    const p = pm.add(gitRepo('repo'), GENERAL_TEMPLATE_ID)
    const fileBefore = readFileSync(path.join(tmp, 'projects.json'), 'utf8')

    assert.throws(() => pm.applyTemplate(p.id, own.id, ['workflow']), (e: Error) => {
      assert.match(e.message, /воркфлоу проекта ломается/)
      assert.match(e.message, /designer/)
      assert.match(e.message, /примените вместе с разделами: роли, колонки/)
      return true
    })
    assert.throws(() => pm.applyTemplate(p.id, own.id, ['workflow', 'roles']), /нет колонки «qa».*примените вместе с разделами: колонки/)
    assert.equal(readFileSync(path.join(tmp, 'projects.json'), 'utf8'), fileBefore, 'файл не переписан')
    assert.equal(pm.get(p.id)?.workflow, undefined)
    assert.deepEqual(pm.get(p.id)?.roles, DEFAULT_ROLES)

    const ok = pm.applyTemplate(p.id, own.id, ['workflow', 'roles', 'columns'])
    assert.deepEqual(ok.workflow, designWorkflow())
    assert.equal(ok.templateId, GENERAL_TEMPLATE_ID, 'не все разделы — тип прежний')
  })

  it('роли или колонки, ломающие свой граф проекта, — ошибка с подсказкой «воркфлоу»', () => {
    const pm = new ProjectManager(tmp)
    const own = pm.saveTemplate({ title: 'Дизайн', settings: { roles: [...DEFAULT_ROLES, DESIGNER], columns: [...DEFAULT_COLUMNS, QA_COLUMN], workflow: designWorkflow() } })
    const p = pm.add(gitRepo('repo'), own.id)
    assert.throws(() => pm.applyTemplate(p.id, GENERAL_TEMPLATE_ID, ['roles']), /designer.*примените вместе с разделами: воркфлоу/)
    assert.throws(() => pm.applyTemplate(p.id, GENERAL_TEMPLATE_ID, ['roles'], ['designer']), /примените вместе с разделами: воркфлоу/)
    assert.throws(() => pm.applyTemplate(p.id, GENERAL_TEMPLATE_ID, ['columns']), /qa.*примените вместе с разделами: воркфлоу/)
    assert.deepEqual(pm.get(p.id)?.columns, [...DEFAULT_COLUMNS, QA_COLUMN])
    // Разделы, не связанные с графом, применяются даже при графе, завязанном на свои роли.
    assert.equal(pm.applyTemplate(p.id, 'backend', ['agentRules']).agentRules, builtinTemplate('backend')!.settings.agentRules)
    // Вместе с графом — можно: граф «Общего» дефолтный, у проекта поле удаляется.
    const ok = pm.applyTemplate(p.id, GENERAL_TEMPLATE_ID, ['roles', 'columns', 'workflow'])
    assert.equal(ok.workflow, undefined)
  })
})

describe('колонки из шаблона: задачи из удалённых колонок', () => {
  it('задачи из исчезнувшей колонки уходят в backlog (и дальше в ready), остальные на месте; после рестарта так же', () => {
    const pm = new ProjectManager(tmp)
    const own = pm.saveTemplate({ title: 'С QA', settings: { columns: [...DEFAULT_COLUMNS, QA_COLUMN] } })
    const p = pm.add(gitRepo('repo'), own.id)
    const store = pm.store(p.id)
    const inQa = store.createTask({ title: 'в QA' })
    store.moveTask(inQa.id, 'qa')
    const dep = store.createTask({ title: 'зависимость' })
    const blocked = store.createTask({ title: 'ждёт зависимость', deps: [dep.id] })
    store.moveTask(blocked.id, 'qa')
    const done = store.createTask({ title: 'готово' })
    const doneColumn = DEFAULT_COLUMNS.find((c) => c.kind === 'done')!.id
    store.moveTask(done.id, doneColumn)

    pm.applyTemplate(p.id, GENERAL_TEMPLATE_ID, ['columns'])
    const kindOf = (id: string): string | undefined => DEFAULT_COLUMNS.find((c) => c.id === new ProjectManager(tmp).store(p.id).getTask(id)?.status)?.kind
    // Без зависимостей promoteReady сразу продвигает в ready; с незакрытой зависимостью задача остаётся в backlog.
    assert.ok(['backlog', 'ready'].includes(kindOf(inQa.id) ?? ''), kindOf(inQa.id))
    assert.equal(kindOf(blocked.id), 'backlog')
    assert.equal(kindOf(done.id), 'done')
    assert.ok(pm.store(p.id).listTasks().every((t) => DEFAULT_COLUMNS.some((c) => c.id === t.status)), 'нет задач в несуществующих колонках')
  })
})

describe('висячий templateId после удаления шаблона', () => {
  it('проект остаётся, настройки не меняются, база — шаблон по умолчанию; новый проект не получает удалённый шаблон', () => {
    const pm = new ProjectManager(tmp)
    const own = pm.saveTemplate({ title: 'Мой', settings: { agentRules: 'мои правила', roles: [...DEFAULT_ROLES, DESIGNER] } })
    pm.setDefaultTemplate(own.id)
    const p = pm.add(gitRepo('repo'))
    assert.equal(p.templateId, own.id)
    const before = snapshot(pm.get(p.id))

    const state = pm.deleteTemplate(own.id)
    assert.equal(state.defaultTemplateId, GENERAL_TEMPLATE_ID, 'удалённый дефолт сбрасывается на «Общий»')
    assert.equal(state.templates.some((t) => t.id === own.id), false)

    const again = new ProjectManager(tmp)
    assert.deepEqual(snapshot(again.get(p.id)), before, 'проект и его templateId не тронуты')
    assert.equal(again.template(own.id), undefined)
    assert.equal(again.baseTemplate(p.id).id, GENERAL_TEMPLATE_ID)
    assert.equal(again.defaultTemplateId(), GENERAL_TEMPLATE_ID)
    // В «Обзоре» проект показывает отличия от «Общего», а не падает.
    assert.ok(sectionsDiff(again.get(p.id)!, again.baseTemplate(p.id).settings, []).some((d) => d.section === 'roles'))
    assert.throws(() => again.applyTemplate(p.id, own.id, ['agentRules']), /шаблон не найден/)
    assert.equal(again.add(gitRepo('next')).templateId, GENERAL_TEMPLATE_ID)

    // «Сменить тип» лечит висячую ссылку.
    assert.equal(again.applyTemplate(p.id, 'backend', [...TEMPLATE_SECTIONS]).templateId, 'backend')
  })

  it('дубль встроенного с тем же содержимым — отдельный тип: удаление копии не трогает проекты встроенного', () => {
    const pm = new ProjectManager(tmp)
    const copy = pm.duplicateTemplate('frontend')
    const fromBuiltin = pm.add(gitRepo('a'), 'frontend')
    const fromCopy = pm.add(gitRepo('b'), copy.id)
    pm.deleteTemplate(copy.id)
    assert.equal(pm.baseTemplate(fromBuiltin.id).id, 'frontend')
    assert.equal(pm.baseTemplate(fromCopy.id).id, GENERAL_TEMPLATE_ID)
  })
})

describe('встроенные шаблоны только для чтения', () => {
  for (const tpl of BUILTIN_TEMPLATES.filter((t) => t.id !== GENERAL_TEMPLATE_ID)) {
    it(`«${tpl.title}»: ни сохранить, ни удалить; в файл не попадает`, () => {
      const pm = new ProjectManager(tmp)
      assert.throws(() => pm.saveTemplate({ id: tpl.id, title: tpl.title, settings: { agentRules: 'x' } }), /встроенный и только для чтения/)
      assert.throws(() => pm.deleteTemplate(tpl.id), /встроенный и только для чтения/)
      pm.setDefaultTemplate(tpl.id)
      assert.throws(() => pm.setDefaults({ agentRules: 'x' }), /только для чтения/)
      assert.deepEqual(pm.template(tpl.id), builtinTemplate(tpl.id))
      const file = saved()
      assert.equal(file.templates, undefined, 'встроенные в projects.json не хранятся')
      assert.equal(file.defaultTemplateId, tpl.id)
    })
  }

  it('«Общий» — встроенный, но правка дефолта делает его пользовательскую копию; копия перекрывает встроенный', () => {
    const pm = new ProjectManager(tmp)
    assert.throws(() => pm.saveTemplate({ id: GENERAL_TEMPLATE_ID, title: 'x', settings: {} }), /только для чтения/)
    pm.setDefaults({ agentRules: 'через дефолт' })
    const saved1 = pm.saveTemplate({ id: GENERAL_TEMPLATE_ID, title: 'Общий мой', settings: { agentRules: 'теперь можно' } })
    assert.equal(saved1.title, 'Общий мой')
    assert.equal(new ProjectManager(tmp).templates().filter((t) => t.id === GENERAL_TEMPLATE_ID).length, 1)
  })

  it('встроенный из файла с флагом builtin: флаг снимается, это пользовательская копия', () => {
    writeFileSync(path.join(tmp, 'projects.json'), JSON.stringify({
      projects: [], activeId: null,
      templates: [{ id: 'backend', title: 'Бэкенд свой', builtin: true, settings: { agentRules: 'свои' } }]
    }))
    const pm = new ProjectManager(tmp)
    const t = pm.template('backend')!
    assert.equal(t.builtin, undefined)
    assert.equal(t.settings.agentRules, 'свои')
    assert.equal(pm.templates().filter((x) => x.id === 'backend').length, 1)
  })
})

describe('шаблоны из файла проходят ту же проверку, что и при сохранении', () => {
  // Дефект: loadedTemplate проверяет только id/title/объект settings, роли и колонки берутся как есть.
  // Руками испорченный projects.json даёт проект без backlog, а applyTemplate успевает записать часть разделов
  // до того, как setColumns бросит ошибку.
  const brokenColumns = DEFAULT_COLUMNS.filter((c) => c.kind !== 'backlog')

  it('шаблон без колонки backlog не даёт проекту битую доску', { todo: 'дефект: loadedTemplate не валидирует роли и колонки' }, () => {
    writeFileSync(path.join(tmp, 'projects.json'), JSON.stringify({
      projects: [], activeId: null,
      templates: [{ id: 'broken', title: 'Битый', settings: { columns: brokenColumns } }]
    }))
    const pm = new ProjectManager(tmp)
    let p: Project | undefined
    try { p = pm.add(gitRepo('repo'), 'broken') } catch { /* отказ — тоже приемлемо */ }
    if (p) assert.ok(pm.columns(p.id).some((c) => c.kind === 'backlog'))
  })

  it('applyTemplate с битыми колонками шаблона не применяет остальные разделы', { todo: 'дефект: частичная запись до setColumns' }, () => {
    writeFileSync(path.join(tmp, 'projects.json'), JSON.stringify({
      projects: [], activeId: null,
      templates: [{ id: 'broken', title: 'Битый', settings: { columns: brokenColumns, agentRules: 'из битого' } }]
    }))
    const pm = new ProjectManager(tmp)
    const p = pm.add(gitRepo('repo'), GENERAL_TEMPLATE_ID)
    assert.throws(() => pm.applyTemplate(p.id, 'broken', ['agentRules', 'columns']))
    assert.equal(new ProjectManager(tmp).get(p.id)?.agentRules, undefined)
  })
})
