// Запуск: pnpm --filter @orca-board/desktop test. Вкладка «Файлы» на настоящем git-репозитории во временной папке.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PROJECT_FILES_DIR_LIMIT, PROJECT_FILES_ERROR_CODES, type ProjectFilesListing } from '../shared/ipc'
import { listProjectDir, resolveProjectPath, splitSafeSegments } from './project-files'
import { gitCheckIgnore } from './git'
import { OrcaError } from './i18n'
import ru from './strings/ru'
import en from './strings/en'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()

let tmp: string
let repo: string

function write(root: string, rel: string, text = 'x\n'): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), text)
}

const names = (l: ProjectFilesListing): string[] => l.entries.map((e) => e.name)
const kindOf = (l: ProjectFilesListing, name: string): string | undefined => l.entries.find((e) => e.name === name)?.kind

/** Отказ с кодом `code` (ключ словаря main): распознаём по коду, а не по тексту. */
async function rejectsWith(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => e instanceof OrcaError && e.key === code)
}

function throwsWith(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => e instanceof OrcaError && e.key === code)
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-files-')))
  repo = path.join(tmp, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'master', repo])
  write(repo, '.gitignore', 'node_modules/\nout/\n*.log\n!keep.log\n')
  write(repo, 'README.md', '# readme\n')
  write(repo, 'src/index.ts', 'export {}\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('listProjectDir: порядок', () => {
  it('папки сверху, затем файлы и симлинки; numeric-сортировка без учёта регистра', async () => {
    write(repo, 'file10.txt')
    write(repo, 'file2.txt')
    write(repo, 'B.txt')
    write(repo, 'a.txt')
    mkdirSync(path.join(repo, 'zdir'))
    mkdirSync(path.join(repo, 'Adir'))
    symlinkSync('a.txt', path.join(repo, 'c-link'))
    const l = await listProjectDir(repo, '')
    assert.equal(l.dir, '')
    assert.equal(l.truncated, false)
    assert.deepEqual(names(l), ['Adir', 'src', 'zdir', '.gitignore', 'a.txt', 'B.txt', 'c-link', 'file2.txt', 'file10.txt', 'README.md'])
    assert.equal(kindOf(l, 'src'), 'dir')
    assert.equal(kindOf(l, 'a.txt'), 'file')
    assert.equal(kindOf(l, 'c-link'), 'symlink')
  })

  it('dir опущен — корень; вложенная папка — эхо запроса', async () => {
    assert.ok(names(await listProjectDir(repo)).includes('src'))
    const l = await listProjectDir(repo, 'src')
    assert.equal(l.dir, 'src')
    assert.deepEqual(names(l), ['index.ts'])
  })

  it('имена с кириллицей и пробелами', async () => {
    write(repo, 'Документы проекта/план работ.md')
    const root = await listProjectDir(repo, '')
    // APFS может отдать имя в NFD — сравниваем нормализованно.
    assert.ok(names(root).some((n) => n.normalize('NFC') === 'Документы проекта'))
    const dirName = names(root).find((n) => n.normalize('NFC') === 'Документы проекта') ?? ''
    const inner = await listProjectDir(repo, dirName)
    assert.deepEqual(names(inner).map((n) => n.normalize('NFC')), ['план работ.md'])
  })
})

describe('listProjectDir: скрытое', () => {
  it('.git (папка и файл-указатель), .DS_Store, Thumbs.db, desktop.ini не отдаются; точечные файлы видны', async () => {
    write(repo, '.DS_Store')
    write(repo, 'Thumbs.db')
    write(repo, 'desktop.ini')
    write(repo, '.env.local')
    write(repo, '.github/workflows/ci.yml')
    write(repo, 'sub/.git', 'gitdir: ../.git/worktrees/x\n')
    write(repo, 'sub/a.txt')
    const l = await listProjectDir(repo, '')
    assert.ok(!names(l).includes('.git'))
    for (const n of ['.DS_Store', 'Thumbs.db', 'desktop.ini']) assert.ok(!names(l).includes(n), n)
    assert.ok(names(l).includes('.env.local'))
    assert.ok(names(l).includes('.github'))
    assert.deepEqual(names(await listProjectDir(repo, 'sub')), ['a.txt'])
  })

  it('запрос внутрь .git в любом регистре — files.hidden', async () => {
    await rejectsWith(listProjectDir(repo, '.git'), 'files.hidden')
    await rejectsWith(listProjectDir(repo, '.GIT'), 'files.hidden')
    await rejectsWith(listProjectDir(repo, 'a/.git'), 'files.hidden')
    await rejectsWith(listProjectDir(repo, '.git/objects'), 'files.hidden')
  })

  it('симлинк на .git внутри корня — files.hidden', async () => {
    symlinkSync('.git', path.join(repo, 'gitlink'))
    await rejectsWith(listProjectDir(repo, 'gitlink'), 'files.hidden')
  })
})

describe('listProjectDir: игнорируемое git', () => {
  it('.gitignore: папка node_modules/, *.log, отрицание !keep.log', async () => {
    write(repo, 'node_modules/pkg/index.js')
    write(repo, 'out/main.js')
    write(repo, 'debug.log')
    write(repo, 'keep.log')
    write(repo, 'src/trace.log')
    const l = await listProjectDir(repo, '')
    assert.ok(!names(l).includes('node_modules'))
    assert.ok(!names(l).includes('out'))
    assert.ok(!names(l).includes('debug.log'))
    assert.ok(names(l).includes('keep.log'))
    assert.deepEqual(names(await listProjectDir(repo, 'src')), ['index.ts'])
  })

  it('шаблон `name/` действует только на папки: файл с тем же именем виден', async () => {
    write(repo, 'out')
    assert.ok(names(await listProjectDir(repo, '')).includes('out'))
  })

  it('вложенный .gitignore и .git/info/exclude', async () => {
    write(repo, 'pkg/.gitignore', 'generated/\n')
    write(repo, 'pkg/generated/x.ts')
    write(repo, 'pkg/main.ts')
    write(repo, 'generated/root.ts')
    write(repo, '.git/info/exclude', 'secret.txt\n')
    write(repo, 'secret.txt')
    const root = await listProjectDir(repo, '')
    assert.ok(names(root).includes('generated'), 'вложенное правило не действует выше своей папки')
    assert.ok(!names(root).includes('secret.txt'))
    assert.deepEqual(names(await listProjectDir(repo, 'pkg')), ['.gitignore', 'main.ts'])
  })

  it('отслеживаемый файл под правилом игнора остаётся видимым, как в git status', async () => {
    write(repo, 'tracked.log')
    git(repo, 'add', '-f', 'tracked.log')
    git(repo, 'commit', '-qm', 'tracked')
    write(repo, 'untracked.log')
    const l = await listProjectDir(repo, '')
    assert.ok(names(l).includes('tracked.log'))
    assert.ok(!names(l).includes('untracked.log'))
  })

  it('не репозиторий — фолбэк без исключения: скрыт только node_modules', async () => {
    const plain = path.join(tmp, 'plain')
    write(plain, 'node_modules/x.js')
    write(plain, 'debug.log')
    write(plain, 'a.txt')
    write(plain, '.DS_Store')
    const l = await listProjectDir(plain, '')
    assert.deepEqual(names(l), ['a.txt', 'debug.log'])
  })

  it('gitCheckIgnore: код 1 — пустое множество, 128 — ошибка, папки с `/`', async () => {
    assert.deepEqual([...(await gitCheckIgnore(repo, ['README.md']))], [])
    assert.deepEqual([...(await gitCheckIgnore(repo, []))], [])
    write(repo, 'node_modules/x.js')
    assert.deepEqual([...(await gitCheckIgnore(repo, ['node_modules/', 'README.md', 'a b.log']))].sort(), ['a b.log', 'node_modules/'])
    const plain = path.join(tmp, 'plain2')
    mkdirSync(plain)
    await assert.rejects(gitCheckIgnore(plain, ['x']), (e: unknown) => e instanceof OrcaError && e.key === 'git.opFailed')
  })
})

describe('listProjectDir: симлинки', () => {
  it('на файл, на папку, битый и за корень — kind symlink, не раскрываются', async () => {
    mkdirSync(path.join(tmp, 'outside'))
    write(tmp, 'outside/secret.txt')
    symlinkSync('README.md', path.join(repo, 'l-file'))
    symlinkSync('src', path.join(repo, 'l-dir'))
    symlinkSync('nope', path.join(repo, 'l-broken'))
    symlinkSync(path.join(tmp, 'outside'), path.join(repo, 'l-out'))
    const l = await listProjectDir(repo, '')
    for (const n of ['l-file', 'l-dir', 'l-broken', 'l-out']) assert.equal(kindOf(l, n), 'symlink', n)
    await rejectsWith(listProjectDir(repo, 'l-out'), 'files.outside')
    await rejectsWith(listProjectDir(repo, 'l-broken'), 'files.notFound')
    // Симлинк на папку внутри корня main читать разрешает (раскрывать его или нет — решает UI).
    assert.deepEqual(names(await listProjectDir(repo, 'l-dir')), ['index.ts'])
  })
})

describe('listProjectDir: ошибки', () => {
  it('files.badPath: абсолютный, `\\`, `..`, пустой сегмент, NUL, не строка', async () => {
    for (const bad of ['/abs', 'a\\b', 'a/../..', '..', './src', 'a//b', 'src/', 'a\0b', 42, {}]) {
      await rejectsWith(listProjectDir(repo, bad), 'files.badPath')
    }
  })

  it('files.notFound, files.notDir, files.rootMissing', async () => {
    await rejectsWith(listProjectDir(repo, 'nope'), 'files.notFound')
    await rejectsWith(listProjectDir(repo, 'README.md/x'), 'files.notFound')
    await rejectsWith(listProjectDir(repo, 'README.md'), 'files.notDir')
    await rejectsWith(listProjectDir(path.join(tmp, 'gone'), ''), 'files.rootMissing')
  })

  it('files.readFailed — папка без прав (только unix), без абсолютного пути в тексте', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
    mkdirSync(path.join(repo, 'locked'))
    chmodSync(path.join(repo, 'locked'), 0o000)
    try {
      await assert.rejects(listProjectDir(repo, 'locked'), (e: unknown) => {
        assert.ok(e instanceof OrcaError && e.key === 'files.readFailed')
        assert.ok(!e.message.includes(tmp), e.message)
        assert.match(e.message, /EACCES/)
        return true
      })
    } finally {
      chmodSync(path.join(repo, 'locked'), 0o755)
    }
  })
})

describe('listProjectDir: лимит', () => {
  it(`${PROJECT_FILES_DIR_LIMIT + 1} файлов — отдаются первые ${PROJECT_FILES_DIR_LIMIT}, truncated`, async () => {
    const big = path.join(repo, 'big')
    mkdirSync(big)
    for (let i = 0; i <= PROJECT_FILES_DIR_LIMIT; i += 1) writeFileSync(path.join(big, `f${i}`), '')
    const l = await listProjectDir(repo, 'big')
    assert.equal(l.entries.length, PROJECT_FILES_DIR_LIMIT)
    assert.equal(l.truncated, true)
    assert.equal(l.entries[0].name, 'f0')
    assert.equal(l.entries[2].name, 'f2')
  })
})

describe('resolveProjectPath (files:reveal)', () => {
  it('те же правила пути; последний симлинк не разворачивается', async () => {
    symlinkSync(path.join(tmp), path.join(repo, 'l-out'))
    assert.equal(await resolveProjectPath(repo, 'l-out', false), path.join(repo, 'l-out'))
    assert.equal(await resolveProjectPath(repo, 'src/index.ts', false), path.join(repo, 'src/index.ts'))
    assert.equal(await resolveProjectPath(repo, '', false), repo)
    await rejectsWith(resolveProjectPath(repo, 'l-out/repo', false), 'files.outside')
    await rejectsWith(resolveProjectPath(repo, '../repo', false), 'files.badPath')
    await rejectsWith(resolveProjectPath(repo, '/etc', false), 'files.badPath')
    await rejectsWith(resolveProjectPath(repo, '.git/config', false), 'files.hidden')
    await rejectsWith(resolveProjectPath(repo, 'nope.txt', false), 'files.notFound')
  })
})

describe('splitSafeSegments', () => {
  it('posix: корень, сегменты, отказы', () => {
    assert.deepEqual(splitSafeSegments(''), [])
    assert.deepEqual(splitSafeSegments('a/b c/д'), ['a', 'b c', 'д'])
    // `:` на unix — обычный символ имени.
    assert.deepEqual(splitSafeSegments('a:b', path.posix), ['a:b'])
    for (const bad of ['/abs', 'a\\b', 'a/../..', 'a//b', 'a\0b', 1, null, undefined]) throwsWith(() => splitSafeSegments(bad, path.posix), 'files.badPath')
    throwsWith(() => splitSafeSegments('x/.Git/y', path.posix), 'files.hidden')
  })

  it('win32: диски, `\\`, `:` и хвостовые точки у .git', () => {
    assert.deepEqual(splitSafeSegments('src/Мой файл.ts', path.win32), ['src', 'Мой файл.ts'])
    for (const bad of ['C:\\x', 'C:/x', 'C:x', '\\\\server\\share', '/x', 'a\\..\\..\\x', 'file.txt:stream', 'a/../b']) {
      throwsWith(() => splitSafeSegments(bad, path.win32), 'files.badPath')
    }
    throwsWith(() => splitSafeSegments('.git.', path.win32), 'files.hidden')
    throwsWith(() => splitSafeSegments('.GIT ', path.win32), 'files.hidden')
  })
})

describe('тексты ошибок', () => {
  it('каждый код PROJECT_FILES_ERROR_CODES есть в словарях main ru и en', () => {
    for (const code of PROJECT_FILES_ERROR_CODES) {
      assert.ok(code in ru, `ru: ${code}`)
      assert.ok(code in en, `en: ${code}`)
    }
  })
})
