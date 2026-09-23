// Запуск: pnpm --filter @orca-board/desktop test. Воркфлоу проекта: хранение в projects.json (ProjectManager),
// дефолт по ролям, валидация при сохранении, миграция и будущая версия формата при загрузке.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_ROLES, WORKFLOW_VERSION, defaultWorkflow, type Workflow } from '@orca-board/core'
import { ProjectManager } from './projects'

const PID = 'p1'
let tmp: string

function writeConfig(project: Record<string, unknown> = {}, defaults?: Record<string, unknown>): void {
  writeFileSync(path.join(tmp, 'projects.json'), JSON.stringify({
    projects: [{ id: PID, root: path.join(tmp, 'repo'), name: 'repo', roles: DEFAULT_ROLES, ...project }],
    activeId: PID,
    ...(defaults ? { defaults } : {})
  }))
}

function saved(): { projects: Array<{ workflow?: Workflow }>; defaults?: { workflow?: Workflow } } {
  return JSON.parse(readFileSync(path.join(tmp, 'projects.json'), 'utf8'))
}

/** Дефолтный граф с гейтом QA вместо ревью — валиден при ролях по умолчанию. */
function qaWorkflow(): Workflow {
  const wf = defaultWorkflow(DEFAULT_ROLES)
  return { ...wf, nodes: wf.nodes.map((n) => (n.id === 'review' ? { id: 'review', type: 'gate', roleId: 'qa', x: n.x, y: n.y } : n)) }
}

beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'orca-wf-')) })
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('ProjectManager.workflow', () => {
  it('не задан — дефолтный по ролям проекта: есть reviewer — гейт, нет — человек', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    assert.deepEqual(pm.workflow(PID), defaultWorkflow(DEFAULT_ROLES))
    pm.setRoles(PID, DEFAULT_ROLES.filter((r) => r.id !== 'reviewer'))
    assert.equal(pm.workflow(PID).nodes.find((n) => n.id === 'review')?.type, 'human')
    assert.equal(pm.get(PID)?.workflow, undefined, 'дефолт не записывается в проект')
  })

  it('setWorkflow сохраняет валидный граф, null возвращает дефолтный', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    const wf = qaWorkflow()
    assert.deepEqual(pm.setWorkflow(PID, wf).workflow, wf)
    assert.deepEqual(new ProjectManager(tmp).workflow(PID), wf, 'переживает перезапуск')
    assert.equal(pm.setWorkflow(PID, null).workflow, undefined)
    assert.equal(saved().projects[0].workflow, undefined)
    assert.deepEqual(pm.workflow(PID), defaultWorkflow(DEFAULT_ROLES))
  })

  it('граф с ошибками validateWorkflow не сохраняется, текст ошибки — в исключении', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    const wf = defaultWorkflow(DEFAULT_ROLES)
    const noReject = { ...wf, edges: wf.edges.filter((e) => e.id !== 'e_review_reject') }
    assert.throws(() => pm.setWorkflow(PID, noReject), /воркфлоу не сохранён: .*нет перехода для reject/)
    const ghostRole = { ...wf, nodes: wf.nodes.map((n) => (n.id === 'review' ? { ...n, roleId: 'ghost' } : n)) }
    assert.throws(() => pm.setWorkflow(PID, ghostRole), /ghost/)
    assert.equal(pm.get(PID)?.workflow, undefined)
  })

  it('мусор вместо графа — понятная ошибка, а не падение валидатора', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    for (const bad of [42, 'wf', [], { version: 1 }, { version: 1, nodes: [1], edges: [] },
      { version: 1, nodes: [{ id: 's', type: 'start' }], edges: [] }, { version: 1, nodes: [], edges: [{ id: 'e' }] }]) {
      assert.throws(() => pm.setWorkflow(PID, bad as unknown as Workflow), /^Error: воркфлоу/, JSON.stringify(bad))
    }
  })

  it('будущая версия при сохранении отвергается', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    assert.throws(() => pm.setWorkflow(PID, { ...qaWorkflow(), version: WORKFLOW_VERSION + 1 }), /обновите приложение/)
  })
})

describe('загрузка projects.json', () => {
  it('будущая версия остаётся как есть, workflow(id) — ошибка «обновите приложение»', () => {
    const future = { ...qaWorkflow(), version: WORKFLOW_VERSION + 1, extra: 'поле новой версии' }
    writeConfig({ workflow: future })
    const pm = new ProjectManager(tmp)
    assert.deepEqual(pm.get(PID)?.workflow, future)
    assert.throws(() => pm.workflow(PID), /обновите приложение/)
    pm.setPermissionMode(PID, 'auto')
    assert.deepEqual(saved().projects[0].workflow, future, 'сохранение проекта граф не портит')
  })

  it('старая версия мигрируется до текущей', () => {
    writeConfig({ workflow: { ...qaWorkflow(), version: 0 } })
    assert.equal(new ProjectManager(tmp).workflow(PID).version, WORKFLOW_VERSION)
  })

  it('битый граф отбрасывается — читается дефолтный', () => {
    writeConfig({ workflow: 'мусор' }, { workflow: { nodes: 1 } })
    const pm = new ProjectManager(tmp)
    assert.equal(pm.get(PID)?.workflow, undefined)
    assert.deepEqual(pm.workflow(PID), defaultWorkflow(DEFAULT_ROLES))
    assert.equal(pm.defaults().workflow, undefined)
  })
})

describe('воркфлоу в дефолте проектов', () => {
  it('setDefaults проверяет граф, applyDefaults копирует его в проект, null удаляет', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    const wf = qaWorkflow()
    const bad = { ...wf, nodes: wf.nodes.filter((n) => n.type !== 'end') }
    assert.throws(() => pm.setDefaults({ workflow: bad }), /нет ноды «Конец»/)
    assert.deepEqual(pm.setDefaults({ workflow: wf }).workflow, wf)
    assert.deepEqual(pm.applyDefaults(PID).workflow, wf)
    assert.equal(pm.setDefaults({ workflow: null as unknown as Workflow }).workflow, undefined)
    assert.equal(pm.applyDefaults(PID).workflow, undefined)
  })

  it('граф дефолта проверяется по ролям из того же патча', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    assert.throws(() => pm.setDefaults({ roles: DEFAULT_ROLES.filter((r) => r.id !== 'qa'), workflow: qaWorkflow() }), /qa/)
  })
})
