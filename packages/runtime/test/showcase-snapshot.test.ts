import { fileServices } from './fixtures/file-services.ts'
// Запуск: pnpm --filter @orca-board/runtime test. Снимок показа при `done` (showcase-snapshot.ts) во временной папке:
// раскрытие папок, ассеты HTML, симлинки, лимиты, атомарность записи и чистка.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskStore, DEFAULT_COLUMNS, MAX_SHOWCASE_SNAPSHOT_FILES, MAX_SHOWCASE_SNAPSHOT_FILE_BYTES } from '@orca-board/core'
import {
  planShowcaseSnapshot, removeShowcaseDir, showcaseSnapshotDir, snapshotDispatchShowcase, writeShowcaseSnapshot
} from './fixtures/file-services.ts'

let tmp: string
let wt: string

function write(rel: string, data: string | Uint8Array = 'x'): void {
  mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true })
  writeFileSync(path.join(wt, rel), data)
}
const rels = (plan: { files: Array<{ rel: string }> }): string[] => plan.files.map((f) => f.rel).sort()

beforeEach(() => {
  fileServices()
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-snapshot-')))
  wt = path.join(tmp, 'wt')
  mkdirSync(wt)
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('planShowcaseSnapshot: заявленные файлы', () => {
  it('файлы из белого списка — точки входа по порядку сдачи; ./ и повтор схлопываются', () => {
    write('design/b.png')
    write('notes.md')
    const plan = planShowcaseSnapshot(wt, ['notes.md', './design/b.png', 'design/b.png'])
    assert.deepEqual(plan.entries, ['notes.md', 'design/b.png'])
    assert.deepEqual(rels(plan), ['design/b.png', 'notes.md'])
    assert.equal(plan.bytes, 2)
  })

  it('нет файла, чужой тип, скрытый путь — ошибка с подсказкой агенту', () => {
    write('run.sh')
    write('.env.png')
    assert.throws(() => planShowcaseSnapshot(wt, ['nope.png']), /не найден в worktree задачи.*--show/)
    assert.throws(() => planShowcaseSnapshot(wt, ['run.sh']), /такой тип приложение не показывает — разрешены .*\.png/)
    assert.throws(() => planShowcaseSnapshot(wt, ['.env.png']), /скрытые файлы/)
  })

  it('ассет, заявленный явно, попадает в снимок, но не в список для человека', () => {
    write('a.html', '<p>')
    write('style.css', 'p{}')
    const plan = planShowcaseSnapshot(wt, ['a.html', 'style.css'])
    assert.deepEqual(plan.entries, ['a.html'])
    assert.deepEqual(rels(plan), ['a.html', 'style.css'])
  })

  it('симлинк наружу и симлинк на чужой тип — отказ; симлинк внутри на картинку — можно', () => {
    const outside = path.join(tmp, 'outside.png')
    writeFileSync(outside, 'secret')
    symlinkSync(outside, path.join(wt, 'out.png'))
    write('run.sh')
    symlinkSync(path.join(wt, 'run.sh'), path.join(wt, 'fake.png'))
    write('real.png')
    symlinkSync(path.join(wt, 'real.png'), path.join(wt, 'alias.png'))
    mkdirSync(path.join(tmp, 'outdir'))
    writeFileSync(path.join(tmp, 'outdir', 'x.png'), 'x')
    symlinkSync(path.join(tmp, 'outdir'), path.join(wt, 'linkdir'))
    assert.throws(() => planShowcaseSnapshot(wt, ['out.png']), /за пределы репозитория/)
    assert.throws(() => planShowcaseSnapshot(wt, ['linkdir/x.png']), /за пределы репозитория/)
    assert.throws(() => planShowcaseSnapshot(wt, ['fake.png']), /такой тип/)
    const plan = planShowcaseSnapshot(wt, ['alias.png'])
    assert.deepEqual(plan.entries, ['alias.png'])
    assert.equal(plan.files[0].src, path.join(wt, 'real.png'))
  })

  it('лимиты: файл больше предела и файлов больше предела — ошибка', () => {
    write('big.png', new Uint8Array(MAX_SHOWCASE_SNAPSHOT_FILE_BYTES + 1))
    assert.throws(() => planShowcaseSnapshot(wt, ['big.png']), /больше 25 МБ/)
    for (let i = 0; i <= MAX_SHOWCASE_SNAPSHOT_FILES; i++) write(`shots/${String(i).padStart(3, '0')}.png`)
    assert.throws(() => planShowcaseSnapshot(wt, ['shots']), new RegExp(`больше ${MAX_SHOWCASE_SNAPSHOT_FILES} файлов`))
  })
})

describe('planShowcaseSnapshot: папка', () => {
  it('раскрывается по порядку имён: точки входа — в список, ассеты — в снимок; без скрытых, node_modules, симлинков и чужих типов', () => {
    write('design/b.html', '<p>B</p>')
    write('design/a.html', '<p>A</p>')
    write('design/sub/c.png')
    write('design/css/site.css', 'p{}')
    write('design/.secret.md')
    write('design/.git/x.png')
    write('design/node_modules/lib/x.png')
    write('design/tool.sh')
    write('design/README')
    symlinkSync(path.join(wt, 'design/a.html'), path.join(wt, 'design/link.html'))
    const plan = planShowcaseSnapshot(wt, ['design/'])
    assert.deepEqual(plan.entries, ['design/a.html', 'design/b.html', 'design/sub/c.png'])
    assert.deepEqual(rels(plan), ['design/a.html', 'design/b.html', 'design/css/site.css', 'design/sub/c.png'])
  })

  it('в папке нечего показать — ошибка', () => {
    write('src/a.ts')
    assert.throws(() => planShowcaseSnapshot(wt, ['src']), /нет файлов для показа/)
  })
})

describe('planShowcaseSnapshot: ассеты HTML', () => {
  it('каталог страницы и её ссылки ../ внутри репозитория — в снимке; вне репозитория и внешние адреса — нет', () => {
    writeFileSync(path.join(tmp, 'x.css'), 'outside')
    write('assets/x.css', "@import './base.css'; body{background:url(\"../img/bg.png?v=1\")}")
    write('assets/base.css', '')
    write('img/bg.png')
    write('assets/unused.css')
    write('mock/css/site.css')
    write('mock/img/logo.svg')
    write('mock/other.html')
    write('mock/index.html', [
      '<link rel="stylesheet" href="../assets/x.css">',
      '<link href="../../x.css" rel="stylesheet">',
      '<script src="https://cdn.example.com/a.js"></script>',
      '<img src="data:image/png;base64,AA==">',
      '<a href="#top">top</a>',
      '<img src="/etc/passwd.png">',
      '<script src="../run.sh"></script>'
    ].join('\n'))
    write('run.sh')
    const plan = planShowcaseSnapshot(wt, ['mock/index.html'])
    assert.deepEqual(plan.entries, ['mock/index.html'])
    assert.deepEqual(rels(plan), [
      'assets/base.css', 'assets/x.css', 'img/bg.png', 'mock/css/site.css', 'mock/img/logo.svg', 'mock/index.html', 'mock/other.html'
    ])
  })

  it('страница в корне репозитория весь репозиторий не тянет — только свои ссылки', () => {
    write('index.html', '<link href="style.css" rel="stylesheet">')
    write('style.css')
    write('docs/a.md')
    assert.deepEqual(rels(planShowcaseSnapshot(wt, ['index.html'])), ['index.html', 'style.css'])
  })

  it('ассеты сверх лимита пропускаются молча: заявленное снимается', () => {
    write('mock/a.html')
    for (let i = 0; i < MAX_SHOWCASE_SNAPSHOT_FILES + 5; i++) write(`mock/img/${String(i).padStart(3, '0')}.png`)
    const plan = planShowcaseSnapshot(wt, ['mock/a.html'])
    assert.equal(plan.files.length, MAX_SHOWCASE_SNAPSHOT_FILES)
    assert.deepEqual(plan.entries, ['mock/a.html'])
  })
})

describe('planShowcaseSnapshot: картинки markdown и описания', () => {
  it('md-файл показа тянет свои картинки: ![](path), <путь с пробелами>, заголовок, [id]: path, <img src>', () => {
    write('docs/shots/a.png')
    write('docs/shots/b c.png')
    write('docs/shots/d.png')
    write('docs/shots/e.svg')
    write('img/up.png')
    write('docs/shots/unused.png')
    write('docs/other.md', '![x](shots/unused.png)')
    write('docs/README.md', [
      '# Варианты',
      '![A](shots/a.png)',
      '![B](<shots/b c.png> "Вариант B")',
      '![D][d]',
      '[d]: shots/d.png',
      '<img src="shots/e.svg" width="200">',
      '![вверх](../img/up.png)',
      '![внешняя](https://example.com/x.png) ![data](data:image/png;base64,AA==) ![abs](/etc/x.png)',
      '![вне](../../x.png) ![скрытая](.git/x.png) ![скрипт](../run.sh)',
      '[другой md](other.md)'
    ].join('\n'))
    write('run.sh')
    const plan = planShowcaseSnapshot(wt, ['docs/README.md'])
    assert.deepEqual(plan.entries, ['docs/README.md'], 'картинки — ассеты снимка, не точки входа')
    assert.deepEqual(rels(plan), ['docs/README.md', 'docs/shots/a.png', 'docs/shots/b c.png', 'docs/shots/d.png', 'docs/shots/e.svg', 'img/up.png'])
  })

  it('описание показа (text): картинки от корня репозитория — в снимке; нет файла — молча пропускается', () => {
    write('design/a.png')
    write('design/b.png')
    write('notes.md')
    const plan = planShowcaseSnapshot(wt, ['notes.md'], '## Варианты\n![A](design/a.png)\n![B](./design/b.png)\n![нет](design/nope.png)')
    assert.deepEqual(plan.entries, ['notes.md'])
    assert.deepEqual(rels(plan), ['design/a.png', 'design/b.png', 'notes.md'])
    // Только описание, без --show: картинки всё равно снимаются, точек входа нет.
    const textOnly = planShowcaseSnapshot(wt, [], '![A](design/a.png)')
    assert.deepEqual(textOnly.entries, [])
    assert.deepEqual(rels(textOnly), ['design/a.png'])
  })
})

describe('writeShowcaseSnapshot', () => {
  it('копирует во временную папку; commit ставит на место, заменяя прежний снимок', () => {
    write('design/a.html', '<p>A</p>')
    write('design/css/s.css', 'p{}')
    const dest = path.join(tmp, 'showcase', 'p', 'r', 'd')
    mkdirSync(dest, { recursive: true })
    writeFileSync(path.join(dest, 'old.png'), 'old')
    const prepared = writeShowcaseSnapshot(planShowcaseSnapshot(wt, ['design']), dest, 42)
    assert.deepEqual(prepared.files, ['design/a.html'])
    assert.deepEqual(prepared.snapshot, { at: 42, files: 2, bytes: 11 })
    assert.ok(existsSync(path.join(dest, 'old.png')), 'до commit прежний снимок на месте')
    prepared.commit()
    assert.equal(readFileSync(path.join(dest, 'design/css/s.css'), 'utf8'), 'p{}')
    assert.equal(existsSync(path.join(dest, 'old.png')), false)
    assert.deepEqual(readdirSync(path.dirname(dest)), ['d'], 'временной папки не осталось')
  })

  it('сбой копирования — ни половинного снимка, ни временной папки; discard убирает временную', () => {
    write('a.png')
    write('b.png')
    const dest = path.join(tmp, 'showcase', 'p', 'r', 'd')
    const plan = planShowcaseSnapshot(wt, ['a.png', 'b.png'])
    rmSync(path.join(wt, 'b.png'))
    assert.throws(() => writeShowcaseSnapshot(plan, dest), /не удалось снять показ/)
    assert.equal(existsSync(dest), false)
    assert.deepEqual(readdirSync(path.dirname(dest)), [])
    write('b.png')
    writeShowcaseSnapshot(plan, dest).discard()
    assert.deepEqual(readdirSync(path.dirname(dest)), [])
  })
})

describe('snapshotDispatchShowcase и чистка', () => {
  it('снимок в <root>/<проект>/<прогон>/<запуск>; нет worktree — ошибка агенту', () => {
    write('a.png')
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const run = store.createRun('цель')
    const t = store.createTask({ title: 'Макет', roleId: 'developer', runId: run.id })
    const d = store.startDispatch(t.id, 'pty_a')
    const snapshots = { root: path.join(tmp, 'showcase'), projectId: 'proj_1' }
    assert.throws(() => snapshotDispatchShowcase(store, snapshots, d.id, ['a.png']), /нет worktree/)
    store.updateTask(t.id, { worktree: wt })
    snapshotDispatchShowcase(store, snapshots, d.id, ['a.png'])!.commit()
    assert.ok(existsSync(path.join(showcaseSnapshotDir(snapshots.root, 'proj_1', run.id, d.id), 'a.png')))
    // Одно описание: картинки есть — снимок; картинок нет — снимка нет.
    write('shots/b.png')
    const prepared = snapshotDispatchShowcase(store, snapshots, d.id, [], '![B](shots/b.png)')
    assert.deepEqual(prepared?.files, [])
    assert.deepEqual(prepared?.snapshot.files, 1)
    prepared!.discard()
    assert.equal(snapshotDispatchShowcase(store, snapshots, d.id, [], 'без картинок'), undefined)
    assert.throws(() => showcaseSnapshotDir(snapshots.root, '../x', run.id, d.id), /недопустимый/)
  })

  it('нет worktree и только описание — не ошибка: картинки описания best-effort, снимка нет', () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const t = store.createTask({ title: 'Макет', roleId: 'developer' })
    const d = store.startDispatch(t.id, 'pty_a')
    const snapshots = { root: path.join(tmp, 'showcase'), projectId: 'proj_1' }
    assert.equal(snapshotDispatchShowcase(store, snapshots, d.id, [], '![A](a.png)'), undefined)
  })

  it('удаление глобальной задачи убирает её снимки, удаление проекта — все; нет папки — не ошибка', () => {
    const root = path.join(tmp, 'showcase')
    for (const dir of [showcaseSnapshotDir(root, 'p1', 'run_a', 'd1'), showcaseSnapshotDir(root, 'p1', 'run_b', 'd2'), showcaseSnapshotDir(root, 'p2', 'run_c', 'd3')]) {
      mkdirSync(dir, { recursive: true })
    }
    removeShowcaseDir(root, 'p1', 'run_a')
    assert.deepEqual(readdirSync(path.join(root, 'p1')), ['run_b'])
    removeShowcaseDir(root, 'p1')
    assert.deepEqual(readdirSync(root), ['p2'])
    removeShowcaseDir(root, 'p_missing', 'run_x')
  })
})
