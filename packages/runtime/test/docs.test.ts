import { fileServices } from './fixtures/file-services.ts'
// Запуск: pnpm --filter @orca-board/runtime test. Просмотрщик «Документы» на настоящем git-репозитории.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskStore, DEFAULT_COLUMNS } from '@orca-board/core'
import { DOC_MAX_BYTES, PROJECT_SOURCE, docSourceRoot, docTasks, listDocGroups, listProjectFiles, listWorktreeDocs, readDoc, resolveDocPath } from './fixtures/file-services.ts'
import { OrcaError } from './fixtures/file-services.ts'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()

let tmp: string
let repo: string

function write(root: string, rel: string, text = 'x\n'): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), text)
}

beforeEach(() => {
  fileServices()
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-docs-')))
  repo = path.join(tmp, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'master', repo])
  write(repo, '.gitignore', 'node_modules/\nout/\n')
  write(repo, 'README.md', '# readme\n')
  write(repo, 'docs/plan.md', '# план\n')
  write(repo, 'src/index.ts', 'export {}\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('resolveDocPath', () => {
  it('отдаёт .md внутри корня, в том числе через ./ и вложенные ..', () => {
    assert.equal(resolveDocPath(repo, 'docs/plan.md'), path.join(repo, 'docs/plan.md'))
    assert.equal(resolveDocPath(repo, './docs/../README.md'), path.join(repo, 'README.md'))
    assert.equal(readDoc(repo, 'README.md'), '# readme\n')
  })

  it('выход за корень через .. — ошибка', () => {
    write(tmp, 'secret.md')
    assert.throws(() => resolveDocPath(repo, '../secret.md'), /docs\.outside/)
    assert.throws(() => resolveDocPath(repo, 'docs/../../secret.md'), /docs\.outside/)
  })

  it('абсолютный путь — ошибка, даже внутри корня', () => {
    assert.throws(() => resolveDocPath(repo, path.join(repo, 'README.md')), /docs\.notRelative/)
  })

  it('не .md и мусор вместо пути — ошибка', () => {
    assert.throws(() => resolveDocPath(repo, 'src/index.ts'), /docs\.notMarkdown/)
    assert.throws(() => resolveDocPath(repo, '.git/config'), /docs\.notMarkdown/)
    assert.throws(() => resolveDocPath(repo, ''), /docs\.noPath/)
    assert.throws(() => resolveDocPath(repo, 42), /docs\.noPath/)
    assert.throws(() => resolveDocPath(repo, 'a.md\0.ts'), /docs\.noPath/)
  })

  it('симлинк наружу и симлинк .md на не-.md — ошибка', () => {
    write(tmp, 'outside.md')
    symlinkSync(path.join(tmp, 'outside.md'), path.join(repo, 'link.md'))
    symlinkSync(tmp, path.join(repo, 'dirlink'))
    symlinkSync(path.join(repo, 'src/index.ts'), path.join(repo, 'code.md'))
    assert.throws(() => resolveDocPath(repo, 'link.md'), /docs\.outside/)
    assert.throws(() => resolveDocPath(repo, 'dirlink/outside.md'), /docs\.outside/)
    assert.throws(() => resolveDocPath(repo, 'code.md'), /docs\.notMarkdown/)
  })

  it('каталог с именем .md, пропавший и слишком большой файл — ошибка', () => {
    mkdirSync(path.join(repo, 'dir.md'))
    assert.throws(() => resolveDocPath(repo, 'dir.md'), /docs\.notFile/)
    assert.throws(() => resolveDocPath(repo, 'nope.md'), /docs\.notFound/)
    write(repo, 'big.md', 'x'.repeat(DOC_MAX_BYTES + 1))
    assert.throws(() => resolveDocPath(repo, 'big.md'), /docs\.tooBig/)
  })
})

describe('listProjectFiles', () => {
  it('все файлы проекта, не только .md: отслеживаемые и новые, без игнорируемых и .git, свежие сверху', async () => {
    write(repo, 'notes/new.md')
    write(repo, 'UPPER.MD')
    write(repo, 'node_modules/pkg/index.js')
    write(repo, 'out/report.md')
    write(repo, 'notes/data.txt')
    write(repo, '.env', 'SECRET=1\n')
    write(repo, '.github/workflows/ci.yml')
    write(repo, 'img/logo.png', '\x89PNG')
    write(repo, 'docs/.DS_Store')
    const { files, truncated } = await listProjectFiles(repo)
    assert.equal(truncated, false)
    assert.deepEqual(files.map((d) => d.path).sort(), [
      '.env', '.github/workflows/ci.yml', '.gitignore', 'README.md', 'UPPER.MD', 'docs/plan.md', 'img/logo.png',
      'notes/data.txt', 'notes/new.md', 'src/index.ts'
    ])
    assert.equal(files.find((d) => d.path === 'notes/new.md')?.untracked, true)
    assert.equal(files.find((d) => d.path === 'src/index.ts')?.untracked, false)
    assert.ok(!files.some((d) => d.path.startsWith('.git/')))
    for (let i = 1; i < files.length; i++) assert.ok(files[i - 1].mtime >= files[i].mtime)
  })

  it('отслеживаемый, но игнорируемый файл виден (как в git status)', async () => {
    write(repo, 'out/keep.txt')
    git(repo, 'add', '-f', 'out/keep.txt')
    write(repo, 'out/skip.txt')
    const paths = (await listProjectFiles(repo)).files.map((d) => d.path)
    assert.ok(paths.includes('out/keep.txt'))
    assert.ok(!paths.includes('out/skip.txt'))
  })

  it('симлинк на файл — link с размером цели; наружу и битый видны; на папку — нет', async () => {
    write(repo, 'big.txt', 'x'.repeat(100))
    write(tmp, 'outside.txt')
    symlinkSync(path.join(repo, 'big.txt'), path.join(repo, 'alias.txt'))
    symlinkSync(path.join(tmp, 'outside.txt'), path.join(repo, 'out-link.txt'))
    symlinkSync(path.join(repo, 'nope.txt'), path.join(repo, 'broken.txt'))
    symlinkSync(path.join(repo, 'src'), path.join(repo, 'srclink'))
    symlinkSync(tmp, path.join(repo, 'tmplink'))
    const files = (await listProjectFiles(repo)).files
    const alias = files.find((d) => d.path === 'alias.txt')
    assert.equal(alias?.link, true)
    assert.equal(alias?.size, 100)
    assert.equal(files.find((d) => d.path === 'out-link.txt')?.link, true)
    assert.equal(files.find((d) => d.path === 'broken.txt')?.link, true)
    assert.equal(files.find((d) => d.path === 'big.txt')?.link, undefined)
    assert.ok(!files.some((d) => d.path.startsWith('srclink') || d.path.startsWith('tmplink')))
  })

  it('удалённый с диска отслеживаемый файл и подмодуль-папка не попадают', async () => {
    rmSync(path.join(repo, 'docs/plan.md'))
    const sub = path.join(tmp, 'sub')
    execFileSync('git', ['init', '-q', '-b', 'master', sub])
    write(sub, 'a.txt')
    git(sub, 'add', '-A')
    git(sub, 'commit', '-qm', 'sub')
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub')
    const paths = (await listProjectFiles(repo)).files.map((d) => d.path)
    assert.ok(!paths.includes('docs/plan.md'))
    assert.ok(!paths.some((p) => p.startsWith('vendor/sub')))
    assert.ok(paths.includes('.gitmodules'))
  })

  it('больше лимита — первые limit и truncated', async () => {
    for (let i = 0; i < 10; i++) write(repo, `many/f${i}.txt`)
    const full = await listProjectFiles(repo)
    assert.equal(full.truncated, false)
    const cut = await listProjectFiles(repo, 5)
    assert.equal(cut.truncated, true)
    assert.equal(cut.files.length, 5)
    const groups = await listDocGroups(repo, 'master', [], 5)
    assert.equal(groups[0].truncated, true)
    assert.equal((await listDocGroups(repo, 'master', []))[0].truncated, undefined)
  })

  it('при обрезке отслеживаемые в приоритете: git отдаёт неотслеживаемые первыми', async () => {
    // В репозитории 4 отслеживаемых (.gitignore, README.md, docs/plan.md, src/index.ts) и 3 неотслеживаемых.
    write(repo, '.env', 'SECRET=1\n')
    write(repo, 'tmp/a.log')
    write(repo, 'tmp/b.log')
    const cut = await listProjectFiles(repo, 3)
    assert.equal(cut.truncated, true)
    assert.equal(cut.files.length, 3)
    assert.ok(cut.files.every((f) => !f.untracked))
    const paths = (await listProjectFiles(repo, 5)).files.map((d) => d.path).sort()
    assert.deepEqual(paths.filter((p) => !['.env', 'tmp/a.log', 'tmp/b.log'].includes(p)), ['.gitignore', 'README.md', 'docs/plan.md', 'src/index.ts'])
    assert.equal(paths.length, 5)
  })

  it('без git — обход папок без .git, node_modules и шума ОС, с лимитом', async () => {
    const plain = path.join(tmp, 'plain')
    write(plain, 'a.md')
    write(plain, 'src/b.ts')
    write(plain, 'node_modules/x/index.js')
    write(plain, '.git/config')
    write(plain, '.env')
    write(plain, 'Thumbs.db')
    symlinkSync(path.join(plain, 'src'), path.join(plain, 'srclink'))
    const { files, truncated } = await listProjectFiles(plain)
    assert.equal(truncated, false)
    assert.deepEqual(files.map((d) => d.path).sort(), ['.env', 'a.md', 'src/b.ts'])
    assert.ok(files.every((d) => !d.untracked))
    const cut = await listProjectFiles(plain, 2)
    assert.equal(cut.truncated, true)
    assert.equal(cut.files.length, 2)
  })
})

describe('docSourceRoot', () => {
  const noSource = (e: unknown): boolean => e instanceof OrcaError && e.key === 'docs.noTaskSource'

  it('проект, задача в работе с worktree; done, без worktree, удалённый worktree и чужой id — docs.noTaskSource', () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const wt = path.join(tmp, 'wt')
    mkdirSync(wt)
    const working = store.createTask({ title: 'в работе' })
    store.updateTask(working.id, { status: store.columnId('in_progress'), worktree: wt })
    const done = store.createTask({ title: 'готова' })
    store.updateTask(done.id, { status: store.columnId('done'), worktree: wt })
    const bare = store.createTask({ title: 'без worktree' })
    store.updateTask(bare.id, { status: store.columnId('in_progress') })
    const gone = store.createTask({ title: 'worktree удалён' })
    store.updateTask(gone.id, { status: store.columnId('in_progress'), worktree: path.join(tmp, 'нет') })

    const tasks = docTasks(store)
    assert.deepEqual(tasks.map((t) => t.id), [working.id])
    assert.equal(docSourceRoot(PROJECT_SOURCE, repo, tasks), repo)
    assert.equal(docSourceRoot(working.id, repo, tasks), wt)
    for (const id of [done.id, bare.id, gone.id, 'task_чужая', '', 42, undefined]) {
      assert.throws(() => docSourceRoot(id, repo, tasks), noSource, String(id))
    }
  })
})

describe('listWorktreeDocs', () => {
  it('только .md, изменённые в ветке задачи: коммиты, правки и новые файлы', async () => {
    const wt = path.join(tmp, 'wt')
    git(repo, 'worktree', 'add', '-q', '-b', 'orca/t1', wt)
    write(wt, 'docs/committed.md')
    write(wt, 'src/code.ts')
    git(wt, 'add', '-A')
    git(wt, 'commit', '-qm', 'task')
    write(wt, 'README.md', '# правка\n')
    write(wt, 'fresh.md')
    // Изменения в master после ответвления в список задачи не попадают.
    write(repo, 'master-only.md')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'master')

    const docs = (await listWorktreeDocs(wt, 'master'))
    assert.deepEqual(docs.map((d) => d.path).sort(), ['README.md', 'docs/committed.md', 'fresh.md'])
    assert.equal(docs.find((d) => d.path === 'fresh.md')?.untracked, true)
    assert.equal(docs.find((d) => d.path === 'docs/committed.md')?.untracked, false)

    const groups = await listDocGroups(repo, 'master', [
      { id: 't1', title: 'Задача', worktree: wt, branch: 'orca/t1' },
      { id: 't2', title: 'Без .md', worktree: path.join(tmp, 'нет'), branch: 'orca/t2' }
    ])
    assert.deepEqual(groups.map((g) => [g.source, g.title]), [['project', 'Проект'], ['t1', 'Задача']])
    assert.ok(groups[0].files.some((f) => f.path === 'master-only.md'))
  })
})

describe('репозиторий без коммитов', () => {
  it('listDocGroups с unborn-корнем и unborn-worktree не падает, новые .md видны', async () => {
    const empty = path.join(tmp, 'empty')
    execFileSync('git', ['init', '-q', '-b', 'main', empty])
    write(empty, 'notes.md')
    write(empty, 'staged.md')
    git(empty, 'add', 'staged.md')

    assert.deepEqual((await listWorktreeDocs(empty, 'main')).map((d) => d.path), ['notes.md'])
    const groups = await listDocGroups(empty, 'main', [{ id: 't1', title: 'Задача', worktree: empty, branch: 'main' }])
    assert.deepEqual(groups.map((g) => g.source), ['project', 't1'])
    assert.ok(groups[0].files.some((f) => f.path === 'notes.md'))
  })
})
