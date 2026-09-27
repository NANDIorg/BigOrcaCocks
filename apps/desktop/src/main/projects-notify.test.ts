// Запуск: pnpm --filter @orca-board/desktop test. Два общих поведения ProjectManager, нужных для того, чтобы
// правка настроек/проектов из CLI (сокет) отражалась в открытом окне так же, как из IPC:
// 1) onDataChange — общий хук поверх save() (единственная точка записи), а не отдельное событие на метод;
// 2) remove() сам чистит картинки глобальных задач проекта (userData/run-images) — раньше это делал только
//    обработчик IPC `projects:remove`, и `projects.remove` из сокета (`project agents/columns/... `, `projects remove`
//    из CLI) их не трогал.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_COLUMNS } from '@orca-board/core'
import { ProjectManager } from './projects'
import { runImagesRoot } from './run-images'
import { PROJECTS_FILE_VERSION } from './task-types-migration'

let tmp: string

function writeConfig(): void {
  writeFileSync(join(tmp, 'projects.json'), JSON.stringify({
    version: PROJECTS_FILE_VERSION,
    projects: [{ id: 'p1', root: join(tmp, 'repo'), name: 'repo', columns: DEFAULT_COLUMNS }],
    activeId: 'p1'
  }))
}

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'orca-notify-')) })
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('ProjectManager.onDataChange', () => {
  it('зовётся на любую мутацию (settings, группы, шаблоны нод — не только на ту, что тестируем)', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    let calls = 0
    const off = pm.onDataChange(() => { calls++ })

    pm.setSettings({ language: 'en' })
    pm.createGroup('Работа')
    pm.setEnabledAgents('p1', ['claude'])

    assert.equal(calls, 3, 'на каждый save() — один вызов')
    off()
    pm.setSettings({ language: 'ru' })
    assert.equal(calls, 3, 'после отписки новые мутации не долетают')
  })

  it('не зовётся при простом чтении', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    let calls = 0
    pm.onDataChange(() => { calls++ })
    pm.list()
    pm.settings()
    pm.groups()
    assert.equal(calls, 0)
  })
})

describe('ProjectManager.remove', () => {
  it('убирает картинки глобальных задач проекта вместе с самим проектом (userData/run-images/<id>)', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    const dir = join(runImagesRoot(tmp), 'p1', 'run1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'img1.png'), 'x')

    pm.remove('p1')

    assert.equal(pm.list().length, 0)
    assert.equal(existsSync(join(runImagesRoot(tmp), 'p1')), false)
  })

  it('нет папки картинок — remove не падает', () => {
    writeConfig()
    const pm = new ProjectManager(tmp)
    assert.doesNotThrow(() => pm.remove('p1'))
  })
})
