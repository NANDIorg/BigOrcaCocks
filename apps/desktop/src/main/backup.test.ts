import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BACKUPS_KEEP, UNKNOWN_VERSION, backupOnVersionChange, compareVersions, getJustUpdatedFrom, pruneBackups, rememberUpdate
} from './backup'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orca-backup-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function seed(lastRunVersion?: string): void {
  writeFileSync(join(dir, 'projects.json'), JSON.stringify({ projects: [], activeId: null, ...(lastRunVersion ? { lastRunVersion } : {}) }))
  mkdirSync(join(dir, 'boards'), { recursive: true })
  writeFileSync(join(dir, 'boards', 'p1.json'), '{"tasks":[]}')
  writeFileSync(join(dir, 'boards', 'note.txt'), 'не json')
}

describe('compareVersions', () => {
  it('сравнивает по числам, а не по строкам', () => {
    assert.equal(compareVersions('1.9.0', '1.10.0'), -1)
    assert.equal(compareVersions('2.0.0', '1.99.99'), 1)
    assert.equal(compareVersions('1.2', '1.2.0'), 0)
    assert.equal(compareVersions('1.2.3-beta', '1.2.3'), 0)
  })
})

describe('backupOnVersionChange', () => {
  it('первый запуск (файлов нет) — бэкапа нет, обновления нет', () => {
    assert.deepEqual(backupOnVersionChange(dir, '1.1.0'), { updated: false })
    assert.equal(existsSync(join(dir, 'backups')), false)
  })

  it('та же версия — ничего не копирует', () => {
    seed('1.1.0')
    const r = backupOnVersionChange(dir, '1.1.0')
    assert.equal(r.updated, false)
    assert.equal(r.backupDir, undefined)
    assert.equal(existsSync(join(dir, 'backups')), false)
  })

  it('смена версии: projects.json и boards/*.json копируются в backups/<старая>, версия запоминается', () => {
    seed('1.0.0')
    const r = backupOnVersionChange(dir, '1.1.0')
    assert.equal(r.updated, true)
    assert.equal(r.previous, '1.0.0')
    assert.equal(r.backupDir, join(dir, 'backups', '1.0.0'))
    assert.equal(readFileSync(join(dir, 'backups', '1.0.0', 'boards', 'p1.json'), 'utf8'), '{"tasks":[]}')
    assert.equal(JSON.parse(readFileSync(join(dir, 'backups', '1.0.0', 'projects.json'), 'utf8')).lastRunVersion, '1.0.0')
    assert.equal(existsSync(join(dir, 'backups', '1.0.0', 'boards', 'note.txt')), false)
    // Версия проставлена в самом файле сразу: повторный старт того же билда не бэкапит заново.
    assert.equal(JSON.parse(readFileSync(join(dir, 'projects.json'), 'utf8')).lastRunVersion, '1.1.0')
    assert.equal(backupOnVersionChange(dir, '1.1.0').backupDir, undefined)
  })

  it('файл без lastRunVersion (до появления поля): бэкап в unknown, «обновились» не объявляем', () => {
    seed()
    const r = backupOnVersionChange(dir, '1.1.0')
    assert.equal(r.backupDir, join(dir, 'backups', UNKNOWN_VERSION))
    assert.equal(r.updated, false)
  })

  it('откат на старую версию бэкапится, но обновлением не считается', () => {
    seed('2.0.0')
    const r = backupOnVersionChange(dir, '1.5.0')
    assert.equal(r.updated, false)
    assert.ok(r.backupDir)
  })

  it('битый projects.json бэкапится как есть и не переименовывается', () => {
    writeFileSync(join(dir, 'projects.json'), '{ битый')
    const r = backupOnVersionChange(dir, '1.1.0')
    assert.equal(readFileSync(join(r.backupDir as string, 'projects.json'), 'utf8'), '{ битый')
    assert.equal(readFileSync(join(dir, 'projects.json'), 'utf8'), '{ битый')
  })

  it('«версия» с разделителями пути не выходит за backups/', () => {
    seed('../../evil')
    const r = backupOnVersionChange(dir, '1.1.0')
    assert.equal(r.backupDir, join(dir, 'backups', '.._.._evil'))
  })

  it('повторный бэкап той же версии заменяет старый, а не смешивается', () => {
    seed('1.0.0')
    backupOnVersionChange(dir, '1.1.0')
    writeFileSync(join(dir, 'projects.json'), JSON.stringify({ projects: [], activeId: null, lastRunVersion: '1.0.0' }))
    rmSync(join(dir, 'boards', 'p1.json'))
    backupOnVersionChange(dir, '1.1.0')
    assert.equal(existsSync(join(dir, 'backups', '1.0.0', 'boards', 'p1.json')), false)
  })
})

describe('ротация бэкапов', () => {
  it(`хранит только последние ${BACKUPS_KEEP} по времени`, () => {
    const versions = ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0']
    versions.forEach((v, i) => {
      const d = join(dir, 'backups', v)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'projects.json'), '{}')
      const t = new Date(2026, 0, 1 + i)
      utimesSync(d, t, t)
    })
    const removed = pruneBackups(dir)
    assert.deepEqual(removed.sort(), ['1.0.0', '1.1.0'])
    assert.deepEqual(readdirSync(join(dir, 'backups')).sort(), ['1.2.0', '1.3.0', '1.4.0'])
  })

  it('после серии обновлений остаётся три', () => {
    seed('1.0.0')
    for (const v of ['1.1.0', '1.2.0', '1.3.0', '1.4.0', '1.5.0']) backupOnVersionChange(dir, v)
    const left = readdirSync(join(dir, 'backups'))
    assert.equal(left.length, BACKUPS_KEEP)
    assert.ok(left.includes('1.4.0'))
    assert.equal(left.includes('1.0.0'), false)
  })

  it('нет каталога backups — не падает', () => {
    assert.deepEqual(pruneBackups(dir), [])
  })
})

describe('getJustUpdatedFrom', () => {
  it('отдаёт прежнюю версию после обновления и null в остальных случаях', () => {
    seed('1.0.0')
    rememberUpdate(backupOnVersionChange(dir, '1.1.0'))
    assert.equal(getJustUpdatedFrom(), '1.0.0')
    rememberUpdate(backupOnVersionChange(dir, '1.1.0'))
    assert.equal(getJustUpdatedFrom(), null)
  })
})
