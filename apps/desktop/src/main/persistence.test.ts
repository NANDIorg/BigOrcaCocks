import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore, DEFAULT_COLUMNS } from '@orca-board/core'
import { jsonPersistence, writeFileAtomic, writeFilesAtomic, readJsonFile, type StateWarning } from './persistence'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orca-persist-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('writeFileAtomic', () => {
  it('пишет файл и не оставляет .tmp', () => {
    const f = join(dir, 'sub', 'a.json')
    writeFileAtomic(f, '{"a":1}')
    assert.equal(readFileSync(f, 'utf8'), '{"a":1}')
    assert.deepEqual(readdirSync(join(dir, 'sub')), ['a.json'])
  })

  it('заменяет старое содержимое целиком', () => {
    const f = join(dir, 'a.json')
    writeFileAtomic(f, 'x'.repeat(1000))
    writeFileAtomic(f, '{}')
    assert.equal(readFileSync(f, 'utf8'), '{}')
  })

  it('при ошибке записи старый файл цел, а .tmp убран', () => {
    const f = join(dir, 'a.json')
    writeFileAtomic(f, '{"old":true}')
    // Целевой путь — каталог: rename поверх него падает уже после записи .tmp.
    const target = join(dir, 'd.json')
    mkdirSync(target)
    assert.throws(() => writeFileAtomic(target, '{}'))
    assert.deepEqual(readdirSync(dir).sort(), ['a.json', 'd.json'])
    assert.equal(readFileSync(f, 'utf8'), '{"old":true}')
  })
})

describe('writeFilesAtomic', () => {
  it('ошибка staging последнего файла оставляет все исходные файлы и убирает подготовленные tmp', () => {
    const board = join(dir, 'board.json')
    const projects = join(dir, 'projects.json')
    writeFileSync(board, '{"old":"board"}')
    writeFileSync(projects, '{"old":"projects"}')
    mkdirSync(`${projects}.tmp`)
    assert.throws(() => writeFilesAtomic([{ file: board, text: '{}' }, { file: projects, text: '{}' }]))
    assert.equal(readFileSync(board, 'utf8'), '{"old":"board"}')
    assert.equal(readFileSync(projects, 'utf8'), '{"old":"projects"}')
    assert.deepEqual(readdirSync(dir).sort(), ['board.json', 'projects.json', 'projects.json.tmp'])
  })

  it('ошибка rename последнего файла откатывает уже записанный файл и удаляет новый', (t) => {
    const old = join(dir, 'old.json')
    const added = join(dir, 'added.json')
    const projects = join(dir, 'projects.json')
    writeFileSync(old, ' {"old":true}\n')
    writeFileSync(projects, '{"library":"old"}')
    const rename = fs.renameSync
    const stub = t.mock.method(fs, 'renameSync', (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
      if (to === projects) throw new Error('simulated EIO during projects rename')
      return rename(from, to)
    })
    syncBuiltinESMExports()
    try {
      assert.throws(() => writeFilesAtomic([{ file: old, text: '{}' }, { file: added, text: '{}' }, { file: projects, text: '{}' }]), /simulated EIO/)
      assert.equal(readFileSync(old, 'utf8'), ' {"old":true}\n')
      assert.equal(readFileSync(projects, 'utf8'), '{"library":"old"}')
      assert.deepEqual(readdirSync(dir).sort(), ['old.json', 'projects.json'])
    } finally {
      stub.mock.restore()
      syncBuiltinESMExports()
    }
  })
})

describe('jsonPersistence', () => {
  it('нет файла — null без предупреждения', () => {
    const w: StateWarning[] = []
    assert.equal(jsonPersistence(join(dir, 'b.json'), (x) => w.push(x)).load(), null)
    assert.equal(w.length, 0)
  })

  it('битый JSON: файл уходит в .corrupt-<ts>, вернётся null и предупреждение', () => {
    const f = join(dir, 'b.json')
    writeFileSync(f, '{"tasks": [')
    const w: StateWarning[] = []
    assert.equal(jsonPersistence(f, (x) => w.push(x)).load(), null)
    assert.equal(w.length, 1)
    assert.equal(w[0].kind, 'corrupt')
    assert.match(w[0].movedTo ?? '', /b\.json\.corrupt-\d+$/)
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('b.json.corrupt-')).length, 1)
    assert.equal(readdirSync(dir).includes('b.json'), false)
    assert.equal(readFileSync(w[0].movedTo as string, 'utf8'), '{"tasks": [')
  })

  it('корень не объект (null, массив) — тоже повреждение', () => {
    for (const text of ['null', '[]', '5']) {
      const f = join(dir, `c${text.length}.json`)
      writeFileSync(f, text)
      const w: StateWarning[] = []
      assert.equal(jsonPersistence(f, (x) => w.push(x)).load(), null)
      assert.equal(w.length, 1, text)
    }
  })

  it('запись и чтение возвращают тот же снапшот', () => {
    const f = join(dir, 'd.json')
    const p = jsonPersistence(f)
    const s = new TaskStore(p, () => DEFAULT_COLUMNS)
    s.createTask({ title: 'T' })
    const again = new TaskStore(jsonPersistence(f), () => DEFAULT_COLUMNS)
    assert.equal(again.listTasks()[0]?.title, 'T')
    assert.equal(readJsonFile(f, 'x').status, 'ok')
  })

  it('доска из будущего формата: store отказывается, файл на месте', () => {
    const f = join(dir, 'e.json')
    writeFileSync(f, JSON.stringify({ formatVersion: 999, tasks: [] }))
    assert.throws(() => new TaskStore(jsonPersistence(f), () => DEFAULT_COLUMNS), /более новой версией/)
    assert.equal(JSON.parse(readFileSync(f, 'utf8')).formatVersion, 999)
  })
})
