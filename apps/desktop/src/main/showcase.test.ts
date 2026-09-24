// Запуск: pnpm --filter @orca-board/desktop test. Файлы показа человеку (IPC showcase:*) на настоящих файлах.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskStore, DEFAULT_COLUMNS } from '@orca-board/core'
import { readShowcaseFile, resolveShowcasePath, showcaseRoot } from './showcase'
import { SHOWCASE_READ_MAX_BYTES, showcaseFileType } from '../shared/showcase'

let tmp: string
let wt: string

function write(rel: string, data: string | Uint8Array = 'x'): void {
  mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true })
  writeFileSync(path.join(wt, rel), data)
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-showcase-')))
  wt = path.join(tmp, 'wt')
  mkdirSync(wt)
  write('design/a.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  write('design/a.html', '<p>A</p>')
  write('design/notes.md', '# Варианты')
  write('run.sh', 'echo hi')
  write('secret.txt', 'секрет')
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('showcaseFileType', () => {
  it('белый список по расширению без учёта регистра', () => {
    assert.equal(showcaseFileType('a/B.PNG')?.preview, 'image')
    assert.equal(showcaseFileType('x.html')?.preview, 'open')
    assert.equal(showcaseFileType('x.md')?.preview, 'markdown')
    assert.equal(showcaseFileType('x.sh'), undefined)
    assert.equal(showcaseFileType('Makefile'), undefined)
    assert.equal(showcaseFileType('dir.png/file'), undefined)
  })
})

describe('resolveShowcasePath', () => {
  it('файл из белого списка внутри worktree', () => {
    assert.equal(resolveShowcasePath(wt, 'design/a.html'), path.join(wt, 'design/a.html'))
    assert.equal(resolveShowcasePath(wt, './design/../design/a.png'), path.join(wt, 'design/a.png'))
  })

  it('отказ: пусто, абсолютный путь, выход через .., чужое расширение, нет файла, каталог', () => {
    assert.throws(() => resolveShowcasePath(wt, ''), /не задан/)
    assert.throws(() => resolveShowcasePath(wt, 42), /не задан/)
    assert.throws(() => resolveShowcasePath(wt, path.join(wt, 'design/a.png')), /от корня репозитория/)
    writeFileSync(path.join(tmp, 'out.png'), 'x')
    assert.throws(() => resolveShowcasePath(wt, '../out.png'), /вне worktree/)
    assert.throws(() => resolveShowcasePath(wt, 'run.sh'), /тип файла/)
    assert.throws(() => resolveShowcasePath(wt, 'secret.txt'), /тип файла/)
    assert.throws(() => resolveShowcasePath(wt, 'design/nope.png'), /не найден/)
    mkdirSync(path.join(wt, 'dir.png'))
    assert.throws(() => resolveShowcasePath(wt, 'dir.png'), /не файл/)
  })

  it('симлинк наружу или на чужой тип — отказ', { skip: process.platform === 'win32' }, () => {
    writeFileSync(path.join(tmp, 'out.png'), 'x')
    symlinkSync(path.join(tmp, 'out.png'), path.join(wt, 'link.png'))
    assert.throws(() => resolveShowcasePath(wt, 'link.png'), /вне worktree/)
    symlinkSync(path.join(wt, 'run.sh'), path.join(wt, 'run.png'))
    assert.throws(() => resolveShowcasePath(wt, 'run.png'), /тип файла/)
  })
})

describe('readShowcaseFile', () => {
  it('картинка и markdown — байты с mime; HTML — только «Открыть»; больше предела — отказ', () => {
    const png = readShowcaseFile(wt, 'design/a.png')
    assert.equal(png.mime, 'image/png')
    assert.deepEqual([...png.bytes], [0x89, 0x50, 0x4e, 0x47])
    assert.equal(new TextDecoder().decode(readShowcaseFile(wt, 'design/notes.md').bytes), '# Варианты')
    assert.throws(() => readShowcaseFile(wt, 'design/a.html'), /«Открыть»/)
    write('big.png', new Uint8Array(SHOWCASE_READ_MAX_BYTES + 1))
    assert.throws(() => readShowcaseFile(wt, 'big.png'), /больше/)
  })
})

describe('showcaseRoot', () => {
  it('worktree задачи; нет задачи или worktree убран — ошибка с веткой', () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const t = store.createTask({ title: 'Макет', roleId: 'developer' })
    assert.throws(() => showcaseRoot(store, 'task_nope'), /не найдена/)
    assert.throws(() => showcaseRoot(store, t.id), /нет worktree/)
    store.updateTask(t.id, { worktree: wt, branch: `orca/${t.id}` })
    assert.equal(showcaseRoot(store, t.id), wt)
    store.updateTask(t.id, { worktree: path.join(tmp, 'gone') })
    assert.throws(() => showcaseRoot(store, t.id), new RegExp(`ветке orca/${t.id}`))
  })
})
