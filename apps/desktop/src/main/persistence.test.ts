import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore, DEFAULT_COLUMNS } from '@orca-board/core'
import { jsonPersistence, writeFileAtomic, readJsonFile, type StateWarning } from './persistence'

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
