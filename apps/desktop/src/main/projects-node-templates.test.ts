// Запуск: pnpm --filter @orca-board/desktop test. Библиотека шаблонов нод в ProjectManager: загрузка без доверия к
// данным (битые записи пропускаются с предупреждением), сохранение с валидацией, удаление, работа с файлом.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_COLUMNS, defaultSubflow, type WfNodeTemplate, type WfTemplateNode } from '@orca-board/core'
import { ProjectManager } from './projects'
import { PROJECTS_FILE_VERSION } from './task-types-migration'
import { OrcaError } from './i18n'
import type { NodeTemplateInput } from '../shared/ipc'

let tmp: string

function writeConfig(extra: Record<string, unknown> = {}): void {
  writeFileSync(path.join(tmp, 'projects.json'), JSON.stringify({
    version: PROJECTS_FILE_VERSION,
    projects: [{ id: 'p1', root: path.join(tmp, 'repo'), name: 'repo', columns: DEFAULT_COLUMNS }],
    activeId: 'p1',
    ...extra
  }))
}

function saved(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(tmp, 'projects.json'), 'utf8')) as Record<string, unknown>
}

function throwsOrca(fn: () => unknown, key: string): OrcaError {
  let err: unknown
  assert.throws(fn, (e: unknown) => { err = e; return e instanceof OrcaError && e.key === key })
  return err as OrcaError
}

const work = (extra: Record<string, unknown> = {}): WfTemplateNode => ({ type: 'work', roleIds: ['developer'], instructions: 'делай', ...extra }) as WfTemplateNode
const input = (extra: Partial<NodeTemplateInput> = {}): NodeTemplateInput => ({ title: 'Разработка', node: work(), ...extra })
const stored = (id: string, node: unknown = { type: 'merge' }, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ id, title: `Шаблон ${id}`, node, updatedAt: 1, ...extra })

beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'orca-node-templates-')) })
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('загрузка', () => {
  it('нет файла и файл без ключа nodeTemplates: библиотека пуста, ключ в файл не пишется', () => {
    assert.deepEqual(new ProjectManager(tmp).nodeTemplates(), [])
    rmSync(path.join(tmp, 'projects.json'), { force: true })
    writeConfig()
    const pm = new ProjectManager(tmp)
    assert.deepEqual(pm.nodeTemplates(), [])
    pm.markRun('1.0.0')
    assert.equal('nodeTemplates' in saved(), false)
    assert.deepEqual(pm.stateWarnings(), [])
  })

  it('годные шаблоны читаются в порядке файла; лишние id/x/y у ноды снимаются', () => {
    writeConfig({ nodeTemplates: [stored('a', { type: 'merge', id: 'n1', x: 5, y: 6 }), stored('b', { type: 'human', instructions: 'проверь' }, { description: 'описание' })] })
    const pm = new ProjectManager(tmp)
    assert.deepEqual(pm.nodeTemplates().map((t) => t.id), ['a', 'b'])
    assert.deepEqual(pm.nodeTemplates()[0].node, { type: 'merge' })
    assert.equal(pm.nodeTemplates()[1].description, 'описание')
    assert.deepEqual(pm.stateWarnings(), [])
  })

  it('битые записи пропускаются с предупреждением, остальные остаются', () => {
    writeConfig({
      nodeTemplates: [
        stored('ok'),
        5,
        null,
        [],
        { title: 'без id', node: { type: 'merge' }, updatedAt: 1 },
        stored('bad-type', { type: 'нет_такого' }),
        stored('start', { type: 'start' }),
        stored('no-node', null),
        stored('bad-time', { type: 'merge' }, { updatedAt: 'вчера' }),
        stored('bad-role', { type: 'gate', roleId: 'coordinator' }),
        stored('ok'),
        stored('ok2', { type: 'work', subflow: defaultSubflow() })
      ]
    })
    const pm = new ProjectManager(tmp)
    assert.deepEqual(pm.nodeTemplates().map((t) => t.id), ['ok', 'ok2'])
    const warnings = pm.stateWarnings()
    assert.equal(warnings.length, 10)
    assert.ok(warnings.every((w) => w.kind === 'skipped' && w.movedTo === undefined))
    assert.match(warnings[0].message, /№2.*ожидается объект/)
    assert.match(warnings[3].message, /№5.*пустой id/)
    assert.match(warnings[9].message, /№11.*повторный id «ok»/)
  })

  it('не массив — библиотека пуста, предупреждение; файл проекта не страдает', () => {
    writeConfig({ nodeTemplates: { a: 1 } })
    const pm = new ProjectManager(tmp)
    assert.deepEqual(pm.nodeTemplates(), [])
    assert.equal(pm.stateWarnings().length, 1)
    assert.match(pm.stateWarnings()[0].message, /ожидается массив/)
    assert.equal(pm.list().length, 1)
  })

  it('шаблоны переживают миграцию файла до типов задач', () => {
    writeFileSync(path.join(tmp, 'projects.json'), JSON.stringify({
      projects: [{ id: 'p1', root: path.join(tmp, 'p1'), name: 'p1' }], activeId: 'p1', nodeTemplates: [stored('a')]
    }))
    assert.deepEqual(new ProjectManager(tmp).nodeTemplates().map((t) => t.id), ['a'])
  })
})

describe('сохранение', () => {
  it('без id создаёт шаблон: свой id, название обрезано, updatedAt от main; файл содержит шаблон', () => {
    const pm = new ProjectManager(tmp)
    const before = Date.now()
    const t = pm.saveNodeTemplate(input({ title: '  Разработка  ', description: ' описание ' }))
    assert.match(t.id, /^tpl_[0-9a-f]{8}$/)
    assert.equal(t.title, 'Разработка')
    assert.equal(t.description, 'описание')
    assert.ok(t.updatedAt >= before)
    assert.deepEqual(saved().nodeTemplates, [t])
    assert.deepEqual(new ProjectManager(tmp).nodeTemplates(), [t])
  })

  it('пустое описание не пишется; id/x/y ноды снимаются; путь подзадачи сохраняется', () => {
    const pm = new ProjectManager(tmp)
    const node = work({ id: 'n1', x: 10, y: 20, subflow: defaultSubflow() })
    const t = pm.saveNodeTemplate(input({ description: '   ', node }))
    assert.equal('description' in t, false)
    assert.equal('id' in t.node, false)
    assert.equal('x' in t.node, false)
    assert.deepEqual((t.node as { subflow?: unknown }).subflow, defaultSubflow())
  })

  it('существующий id заменяет шаблон на месте (порядок сохраняется), обновляя updatedAt', () => {
    writeConfig({ nodeTemplates: [stored('a'), stored('b')] })
    const pm = new ProjectManager(tmp)
    const t = pm.saveNodeTemplate({ id: 'a', title: 'Новое имя', node: { type: 'human' } as WfTemplateNode })
    assert.deepEqual(pm.nodeTemplates().map((x) => x.id), ['a', 'b'])
    assert.equal(pm.nodeTemplates()[0].title, 'Новое имя')
    assert.deepEqual(pm.nodeTemplates()[0].node, { type: 'human' })
    assert.ok(t.updatedAt > 1)
  })

  it('заданный, но неизвестный id — создаёт шаблон с этим id', () => {
    const pm = new ProjectManager(tmp)
    assert.equal(pm.saveNodeTemplate(input({ id: 'mine' })).id, 'mine')
  })

  it('ошибки формы — OrcaError с ключом, файл не меняется', () => {
    writeConfig({ nodeTemplates: [stored('a')] })
    const pm = new ProjectManager(tmp)
    const before = readFileSync(path.join(tmp, 'projects.json'), 'utf8')
    throwsOrca(() => pm.saveNodeTemplate(5 as unknown as NodeTemplateInput), 'nodeTemplate.notObject')
    throwsOrca(() => pm.saveNodeTemplate(input({ id: ' ' })), 'nodeTemplate.emptyId')
    throwsOrca(() => pm.saveNodeTemplate(input({ title: '  ' })), 'nodeTemplate.emptyTitle')
    throwsOrca(() => pm.saveNodeTemplate({ node: work() } as unknown as NodeTemplateInput), 'nodeTemplate.emptyTitle')
    assert.equal(readFileSync(path.join(tmp, 'projects.json'), 'utf8'), before)
  })

  it('негодная нода — nodeTemplate.notSaved с текстами проблем из core', () => {
    const pm = new ProjectManager(tmp)
    const bad = (node: unknown): OrcaError => throwsOrca(() => pm.saveNodeTemplate(input({ node: node as WfTemplateNode })), 'nodeTemplate.notSaved')
    assert.match(bad({ type: 'start' }).message, /Старт/)
    assert.match(bad({ type: 'нет_такого' }).message, /известным типом/)
    assert.match(bad('work').message, /известным типом/)
    assert.match(bad({ type: 'gate', roleId: 'coordinator' }).message, /^шаблон нод не сохранён: /)
    assert.match(throwsOrca(() => pm.saveNodeTemplate(input({ description: 5 as unknown as string })), 'nodeTemplate.notSaved').message, /описание|description/)
    assert.deepEqual(pm.nodeTemplates(), [])
  })

  it('путь подзадачи проверяется: ask внутри пути — ошибка', () => {
    const pm = new ProjectManager(tmp)
    const sub = defaultSubflow()
    const node = work({ subflow: { ...sub, nodes: sub.nodes.map((n, i) => (i === 1 ? { ...n, type: 'ask', roleId: 'developer' } : n)) } })
    throwsOrca(() => pm.saveNodeTemplate(input({ node })), 'nodeTemplate.notSaved')
  })

  it('результат — копия: правка возвращённого значения библиотеку не меняет', () => {
    const pm = new ProjectManager(tmp)
    const t = pm.saveNodeTemplate(input())
    t.title = 'испорчено'
    pm.nodeTemplates()[0].title = 'испорчено'
    assert.equal(pm.nodeTemplates()[0].title, 'Разработка')
  })
})

describe('удаление', () => {
  it('удаляет шаблон и возвращает оставшиеся; последний — ключ из файла уходит', () => {
    writeConfig({ nodeTemplates: [stored('a'), stored('b')] })
    const pm = new ProjectManager(tmp)
    assert.deepEqual(pm.deleteNodeTemplate('a').map((t: WfNodeTemplate) => t.id), ['b'])
    assert.deepEqual((saved().nodeTemplates as WfNodeTemplate[]).map((t) => t.id), ['b'])
    assert.deepEqual(pm.deleteNodeTemplate('b'), [])
    assert.equal('nodeTemplates' in saved(), false)
  })

  it('неизвестный id — nodeTemplate.notFound с id в тексте', () => {
    const pm = new ProjectManager(tmp)
    assert.match(throwsOrca(() => pm.deleteNodeTemplate('нет'), 'nodeTemplate.notFound').message, /нет/)
  })

  it('типы задач и проекты при работе с шаблонами не затрагиваются', () => {
    writeConfig({ nodeTemplates: [stored('a')] })
    const pm = new ProjectManager(tmp)
    const types = pm.taskTypes()
    pm.saveNodeTemplate(input())
    pm.deleteNodeTemplate('a')
    assert.deepEqual(pm.taskTypes(), types)
    assert.equal(pm.list().length, 1)
  })
})
