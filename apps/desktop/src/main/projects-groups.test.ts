// Запуск: pnpm --filter @orca-board/desktop test. Группы проектов в ProjectManager: CRUD, удаление группы
// (проекты остаются без группы), загрузка projects.json без групп (это и есть миграция), мусор в файле, рестарт.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_COLUMNS } from '@orca-board/core'
import { ProjectManager } from './projects'
import { OrcaError } from './i18n'
import { PROJECTS_FILE_VERSION } from './task-types-migration'

let tmp: string
const file = (): string => path.join(tmp, 'projects.json')

function saved(): { groups?: unknown; projects: Array<{ id: string; groupId?: string }> } {
  return JSON.parse(readFileSync(file(), 'utf8')) as { groups?: unknown; projects: Array<{ id: string; groupId?: string }> }
}

/** projects.json с двумя проектами; `extra` — ключи корня (например, `groups`), `projectExtra` — поля каждого проекта. */
function writeFile(extra: Record<string, unknown> = {}, projectExtra: Record<string, unknown> = {}): void {
  const project = (id: string) => ({ id, root: path.join(tmp, id), name: id, columns: DEFAULT_COLUMNS, ...projectExtra })
  writeFileSync(file(), JSON.stringify({ version: PROJECTS_FILE_VERSION, projects: [project('p1'), project('p2')], activeId: 'p1', ...extra }))
}

function throwsOrca(fn: () => unknown, key: string): void {
  assert.throws(fn, (e: unknown) => e instanceof OrcaError && e.key === key)
}

beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'orca-groups-')) })
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('загрузка файла без групп', () => {
  it('projects.json без ключа groups: групп нет, проекты без группы, файл не переписывается с groups', () => {
    writeFile()
    const pm = new ProjectManager(tmp)
    assert.deepEqual(pm.groups(), [])
    assert.deepEqual(pm.list().map((p) => p.groupId), [undefined, undefined])
    pm.markRun('1.0.0')
    assert.equal('groups' in saved(), false, 'пустых групп в файл не пишем')
  })

  it('нет файла вовсе → групп нет', () => {
    assert.deepEqual(new ProjectManager(tmp).groups(), [])
  })

  it('файл до типов задач (version 1) не теряет групп проектов и groupId', () => {
    writeFileSync(file(), JSON.stringify({
      projects: [{ id: 'p1', root: path.join(tmp, 'p1'), name: 'p1', groupId: 'g1' }], activeId: 'p1',
      groups: [{ id: 'g1', name: 'Работа' }]
    }))
    const pm = new ProjectManager(tmp)
    assert.deepEqual(pm.groups(), [{ id: 'g1', name: 'Работа' }])
    assert.equal(pm.get('p1')?.groupId, 'g1')
  })
})

describe('создание и переименование', () => {
  it('имя обрезается, группа уходит в конец, id уникальны', () => {
    const pm = new ProjectManager(tmp)
    const a = pm.createGroup('  Работа  ')
    const b = pm.createGroup('Дом')
    assert.equal(a.name, 'Работа')
    assert.notEqual(a.id, b.id)
    assert.deepEqual(pm.groups().map((g) => g.name), ['Работа', 'Дом'])
  })

  it('пустое имя и пробелы — projects.groupNameEmpty, по-русски и без записи', () => {
    const pm = new ProjectManager(tmp)
    throwsOrca(() => pm.createGroup(''), 'projects.groupNameEmpty')
    throwsOrca(() => pm.createGroup('   \t'), 'projects.groupNameEmpty')
    assert.throws(() => pm.createGroup(' '), /название группы проектов не может быть пустым/)
    assert.deepEqual(pm.groups(), [])
  })

  it('переименование обрезает имя; пустое и неизвестная группа — ошибки', () => {
    const pm = new ProjectManager(tmp)
    const g = pm.createGroup('Работа')
    assert.equal(pm.renameGroup(g.id, ' Офис ').name, 'Офис')
    throwsOrca(() => pm.renameGroup(g.id, '  '), 'projects.groupNameEmpty')
    assert.equal(pm.groups()[0]!.name, 'Офис', 'неудачное переименование не меняет имя')
    throwsOrca(() => pm.renameGroup('nope', 'X'), 'projects.groupNotFound')
  })

  it('дубликаты имён допустимы (id различает)', () => {
    const pm = new ProjectManager(tmp)
    pm.createGroup('A')
    pm.createGroup('A')
    assert.equal(pm.groups().length, 2)
  })
})

describe('свернуть/развернуть', () => {
  it('collapsed переключается; развёрнутая — без поля; неизвестная группа — ошибка', () => {
    const pm = new ProjectManager(tmp)
    const g = pm.createGroup('A')
    assert.equal(pm.setGroupCollapsed(g.id, true).collapsed, true)
    assert.equal(pm.groups()[0]!.collapsed, true)
    const open = pm.setGroupCollapsed(g.id, false)
    assert.equal('collapsed' in open, false)
    assert.equal('collapsed' in pm.groups()[0]!, false)
    throwsOrca(() => pm.setGroupCollapsed('nope', true), 'projects.groupNotFound')
  })
})

describe('назначение проекту группы', () => {
  it('назначить, сменить, вынуть (null)', () => {
    writeFile()
    const pm = new ProjectManager(tmp)
    const a = pm.createGroup('A')
    const b = pm.createGroup('B')
    assert.equal(pm.setProjectGroup('p1', a.id).groupId, a.id)
    assert.equal(pm.get('p1')?.groupId, a.id)
    assert.equal(pm.setProjectGroup('p1', b.id).groupId, b.id)
    const out = pm.setProjectGroup('p1', null)
    assert.equal('groupId' in out, false)
    assert.equal(pm.get('p1')?.groupId, undefined)
  })

  it('неизвестная группа — groupNotFound и проект не меняется; неизвестный проект — project not found', () => {
    writeFile()
    const pm = new ProjectManager(tmp)
    const a = pm.createGroup('A')
    pm.setProjectGroup('p1', a.id)
    throwsOrca(() => pm.setProjectGroup('p1', 'nope'), 'projects.groupNotFound')
    assert.equal(pm.get('p1')?.groupId, a.id)
    assert.throws(() => pm.setProjectGroup('nope', a.id), /project not found/)
    assert.throws(() => pm.setProjectGroup('nope', null), /project not found/)
  })
})

describe('удаление группы и проекта', () => {
  it('удаление группы: её проекты остаются без группы, чужие не тронуты', () => {
    writeFile()
    const pm = new ProjectManager(tmp)
    const a = pm.createGroup('A')
    const b = pm.createGroup('B')
    pm.setProjectGroup('p1', a.id)
    pm.setProjectGroup('p2', b.id)
    pm.removeGroup(a.id)
    assert.deepEqual(pm.groups().map((g) => g.id), [b.id])
    assert.deepEqual(pm.list().map((p) => p.id), ['p1', 'p2'], 'проекты не удалены')
    assert.equal(pm.get('p1')?.groupId, undefined)
    assert.equal(pm.get('p2')?.groupId, b.id)
    throwsOrca(() => pm.removeGroup(a.id), 'projects.groupNotFound')
  })

  it('удаление последней группы: в файле пустой массив, после рестарта групп нет', () => {
    const pm = new ProjectManager(tmp)
    const a = pm.createGroup('A')
    pm.removeGroup(a.id)
    assert.deepEqual(saved().groups, [])
    assert.deepEqual(new ProjectManager(tmp).groups(), [])
  })

  it('удаление проекта не ломает группы; пустая группа остаётся', () => {
    writeFile()
    const pm = new ProjectManager(tmp)
    const a = pm.createGroup('A')
    pm.setProjectGroup('p1', a.id)
    pm.remove('p1')
    assert.deepEqual(pm.groups(), [a])
    assert.deepEqual(new ProjectManager(tmp).groups(), [a])
  })
})

describe('порядок групп', () => {
  it('reorderGroups переставляет; лишний, пропущенный и повторный id — groupNotFound', () => {
    const pm = new ProjectManager(tmp)
    const a = pm.createGroup('A')
    const b = pm.createGroup('B')
    const c = pm.createGroup('C')
    assert.deepEqual(pm.reorderGroups([c.id, a.id, b.id]).map((g) => g.name), ['C', 'A', 'B'])
    throwsOrca(() => pm.reorderGroups([a.id, b.id]), 'projects.groupNotFound')
    throwsOrca(() => pm.reorderGroups([a.id, b.id, c.id, 'nope']), 'projects.groupNotFound')
    throwsOrca(() => pm.reorderGroups([a.id, a.id, b.id]), 'projects.groupNotFound')
    assert.deepEqual(pm.groups().map((g) => g.name), ['C', 'A', 'B'], 'неудачные вызовы порядок не меняют')
  })
})

describe('рестарт', () => {
  it('группы, порядок, collapsed и groupId переживают перезапуск', () => {
    writeFile()
    const first = new ProjectManager(tmp)
    const a = first.createGroup('Работа')
    const b = first.createGroup('Дом')
    first.setGroupCollapsed(b.id, true)
    first.setProjectGroup('p2', b.id)
    first.reorderGroups([b.id, a.id])

    const again = new ProjectManager(tmp)
    assert.deepEqual(again.groups(), [{ id: b.id, name: 'Дом', collapsed: true }, { id: a.id, name: 'Работа' }])
    assert.equal(again.get('p2')?.groupId, b.id)
    assert.equal(again.get('p1')?.groupId, undefined)
  })
})

describe('мусор в файле', () => {
  it('битые записи групп отбрасываются, имя обрезается, collapsed — только true', () => {
    writeFile({
      groups: [
        { id: 'g1', name: '  Работа ', collapsed: true },
        { id: 'g2', name: 'Дом', collapsed: 'yes' },
        { id: 'g1', name: 'Повтор' },
        { id: '', name: 'Без id' },
        { id: 'g3', name: '   ' },
        { id: 'g4' },
        'строка', null, 7
      ]
    })
    assert.deepEqual(new ProjectManager(tmp).groups(), [{ id: 'g1', name: 'Работа', collapsed: true }, { id: 'g2', name: 'Дом' }])
  })

  it('groups не массив → групп нет; groupId на несуществующую группу снимается', () => {
    writeFile({ groups: { id: 'g1' } }, { groupId: 'g1' })
    const pm = new ProjectManager(tmp)
    assert.deepEqual(pm.groups(), [])
    assert.deepEqual(pm.list().map((p) => p.groupId), [undefined, undefined])
  })

  it('groupId на существующую группу сохраняется', () => {
    writeFile({ groups: [{ id: 'g1', name: 'A' }] }, { groupId: 'g1' })
    assert.deepEqual(new ProjectManager(tmp).list().map((p) => p.groupId), ['g1', 'g1'])
  })
})
