// Запуск: pnpm --filter @orca-board/desktop test. Вкладка «Файлы» на настоящем git-репозитории во временной папке.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PROJECT_FILES_DIR_LIMIT, PROJECT_FILES_ERROR_CODES, type ProjectFilesListing } from '../shared/ipc'
import { listProjectDir, resolveProjectPath, splitSafeSegments, PROJECT_FILES_IGNORE_INPUT_LIMIT } from './project-files'
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
  // `.native`: на Windows обычный realpathSync оставляет короткое 8.3-имя (`RUNNER~1`), а код отдаёт полный путь.
  tmp = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'orca-files-')))
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
  it('files.badPath: абсолютный, `..`, пустой сегмент, NUL, не строка', async () => {
    for (const bad of ['/abs', 'a/../..', '..', './src', 'a//b', 'src/', 'a\0b', 42, {}]) {
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
    // `\\` на unix тоже обычный символ: такое имя отдаёт list, его должно быть можно раскрыть.
    assert.deepEqual(splitSafeSegments('d/a\\b', path.posix), ['d', 'a\\b'])
    for (const bad of ['/abs', 'a/../..', 'a//b', 'a\0b', 1, null, undefined]) throwsWith(() => splitSafeSegments(bad, path.posix), 'files.badPath')
    throwsWith(() => splitSafeSegments('x/.Git/y', path.posix), 'files.hidden')
  })

  it('win32: диски, `\\`, `:` и хвостовые точки у .git', () => {
    assert.deepEqual(splitSafeSegments('src/Мой файл.ts', path.win32), ['src', 'Мой файл.ts'])
    for (const bad of ['C:\\x', 'C:/x', 'C:x', '\\\\server\\share', '/x', 'a\\b', 'a\\..\\..\\x', 'file.txt:stream', 'a/../b']) {
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

// ---------- QA интеграции вкладки «Файлы»: сложные раскладки и то, что нашли при прогоне на живых данных ----------

/** Полный обход через `listProjectDir`, как раскроет дерево человек: пути файлов и симлинков, папки. */
async function walkTree(root: string, dir = ''): Promise<{ files: string[]; dirs: string[] }> {
  const files: string[] = []
  const dirs: string[] = []
  for (const e of (await listProjectDir(root, dir)).entries) {
    const p = dir ? `${dir}/${e.name}` : e.name
    if (e.kind !== 'dir') {
      files.push(p)
      continue
    }
    dirs.push(p)
    const sub = await walkTree(root, p)
    files.push(...sub.files)
    dirs.push(...sub.dirs)
  }
  return { files, dirs }
}

describe('QA: дерево и git', () => {
  it('полный обход совпадает с `git ls-files --cached --others --exclude-standard`: те же файлы, пустые папки видны', async () => {
    write(repo, '.gitignore', 'node_modules/\nout/\n*.log\n!keep.log\n/root-only.txt\n')
    write(repo, 'root-only.txt')
    write(repo, 'sub/root-only.txt')
    write(repo, 'sub/.gitignore', 'gen/\n*.tmp\n!important.tmp\n')
    write(repo, 'sub/gen/a.ts')
    write(repo, 'sub/a.tmp')
    write(repo, 'sub/important.tmp')
    write(repo, 'sub/deep/er/still/file.md')
    write(repo, 'sub/deep/gen/kept.txt')
    write(repo, 'node_modules/pkg/index.js')
    write(repo, 'apps/web/node_modules/pkg/index.js')
    write(repo, 'apps/web/src/main.tsx')
    write(repo, 'out/bundle.js')
    write(repo, 'keep.log')
    write(repo, 'drop.log')
    write(repo, '.git/info/exclude', 'private/\n')
    write(repo, 'private/notes.txt')
    write(repo, 'Документы проекта/план работ.md')
    write(repo, 'Документы проекта/вложенная папка/ещё файл.txt')
    write(repo, '.env.local')
    write(repo, 'tracked.log')
    git(repo, 'add', '-f', 'tracked.log')
    git(repo, 'commit', '-qm', 'tracked')
    mkdirSync(path.join(repo, 'empty-dir/nested-empty'), { recursive: true })
    symlinkSync('README.md', path.join(repo, 'link-to-readme'))
    write(repo, '.DS_Store')

    const expected = git(repo, '-c', 'core.quotepath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard')
      .split('\0')
      .filter((f) => f && !/(^|\/)\.DS_Store$/.test(f))
      .sort()
    const tree = await walkTree(repo)
    assert.deepEqual([...tree.files].sort(), expected)
    // git о пустых папках не знает, а дерево показывает то, что лежит на диске.
    assert.ok(tree.dirs.includes('empty-dir'))
    assert.ok(tree.dirs.includes('empty-dir/nested-empty'))
    assert.deepEqual((await listProjectDir(repo, 'empty-dir/nested-empty')).entries, [])
    // Игнорируемые папки не видны на любой глубине.
    assert.ok(!tree.dirs.some((d) => d.split('/').includes('node_modules') || d === 'out' || d === 'private' || d === 'sub/gen'))
  })

  it('игнорируемую папку, запрошенную напрямую (устаревшее состояние renderer), main не раскрывает: список пуст', async () => {
    write(repo, 'node_modules/pkg/index.js')
    write(repo, 'apps/web/node_modules/x/y.js')
    assert.deepEqual((await listProjectDir(repo, 'node_modules')).entries, [])
    assert.deepEqual((await listProjectDir(repo, 'node_modules/pkg')).entries, [])
    assert.deepEqual((await listProjectDir(repo, 'apps/web/node_modules')).entries, [])
  })

  it('без .gitignore node_modules виден, а папка больше лимита обрезается: первые записи по порядку и truncated', async () => {
    const plain = path.join(tmp, 'nm-plain')
    execFileSync('git', ['init', '-q', '-b', 'master', plain])
    for (let i = 0; i < PROJECT_FILES_DIR_LIMIT + 50; i += 1) mkdirSync(path.join(plain, 'node_modules', `pkg${String(i).padStart(5, '0')}`), { recursive: true })
    write(plain, 'src/a.ts')
    const root = await listProjectDir(plain, '')
    assert.deepEqual(names(root), ['node_modules', 'src'])
    const nm = await listProjectDir(plain, 'node_modules')
    assert.equal(nm.entries.length, PROJECT_FILES_DIR_LIMIT)
    assert.equal(nm.truncated, true)
    assert.equal(nm.entries[0].name, 'pkg00000')
    assert.equal(nm.entries[PROJECT_FILES_DIR_LIMIT - 1].name, `pkg${String(PROJECT_FILES_DIR_LIMIT - 1).padStart(5, '0')}`)
  })

  it(`больше ${PROJECT_FILES_IGNORE_INPUT_LIMIT} записей в папке: на вход check-ignore идёт не больше предела, ответ обрезан до ${PROJECT_FILES_DIR_LIMIT}`, async () => {
    const huge = path.join(repo, 'huge')
    mkdirSync(huge)
    for (let i = 0; i <= PROJECT_FILES_IGNORE_INPUT_LIMIT; i += 1) writeFileSync(path.join(huge, `h${String(i).padStart(6, '0')}`), '')
    const l = await listProjectDir(repo, 'huge')
    assert.equal(l.truncated, true)
    assert.equal(l.entries.length, PROJECT_FILES_DIR_LIMIT)
    assert.equal(l.entries[0].name, 'h000000')
  })
})

describe('QA: симлинки', () => {
  it('петля симлинков: полный обход завершается, list по петле — files.readFailed (ELOOP), а не зависание', async () => {
    symlinkSync('loop-b', path.join(repo, 'loop-a'))
    symlinkSync('loop-a', path.join(repo, 'loop-b'))
    symlinkSync('.', path.join(repo, 'self'))
    symlinkSync('..', path.join(repo, 'src', 'up'))
    const tree = await walkTree(repo)
    for (const n of ['loop-a', 'loop-b', 'self', 'src/up']) assert.ok(tree.files.includes(n), n)
    await assert.rejects(listProjectDir(repo, 'loop-a'), (e: unknown) => {
      assert.ok(e instanceof OrcaError && e.key === 'files.readFailed', String(e))
      assert.match(e.message, /ELOOP/)
      return true
    })
    // Симлинк на корень раскрыть можно, но он не уводит за корень и не ведёт в .git.
    assert.ok(names(await listProjectDir(repo, 'self')).includes('README.md'))
  })

  it('корень проекта, заданный через симлинк, читается; пути внутри проверяются по realpath', async () => {
    const viaLink = path.join(tmp, 'root-via-link')
    symlinkSync(repo, viaLink)
    assert.ok(names(await listProjectDir(viaLink, '')).includes('src'))
    assert.deepEqual(names(await listProjectDir(viaLink, 'src')), ['index.ts'])
    symlinkSync(tmp, path.join(repo, 'to-tmp'))
    await rejectsWith(listProjectDir(viaLink, 'to-tmp'), 'files.outside')
  })
})

describe('QA: странные имена', () => {
  it('кавычки, перевод строки, скобки, `*`, `#`, `!`: игнор по -z-выводу git совпадает точно, видимые имена целы', async () => {
    write(repo, '.gitignore', '*.log\n')
    const all = ['a"b', "it's", 'нов\nстрока', '[br]acket', '*star', '#hash', '!bang', '-dash', ' lead', 'x  y', '日本語', '🙂']
    // В Windows `"`, `*` и перевод строки в имени файла запрещены: такие файлы там не создать.
    const odd = process.platform === 'win32' ? all.filter((n) => !/["*:<>?|\n]/.test(n)) : all
    for (const n of odd) {
      write(repo, `${n}.txt`)
      write(repo, `${n}.log`)
    }
    const got = names(await listProjectDir(repo, ''))
    for (const n of odd) {
      assert.ok(got.includes(`${n}.txt`), `${JSON.stringify(n)}.txt должен быть виден`)
      assert.ok(!got.includes(`${n}.log`), `${JSON.stringify(n)}.log должен быть скрыт`)
    }
  })

  // В Windows `:` в имени файла запрещён: таких имён там не бывает, а создать их для теста нельзя.
  it('имя, начинающееся с pathspec-магии (`:!x`, `:^x`, `:(icase)x`), не отключает фильтр игнора всей папки', { skip: process.platform === 'win32' }, async () => {
    // Дефект QA: без префикса `./` git check-ignore читал такие имена как pathspec, выходил с 128 и папка уходила в фолбэк.
    write(repo, '.gitignore', '*.log\nout/\n')
    write(repo, ':!excl.txt')
    write(repo, ':^caret.txt')
    write(repo, ':(icase)x.txt')
    write(repo, ':!dir/keep.txt')
    write(repo, 'debug.log')
    write(repo, 'out/main.js')
    const got = names(await listProjectDir(repo, ''))
    assert.ok(got.includes(':!excl.txt'))
    assert.ok(got.includes(':^caret.txt'))
    assert.ok(got.includes(':(icase)x.txt'))
    assert.ok(got.includes(':!dir'))
    assert.ok(!got.includes('debug.log'), 'debug.log игнорируется git')
    assert.ok(!got.includes('out'), 'out/ игнорируется git')
  })

  it('всё, что отдал list, можно раскрыть и показать в папке (имя с `\\` на unix — обычный символ)', {
    skip: process.platform === 'win32'
  }, async () => {
    // Дефект QA: splitSafeSegments отклонял `\\` и на unix — строка в дереве есть, а раскрыть и показать нельзя.
    write(repo, 'back\\slash dir/inner.txt')
    write(repo, 'we\\ird.txt')
    for (const e of (await listProjectDir(repo, '')).entries) {
      await resolveProjectPath(repo, e.name, false)
      if (e.kind === 'dir') await listProjectDir(repo, e.name)
    }
  })
})
