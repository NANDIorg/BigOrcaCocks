// Запуск: pnpm --filter @orca-board/desktop test. Просмотрщик «Документы» на настоящем git-репозитории.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DOC_MAX_BYTES, listDocGroups, listProjectDocs, listWorktreeDocs, readDoc, resolveDocPath } from './docs'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()

let tmp: string
let repo: string

function write(root: string, rel: string, text = 'x\n'): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), text)
}

beforeEach(() => {
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
    assert.throws(() => resolveDocPath(repo, '../secret.md'), /вне проекта/)
    assert.throws(() => resolveDocPath(repo, 'docs/../../secret.md'), /вне проекта/)
  })

  it('абсолютный путь — ошибка, даже внутри корня', () => {
    assert.throws(() => resolveDocPath(repo, path.join(repo, 'README.md')), /относительным/)
  })

  it('не .md и мусор вместо пути — ошибка', () => {
    assert.throws(() => resolveDocPath(repo, 'src/index.ts'), /не markdown/)
    assert.throws(() => resolveDocPath(repo, '.git/config'), /не markdown/)
    assert.throws(() => resolveDocPath(repo, ''), /не задан/)
    assert.throws(() => resolveDocPath(repo, 42), /не задан/)
    assert.throws(() => resolveDocPath(repo, 'a.md\0.ts'), /не задан/)
  })

  it('симлинк наружу и симлинк .md на не-.md — ошибка', () => {
    write(tmp, 'outside.md')
    symlinkSync(path.join(tmp, 'outside.md'), path.join(repo, 'link.md'))
    symlinkSync(tmp, path.join(repo, 'dirlink'))
    symlinkSync(path.join(repo, 'src/index.ts'), path.join(repo, 'code.md'))
    assert.throws(() => resolveDocPath(repo, 'link.md'), /вне проекта/)
    assert.throws(() => resolveDocPath(repo, 'dirlink/outside.md'), /вне проекта/)
    assert.throws(() => resolveDocPath(repo, 'code.md'), /не markdown/)
  })

  it('каталог с именем .md, пропавший и слишком большой файл — ошибка', () => {
    mkdirSync(path.join(repo, 'dir.md'))
    assert.throws(() => resolveDocPath(repo, 'dir.md'), /не файл/)
    assert.throws(() => resolveDocPath(repo, 'nope.md'), /не найден/)
    write(repo, 'big.md', 'x'.repeat(DOC_MAX_BYTES + 1))
    assert.throws(() => resolveDocPath(repo, 'big.md'), /больше/)
  })
})

describe('listProjectDocs', () => {
  it('отслеживаемые и неотслеживаемые .md без игнорируемых, свежие сверху', () => {
    write(repo, 'notes/new.md')
    write(repo, 'UPPER.MD')
    write(repo, 'node_modules/pkg/README.md')
    write(repo, 'out/report.md')
    write(repo, 'notes/data.txt')
    symlinkSync(path.join(repo, 'README.md'), path.join(repo, 'alias.md'))
    const docs = listProjectDocs(repo)
    assert.deepEqual(docs.map((d) => d.path).sort(), ['README.md', 'UPPER.MD', 'docs/plan.md', 'notes/new.md'])
    assert.equal(docs.find((d) => d.path === 'notes/new.md')?.untracked, true)
    assert.equal(docs.find((d) => d.path === 'README.md')?.untracked, false)
    for (let i = 1; i < docs.length; i++) assert.ok(docs[i - 1].mtime >= docs[i].mtime)
  })
})

describe('listWorktreeDocs', () => {
  it('только .md, изменённые в ветке задачи: коммиты, правки и новые файлы', () => {
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

    const docs = listWorktreeDocs(wt, 'master')
    assert.deepEqual(docs.map((d) => d.path).sort(), ['README.md', 'docs/committed.md', 'fresh.md'])
    assert.equal(docs.find((d) => d.path === 'fresh.md')?.untracked, true)
    assert.equal(docs.find((d) => d.path === 'docs/committed.md')?.untracked, false)

    const groups = listDocGroups(repo, 'master', [
      { id: 't1', title: 'Задача', worktree: wt, branch: 'orca/t1' },
      { id: 't2', title: 'Без .md', worktree: path.join(tmp, 'нет'), branch: 'orca/t2' }
    ])
    assert.deepEqual(groups.map((g) => [g.source, g.title]), [['project', 'Проект'], ['t1', 'Задача']])
    assert.ok(groups[0].files.some((f) => f.path === 'master-only.md'))
  })
})
