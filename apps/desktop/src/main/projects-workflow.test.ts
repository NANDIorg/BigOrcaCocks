// Запуск: pnpm --filter @orca-board/desktop test. Воркфлоу типа задачи: хранение в projects.json (ProjectManager),
// дефолт по ролям типа, валидация при сохранении, миграция графа проекта в его тип и будущая версия формата.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_ROLES, WORKFLOW_VERSION, defaultWorkflow, type TaskType, type Workflow } from '@orca-board/core'
import { ProjectManager } from './projects'

const PID = 'p1'
/** Тип, в который миграция перенесла настройки проекта `PID`. */
const TID = `type_${PID}`
let tmp: string

function writeConfig(project: Record<string, unknown> = {}, defaults?: Record<string, unknown>): void {
  writeFileSync(path.join(tmp, 'projects.json'), JSON.stringify({
    projects: [{ id: PID, root: path.join(tmp, 'repo'), name: 'repo', roles: DEFAULT_ROLES, ...project }],
    activeId: PID,
    ...(defaults ? { defaults } : {})
  }))
}

function saved(): { projects: Array<Record<string, unknown>>; taskTypes?: TaskType[] } {
  return JSON.parse(readFileSync(path.join(tmp, 'projects.json'), 'utf8'))
}

function savedType(id: string): TaskType | undefined {
  return saved().taskTypes?.find((t) => t.id === id)
}

/** Дефолтный граф с гейтом QA вместо ревью — валиден при ролях по умолчанию. */
function qaWorkflow(): Workflow {
  const wf = defaultWorkflow(DEFAULT_ROLES)
  return { ...wf, nodes: wf.nodes.map((n) => (n.id === 'review' ? { id: 'review', type: 'gate', roleId: 'qa', x: n.x, y: n.y } : n)) }
}

/** Граф типа проекта `PID` по умолчанию (тип «repo», в который миграция перенесла настройки проекта). */
function projectWorkflow(pm: ProjectManager): Workflow {
  return pm.taskTypeWorkflow(pm.projectDefaultTypeId(PID)).workflow
}

/** Сохранить граф в тип проекта `PID` по умолчанию; null — вернуть дефолтный. Возвращает свой граф типа. */
function saveWorkflow(pm: ProjectManager, wf: Workflow | null): Workflow | undefined {
  return pm.patchTaskType(pm.projectDefaultTypeId(PID), { workflow: wf }).settings.workflow
}

beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'orca-wf-')) })
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('воркфлоу типа задачи', () => {
  it('граф проекта без своего графа фиксируется в его типе дефолтным: смена ролей его не двигает', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    assert.deepEqual(projectWorkflow(pm), defaultWorkflow(DEFAULT_ROLES))
    assert.equal(pm.taskTypeWorkflow(TID).custom, true, 'граф записан в тип')
    pm.patchTaskType(TID, { roles: DEFAULT_ROLES.filter((r) => r.id !== 'reviewer') })
    assert.equal(projectWorkflow(pm).nodes.find((n) => n.id === 'review')?.type, 'gate')
  })

  it('тип без своего графа — дефолтный по ролям типа: есть reviewer — гейт, нет — человек', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    const t = pm.saveTaskType({ title: 'Без ревьюера', settings: { roles: DEFAULT_ROLES.filter((r) => r.id !== 'reviewer') } })
    const wf = pm.taskTypeWorkflow(t.id)
    assert.equal(wf.custom, false)
    assert.equal(wf.workflow.nodes.find((n) => n.id === 'review')?.type, 'human')
    assert.equal(savedType(t.id)?.settings.workflow, undefined, 'дефолт не записывается в тип')
  })

  it('граф сохраняется в тип проекта по умолчанию, null возвращает дефолтный', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    const wf = qaWorkflow()
    assert.deepEqual(saveWorkflow(pm, wf), wf)
    assert.deepEqual(projectWorkflow(new ProjectManager(tmp)), wf, 'переживает перезапуск')
    assert.equal(saveWorkflow(pm, null), undefined)
    assert.equal(savedType(TID)?.settings.workflow, undefined)
    assert.equal('workflow' in saved().projects[0], false, 'в проекте графа нет')
    assert.deepEqual(projectWorkflow(pm), defaultWorkflow(DEFAULT_ROLES))
  })

  it('граф с ошибками validateWorkflow не сохраняется, текст ошибки — в исключении', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    const wf = defaultWorkflow(DEFAULT_ROLES)
    const noReject = { ...wf, edges: wf.edges.filter((e) => e.id !== 'e_review_reject') }
    assert.throws(() => saveWorkflow(pm, noReject), /воркфлоу не сохранён: .*нет перехода для reject/)
    const ghostRole = { ...wf, nodes: wf.nodes.map((n) => (n.id === 'review' ? { ...n, roleId: 'ghost' } : n)) }
    assert.throws(() => saveWorkflow(pm, ghostRole), /ghost/)
    assert.deepEqual(projectWorkflow(pm), wf)
  })

  it('мусор вместо графа — понятная ошибка, а не падение валидатора', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    for (const bad of [42, 'wf', [], { version: 1 }, { version: 1, nodes: [1], edges: [] },
      { version: 1, nodes: [{ id: 's', type: 'start' }], edges: [] }, { version: 1, nodes: [], edges: [{ id: 'e' }] }]) {
      assert.throws(() => saveWorkflow(pm, bad as unknown as Workflow), /^Error: воркфлоу/, JSON.stringify(bad))
    }
  })

  it('каждый вид битого графа отвергается, сохранённый граф и projects.json не меняются', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    const good = qaWorkflow()
    saveWorkflow(pm, good)
    const before = readFileSync(path.join(tmp, 'projects.json'), 'utf8')
    const edit = (f: (wf: Workflow) => void): Workflow => {
      const wf = JSON.parse(JSON.stringify(defaultWorkflow(DEFAULT_ROLES))) as Workflow
      f(wf)
      return wf
    }
    const node = (wf: Workflow, id: string) => wf.nodes.find((n) => n.id === id)!
    const cases: Array<[string, Workflow, RegExp]> = [
      ['дубль id ноды', edit((wf) => { wf.nodes.push({ ...node(wf, 'merge') }) }), /id «merge» уже занят/],
      ['ребро в пустоту', edit((wf) => { wf.edges.find((e) => e.id === 'e_merge_ok')!.to = 'ghost' }), /несуществующую ноду «ghost»/],
      ['нет старта', edit((wf) => { wf.nodes = wf.nodes.filter((n) => n.type !== 'start'); wf.edges = wf.edges.filter((e) => e.from !== 'start') }), /нет ноды «Старт»/],
      ['вход в старт', edit((wf) => { wf.edges.find((e) => e.id === 'e_review_reject')!.to = 'start' }), /в старт не может вести переход/],
      ['нет конца', edit((wf) => { wf.nodes = wf.nodes.filter((n) => n.type !== 'end'); wf.edges = wf.edges.filter((e) => e.to !== 'end') }), /нет ноды «Конец»/],
      ['порт без перехода', edit((wf) => { wf.edges = wf.edges.filter((e) => e.id !== 'e_merge_conflict') }), /нет перехода для conflict/],
      ['два перехода на порт', edit((wf) => { wf.edges.push({ id: 'dup', from: 'work', outcome: 'next', to: 'merge' }) }), /больше одного перехода для next/],
      ['выход из конца', edit((wf) => { wf.edges.push({ id: 'x', from: 'end', outcome: 'next', to: 'work' }) }), /из конца переходов быть не может/],
      ['тупик', edit((wf) => { wf.edges.find((e) => e.id === 'e_merge_ok')!.to = 'conflict' }), /нет пути к концу/],
      ['цикл из условий', edit((wf) => {
        wf.nodes.push({ id: 'c1', type: 'condition', test: { kind: 'role', roleIds: ['developer'] }, x: 0, y: 0 },
          { id: 'c2', type: 'condition', test: { kind: 'role', roleIds: ['qa'] }, x: 0, y: 0 })
        wf.edges.find((e) => e.id === 'e_review_reject')!.to = 'c1'
        wf.edges.push({ id: 'c1y', from: 'c1', outcome: 'yes', to: 'work' }, { id: 'c1n', from: 'c1', outcome: 'no', to: 'c2' },
          { id: 'c2y', from: 'c2', outcome: 'yes', to: 'end' }, { id: 'c2n', from: 'c2', outcome: 'no', to: 'c1' })
      }), /цикл из одних условий/],
      ['роли гейта нет', edit((wf) => { Object.assign(node(wf, 'review'), { roleId: 'ghost' }) }), /нет роли «ghost»/],
      ['служебная роль гейта', edit((wf) => { Object.assign(node(wf, 'review'), { roleId: 'coordinator' }) }), /служебная/],
      ['attempts на чужую ноду', edit((wf) => {
        wf.nodes.push({ id: 'lim', type: 'condition', test: { kind: 'attempts', node: 'ghost', atLeast: 3 }, x: 0, y: 0 })
        wf.edges.find((e) => e.id === 'e_review_reject')!.to = 'lim'
        wf.edges.push({ id: 'ly', from: 'lim', outcome: 'yes', to: 'conflict' }, { id: 'ln', from: 'lim', outcome: 'no', to: 'work' })
      }), /несуществующую ноду «ghost»/],
      ['нет работы', edit((wf) => {
        wf.nodes = wf.nodes.filter((n) => n.type !== 'work')
        wf.edges = wf.edges.filter((e) => e.from !== 'work').map((e) => (e.to === 'work' ? { ...e, to: 'review' } : e))
      }), /ни одна нода «Работа»/]
    ]
    for (const [name, wf, re] of cases) {
      assert.throws(() => saveWorkflow(pm, wf), (e: Error) => /^воркфлоу не сохранён: /.test(e.message) && re.test(e.message), name)
    }
    assert.deepEqual(projectWorkflow(pm), good)
    assert.equal(readFileSync(path.join(tmp, 'projects.json'), 'utf8'), before)
  })

  it('колонка ноды по доске не проверяется: тип общий для проектов с разными колонками', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    const wf = defaultWorkflow(DEFAULT_ROLES)
    const withColumn = { ...wf, nodes: wf.nodes.map((n) => (n.id === 'conflict' ? { ...n, column: 'nope' } : n)) }
    assert.deepEqual(saveWorkflow(pm, withColumn), withColumn)
  })

  it('предупреждения сохранению не мешают: агент роли гейта выключен', () => {
    writeConfig({ enabledAgents: ['codex'] })
    const pm = new ProjectManager(tmp)
    assert.deepEqual(saveWorkflow(pm, qaWorkflow()), qaWorkflow())
  })

  it('будущая версия при сохранении отвергается', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    assert.throws(() => saveWorkflow(pm, { ...qaWorkflow(), version: WORKFLOW_VERSION + 1 }), /обновите приложение/)
  })

  it('встроенный тип: граф меняется на месте и так же проверяется по ролям; сброс возвращает системный', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    const system = pm.taskTypeWorkflow('general').workflow
    pm.patchTaskType('general', { workflow: qaWorkflow() })
    assert.deepEqual(savedType('general')?.settings.workflow, qaWorkflow())
    assert.equal(pm.taskTypeWorkflow('general').custom, true)
    assert.throws(() => pm.patchTaskType('general', { roles: DEFAULT_ROLES.filter((r) => r.id !== 'qa'), workflow: qaWorkflow() }), /воркфлоу не сохранён/)
    pm.deleteTaskType('general')
    assert.deepEqual(pm.taskTypeWorkflow('general').workflow, system)
  })
})

describe('загрузка projects.json', () => {
  it('будущая версия переезжает в тип как есть, taskTypeWorkflow — ошибка; правка типа граф не портит', () => {
    const future = { ...qaWorkflow(), version: WORKFLOW_VERSION + 1, extra: 'поле новой версии' }
    writeConfig({ workflow: future })
    const pm = new ProjectManager(tmp)
    assert.deepEqual(savedType(TID)?.settings.workflow, future)
    assert.throws(() => projectWorkflow(pm), /обновите приложение/)
    pm.patchTaskType(TID, { permissionMode: 'acceptEdits' })
    pm.patchTaskType(TID, { agentRules: 'правила' })
    assert.deepEqual(savedType(TID)?.settings.workflow, future, 'сохранение типа граф не портит')
    assert.equal(pm.runType(PID).workflow, undefined, 'в снимок прогона будущий граф не попадает')
  })

  it('старая версия мигрируется до текущей', () => {
    writeConfig({ workflow: { ...qaWorkflow(), version: 0 } })
    assert.equal(projectWorkflow(new ProjectManager(tmp)).version, WORKFLOW_VERSION)
  })

  it('битый граф отбрасывается — в типе фиксируется дефолтный', () => {
    writeConfig({ workflow: 'мусор' }, { workflow: { nodes: 1 } })
    const pm = new ProjectManager(tmp)
    assert.deepEqual(projectWorkflow(pm), defaultWorkflow(DEFAULT_ROLES))
    assert.equal(pm.taskTypeWorkflow('general').custom, false, 'битый граф старого defaults тоже отброшен')
  })
})

describe('граф и роли в одном патче типа', () => {
  it('граф проверяется по ролям из того же патча', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    assert.throws(() => pm.patchTaskType(TID, { roles: DEFAULT_ROLES.filter((r) => r.id !== 'qa'), workflow: qaWorkflow() }), /qa/)
    const roles = DEFAULT_ROLES.filter((r) => r.id !== 'reviewer')
    const t = pm.patchTaskType(TID, { roles, workflow: qaWorkflow() })
    assert.deepEqual(t.settings.workflow, qaWorkflow())
  })
})
