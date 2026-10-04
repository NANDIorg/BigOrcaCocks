import { fileServices } from './fixtures/file-services.ts'
// Запуск: pnpm --filter @orca-board/runtime test. Файлы показа человеку (IPC showcase:*) на настоящих файлах.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskStore, DEFAULT_COLUMNS } from '@orca-board/core'
import { OrcaError } from './fixtures/file-services.ts'
import { PreviewTokens } from './fixtures/file-services.ts'
import { readShowcaseFile, resolveShowcasePath, showcasePreviewBase, showcasePreviewUrl, showcaseRoot, showcaseSource } from './fixtures/file-services.ts'
import { showcaseSnapshotDir } from './fixtures/file-services.ts'
import { SHOWCASE_READ_MAX_BYTES, isAssetType, isEntryType, showcaseFileType, showcaseServedMime } from '@orca-board/contracts'

let tmp: string
let wt: string

function write(rel: string, data: string | Uint8Array = 'x'): void {
  mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true })
  writeFileSync(path.join(wt, rel), data)
}

beforeEach(() => {
  fileServices()
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
    assert.equal(showcaseFileType('x.html')?.preview, 'html')
    assert.equal(showcaseFileType('x.md')?.preview, 'markdown')
    assert.equal(showcaseFileType('x.sh'), undefined)
    assert.equal(showcaseFileType('Makefile'), undefined)
    assert.equal(showcaseFileType('dir.png/file'), undefined)
  })
})

describe('точки входа и ассеты показа', () => {
  it('html — страница, md/картинки — точки входа, css/js/шрифты — ассеты, исполняемое и архивы — ничто', () => {
    assert.equal(showcaseFileType('design/A.HTM')?.preview, 'html')
    assert.equal(showcaseFileType('notes.markdown')?.preview, 'markdown')
    assert.equal(showcaseFileType('shot.avif')?.preview, 'image')
    assert.equal(showcaseFileType('spec.pdf')?.preview, 'open')
    assert.deepEqual(['a.html', 'a.png', 'a.md', 'a.pdf', 'a.css'].map(isEntryType), [true, true, true, true, false])
    assert.deepEqual(['a.css', 'a.JS', 'a.mjs', 'f.woff2', 'v.mp4', 'a.html'].map(isAssetType), [true, true, true, true, true, false])
    for (const bad of ['run.sh', 'a.exe', 'a.zip', 'a.docx', 'Makefile', '.env', 'dir.css/x', 'toString', 'a.constructor']) {
      assert.equal(isEntryType(bad), false, bad)
      assert.equal(isAssetType(bad), false, bad)
      assert.equal(showcaseServedMime(bad), undefined, bad)
    }
    assert.equal(showcaseServedMime('style.css'), 'text/css')
    assert.equal(showcaseServedMime('a.html'), 'text/html')
  })
})

describe('resolveShowcasePath', () => {
  it('файл из белого списка внутри worktree', () => {
    assert.equal(resolveShowcasePath(wt, 'design/a.html'), path.join(wt, 'design/a.html'))
    assert.equal(resolveShowcasePath(wt, './design/../design/a.png'), path.join(wt, 'design/a.png'))
  })

  it('отказ: пусто, абсолютный путь, выход через .., чужое расширение, нет файла, каталог', () => {
    assert.throws(() => resolveShowcasePath(wt, ''), /showcase\.noPath/)
    assert.throws(() => resolveShowcasePath(wt, 42), /showcase\.noPath/)
    assert.throws(() => resolveShowcasePath(wt, path.join(wt, 'design/a.png')), /showcase\.notRelative/)
    writeFileSync(path.join(tmp, 'out.png'), 'x')
    assert.throws(() => resolveShowcasePath(wt, '../out.png'), /showcase\.outside/)
    assert.throws(() => resolveShowcasePath(wt, 'run.sh'), /showcase\.badType/)
    assert.throws(() => resolveShowcasePath(wt, 'secret.txt'), /showcase\.badType/)
    assert.throws(() => resolveShowcasePath(wt, 'design/nope.png'), /showcase\.(?:notFound|dispatchNotFound)/)
    mkdirSync(path.join(wt, 'dir.png'))
    assert.throws(() => resolveShowcasePath(wt, 'dir.png'), /showcase\.notFile/)
  })

  it('симлинк наружу или на чужой тип — отказ', { skip: process.platform === 'win32' }, () => {
    writeFileSync(path.join(tmp, 'out.png'), 'x')
    symlinkSync(path.join(tmp, 'out.png'), path.join(wt, 'link.png'))
    assert.throws(() => resolveShowcasePath(wt, 'link.png'), /showcase\.outside/)
    symlinkSync(path.join(wt, 'run.sh'), path.join(wt, 'run.png'))
    assert.throws(() => resolveShowcasePath(wt, 'run.png'), /showcase\.badType/)
  })
})

describe('readShowcaseFile', () => {
  it('картинка и markdown — байты с mime; HTML — не байтами (только протокол показа); больше предела — отказ', () => {
    const png = readShowcaseFile(wt, 'design/a.png')
    assert.equal(png.mime, 'image/png')
    assert.deepEqual([...png.bytes], [0x89, 0x50, 0x4e, 0x47])
    assert.equal(new TextDecoder().decode(readShowcaseFile(wt, 'design/notes.md').bytes), '# Варианты')
    assert.throws(() => readShowcaseFile(wt, 'design/a.html'), /showcase\.noPreview/)
    write('big.png', new Uint8Array(SHOWCASE_READ_MAX_BYTES + 1))
    assert.throws(() => readShowcaseFile(wt, 'big.png'), /showcase\.tooBig/)
  })
})

describe('showcaseRoot', () => {
  it('worktree задачи; нет задачи или worktree убран — ошибка с веткой', () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const t = store.createTask({ title: 'Макет', roleId: 'developer' })
    assert.throws(() => showcaseRoot(store, 'task_nope'), /showcase\.taskNotFound/)
    assert.throws(() => showcaseRoot(store, t.id), /showcase\.noWorktree/)
    store.updateTask(t.id, { worktree: wt, branch: `orca/${t.id}` })
    assert.equal(showcaseRoot(store, t.id), wt)
    store.updateTask(t.id, { worktree: path.join(tmp, 'gone') })
    // Своя ветка orca/<id> после мержа удалена — её имя не подсказываем.
    assert.throws(() => showcaseRoot(store, t.id), (e: Error) => /showcase\.noWorktree/.test(e.message) && !e.message.includes(`orca/${t.id}`))
  })

  it('после мержа — worktree ветки глобальной задачи; он убран — ошибка с именем её ветки', () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const run = store.createRun('цель')
    const t = store.createTask({ title: 'Макет', roleId: 'developer', runId: run.id })
    store.updateTask(t.id, { worktree: path.join(tmp, 'gone') })
    store.setRunGit(run.id, { branch: 'feature/run-x', base: 'develop', worktree: wt })
    assert.equal(showcaseRoot(store, t.id), wt)
    store.setRunGit(run.id, { worktree: undefined })
    assert.throws(() => showcaseRoot(store, t.id), (e: unknown) => e instanceof OrcaError && e.key === 'showcase.noWorktreeBranch' && e.params.branch === 'feature/run-x')
  })
})

describe('showcaseSource: снимок запуска', () => {
  it('со snapshot — папка снимка (и после мержа); без снимка или снимок удалён — worktree; без dispatchId — последний запуск', () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const run = store.createRun('цель')
    const t = store.createTask({ title: 'Макет', roleId: 'developer', runId: run.id })
    store.updateTask(t.id, { worktree: wt, branch: `orca/${t.id}` })
    const old = store.startDispatch(t.id, 'pty_a')
    store.finishDispatch(old.id, 'старый показ', [], undefined, { showcase: { files: ['design/a.png'] } })
    const d = store.startDispatch(t.id, 'pty_b')
    store.finishDispatch(d.id, 'готово', [], undefined, { showcase: { files: ['design/a.png'] }, snapshot: { at: 1, files: 1, bytes: 4 } })
    const snapshots = { root: path.join(tmp, 'showcase'), projectId: 'proj_1' }
    const dir = showcaseSnapshotDir(snapshots.root, 'proj_1', run.id, d.id)
    // Снимка на диске нет (удалили руками) — как раньше, worktree.
    assert.equal(showcaseSource(store, t.id, d.id, snapshots), wt)
    mkdirSync(path.join(dir, 'design'), { recursive: true })
    writeFileSync(path.join(dir, 'design/a.png'), new Uint8Array([1, 2]))
    // Мерж: worktree задачи убран, а снимок остался.
    store.updateTask(t.id, { worktree: undefined })
    assert.equal(showcaseSource(store, t.id, d.id, snapshots), dir)
    assert.deepEqual([...readShowcaseFile(showcaseSource(store, t.id, d.id, snapshots), 'design/a.png').bytes], [1, 2])
    assert.equal(showcaseSource(store, t.id, undefined, snapshots), dir, 'старый renderer без dispatchId — снимок последнего запуска')
    // Старый запуск без snapshot читается по-старому: worktree убран — ошибка.
    assert.throws(() => showcaseSource(store, t.id, old.id, snapshots), /showcase\.noWorktree/)
  })
})

describe('showcaseSource и previewUrl', () => {
  it('без dispatchId — worktree задачи, как раньше; запуск этой задачи — тоже; чужой или несуществующий — отказ', () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const t = store.createTask({ title: 'Макет', roleId: 'developer' })
    const other = store.createTask({ title: 'Чужая', roleId: 'developer' })
    store.updateTask(t.id, { worktree: wt, branch: `orca/${t.id}` })
    const d = store.startDispatch(t.id, 'pty_a')
    const foreign = store.startDispatch(other.id, 'pty_b')
    assert.equal(showcaseSource(store, t.id), wt)
    assert.equal(showcaseSource(store, t.id, d.id), wt)
    assert.throws(() => showcaseSource(store, t.id, foreign.id), /showcase\.dispatchNotFound/)
    assert.throws(() => showcaseSource(store, t.id, 'd_nope'), /showcase\.(?:notFound|dispatchNotFound)/)
    assert.throws(() => showcaseSource(store, t.id, 42), /showcase\.(?:notFound|dispatchNotFound)/)
  })

  it('previewUrl — токен протокола на корень показа запуска; PDF, скрытые и чужие пути — отказ', () => {
    write('design/мой макет.html', '<p>Б</p>')
    write('design/doc.pdf', '%PDF')
    write('.hidden/a.html', '<p>h</p>')
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const t = store.createTask({ title: 'Макет', roleId: 'developer' })
    store.updateTask(t.id, { worktree: wt, branch: `orca/${t.id}` })
    const d = store.startDispatch(t.id, 'pty_a')
    const tokens = new PreviewTokens()
    const a = showcasePreviewUrl(store, tokens, d.id, 'design/a.html')
    assert.match(a.url, /^orca-preview:\/\/[0-9a-f]{32}\/design\/a\.html$/)
    assert.equal(a.mime, 'text/html')
    assert.ok(a.url.startsWith(a.base))
    assert.deepEqual(tokens.get(new URL(a.base).host), { root: wt, network: false })
    // Тот же корень — тот же токен.
    assert.equal(showcasePreviewUrl(store, tokens, d.id, 'design/notes.md').base, a.base)
    // Без снимка токен — на весь worktree: сеть не выдаётся (страница прочитала бы репозиторий и отправила наружу).
    assert.throws(() => showcasePreviewUrl(store, tokens, d.id, 'design/a.html', { network: true }), (e: unknown) =>
      e instanceof OrcaError && e.key === 'showcase.networkNoSnapshot' && /showcase\.networkNoSnapshot/.test(e.message))
    assert.equal(tokens.size, 1, 'токен с сетью не выдан')
    assert.equal(showcasePreviewUrl(store, tokens, d.id, 'design/мой макет.html').url, `${a.base}design/${encodeURIComponent('мой макет.html')}`)
    assert.throws(() => showcasePreviewUrl(store, tokens, d.id, 'design/doc.pdf'), /showcase\.noPreview/)
    assert.throws(() => showcasePreviewUrl(store, tokens, d.id, '.hidden/a.html'), /showcase\.hidden/)
    assert.throws(() => showcasePreviewUrl(store, tokens, d.id, '../x.html'), /showcase\.outside/)
    assert.throws(() => showcasePreviewUrl(store, tokens, d.id, 'run.sh'), /showcase\.badType/)
    assert.throws(() => showcasePreviewUrl(store, tokens, 'd_nope', 'design/a.html'), /showcase\.(?:notFound|dispatchNotFound)/)
  })

  it('previewUrl со снимком — токен на папку снимка, работает и после мержа (worktree убран)', () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const run = store.createRun('цель')
    const t = store.createTask({ title: 'Макет', roleId: 'developer', runId: run.id })
    store.updateTask(t.id, { worktree: wt, branch: `orca/${t.id}` })
    const d = store.startDispatch(t.id, 'pty_a')
    store.finishDispatch(d.id, 'готово', [], undefined, { showcase: { files: ['design/a.html'] }, snapshot: { at: 1, files: 1, bytes: 8 } })
    const snapshots = { root: path.join(tmp, 'showcase'), projectId: 'proj_1' }
    const dir = showcaseSnapshotDir(snapshots.root, 'proj_1', run.id, d.id)
    mkdirSync(path.join(dir, 'design'), { recursive: true })
    writeFileSync(path.join(dir, 'design/a.html'), '<p>снимок</p>')
    store.updateTask(t.id, { worktree: undefined })
    const tokens = new PreviewTokens()
    const a = showcasePreviewUrl(store, tokens, d.id, 'design/a.html', undefined, snapshots)
    assert.deepEqual(tokens.get(new URL(a.base).host), { root: dir, network: false })
    // Со снимком сеть — отдельный токен на тот же снимок.
    const net = showcasePreviewUrl(store, tokens, d.id, 'design/a.html', { network: true }, snapshots)
    assert.notEqual(net.base, a.base)
    assert.deepEqual(tokens.get(new URL(net.base).host), { root: dir, network: true })
    assert.throws(() => showcasePreviewUrl(store, tokens, d.id, 'design/a.html'), /showcase\.noWorktree/, 'без снимков — старый путь через worktree')
  })

  it('previewBase — база без сети для картинок описания: снимок, без него worktree, ни того ни другого — null', () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const run = store.createRun('цель')
    const t = store.createTask({ title: 'Макет', roleId: 'developer', runId: run.id })
    store.updateTask(t.id, { worktree: wt, branch: `orca/${t.id}` })
    const old = store.startDispatch(t.id, 'pty_a')
    store.finishDispatch(old.id, 'без снимка', [], undefined, { showcase: { text: '![A](design/a.png)', files: [] } })
    const d = store.startDispatch(t.id, 'pty_b')
    store.finishDispatch(d.id, 'готово', [], undefined, { showcase: { text: '![A](design/a.png)', files: [] }, snapshot: { at: 1, files: 1, bytes: 4 } })
    const snapshots = { root: path.join(tmp, 'showcase'), projectId: 'proj_1' }
    const dir = showcaseSnapshotDir(snapshots.root, 'proj_1', run.id, d.id)
    mkdirSync(path.join(dir, 'design'), { recursive: true })
    writeFileSync(path.join(dir, 'design/a.png'), new Uint8Array([1]))
    const tokens = new PreviewTokens()
    const base = showcasePreviewBase(store, tokens, d.id, snapshots)!
    assert.match(base, /^orca-preview:\/\/[0-9a-f]{32}\/$/)
    assert.deepEqual(tokens.get(new URL(base).host), { root: dir, network: false })
    // Картинка описания — тем же токеном, что и файлы показа снимка.
    assert.equal(showcasePreviewUrl(store, tokens, d.id, 'design/a.png', undefined, snapshots).base, base)
    const oldBase = showcasePreviewBase(store, tokens, old.id, snapshots)!
    assert.deepEqual(tokens.get(new URL(oldBase).host), { root: wt, network: false }, 'без снимка — worktree, без сети')
    store.updateTask(t.id, { worktree: undefined })
    assert.equal(showcasePreviewBase(store, tokens, old.id, snapshots), null)
    assert.throws(() => showcasePreviewBase(store, tokens, 'd_nope', snapshots), /showcase\.(?:notFound|dispatchNotFound)/)
  })
})
