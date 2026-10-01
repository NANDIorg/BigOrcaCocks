// Запуск: pnpm --filter @orca-board/desktop test. QA «Документов со всеми файлами проекта»: то, чего нет в docs.test.ts
// и docs-view.test.ts, — сквозная проверка «список → просмотр» на странных именах и объём того, что страница превью
// может прочитать через протокол (docs/architecture.md → «Просмотр файлов проекта (main)», «Что может прочесть страница»).
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { listProjectFiles } from './docs'
import { docsPreviewUrl, viewDoc } from './docs-view'
import { PreviewTokens, resolvePreviewRequest } from './preview-protocol'

let tmp: string
let repo: string

function write(root: string, rel: string, text = 'x\n'): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), text)
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-docs-qa-')))
  repo = path.join(tmp, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'master', repo])
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('QA: всё, что отдал список, можно открыть', () => {
  // `\` и `:` на win32 — недопустимые символы пути (splitSafeSegments), на unix — обычные символы имени.
  const NAMES = [
    'with space.md',
    'кириллица.ts',
    'quote"s.txt',
    "apos'trophe.txt",
    'hash#.md',
    '-dash.txt',
    ':!pathspec.txt',
    'bracket[1].txt',
    'star*.txt',
    'new\nline.txt',
    'tab\there.txt',
    'emoji-😀.md',
    'percent%20x.txt',
    ' leading-space.txt',
    'dir with space/inner file.ts',
    'глубоко/вложено/файл с пробелом.json',
    'back\\slash.txt'
  ]

  it('имена с пробелами, кириллицей, кавычками, переводом строки и pathspec-магией доходят из `git ls-files` до `docs:view` без потерь', { skip: process.platform === 'win32' }, async () => {
    // Половина отслеживается, половина нет: оба тега `git ls-files -t` (`H` и `?`) разбираются одним кодом.
    NAMES.forEach((name, i) => write(repo, name, `содержимое ${i}\n`))
    // `--literal-pathspecs`: иначе git читает `:!pathspec.txt` как исключающий pathspec, а `*` и `[1]` — как шаблоны.
    execFileSync('git', ['--literal-pathspecs', 'add', '--', ...NAMES.filter((_, i) => i % 2 === 0)], { cwd: repo })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: repo })

    const { files, truncated } = await listProjectFiles(repo)
    assert.equal(truncated, false)
    assert.deepEqual(files.map((f) => f.path).sort(), [...NAMES].sort(), 'список должен совпасть с файлами на диске точно, без кавычек и экранирования git')
    for (const f of files) {
      const i = NAMES.indexOf(f.path)
      assert.equal(f.untracked, i % 2 !== 0, `untracked: ${JSON.stringify(f.path)}`)
      const v = await viewDoc(repo, f.path)
      assert.equal(v.stub, undefined, JSON.stringify(f.path))
      assert.equal(v.text, `содержимое ${i}\n`, JSON.stringify(f.path))
    }
  })
})

describe('QA: что страница превью читает через протокол', () => {
  it('белый список расширений без точечных сегментов; .env, .git, исходники и симлинки наружу — отказ', async () => {
    write(repo, 'site/index.html', '<h1>x</h1>')
    write(repo, 'site/data.json', '{}')
    // Не скрыто протоколом и задокументировано: сети нет, вынести прочитанное наружу нечем.
    write(repo, 'node_modules/lib/a.js', 'x')
    write(repo, '.env', 'KEY=1')
    write(repo, '.env.json', '{}')
    write(repo, '.hidden/a.json', '{}')
    write(repo, 'src/main.tsx', 'x')
    write(repo, 'run.sh', '#!/bin/sh\n')
    write(tmp, 'secret.json', '{"s":1}')
    symlinkSync(path.join(tmp, 'secret.json'), path.join(repo, 'leak.json'))
    symlinkSync(path.join(repo, '.git', 'config'), path.join(repo, 'gitcfg.txt'))
    symlinkSync(path.join(repo, 'run.sh'), path.join(repo, 'trap.json'))
    symlinkSync(path.join(repo, '.env'), path.join(repo, 'envlink.txt'))

    const tokens = new PreviewTokens()
    const p = await docsPreviewUrl(tokens, repo, 'site/index.html')
    const token = p.base.slice('orca-preview://'.length, -1)
    assert.equal(tokens.get(token)?.network, false, 'токен на живой корень — всегда без сети')
    const status = (rel: string): number => {
      const r = resolvePreviewRequest({ method: 'GET', url: p.base + rel }, tokens)
      return r.ok ? 200 : r.status
    }

    for (const rel of ['site/index.html', 'site/data.json', 'node_modules/lib/a.js']) assert.equal(status(rel), 200, rel)
    for (const rel of [
      '.env', '.env.json', '.hidden/a.json', '.git/config', '.GIT/config',
      'src/main.tsx', 'run.sh',
      'leak.json', 'gitcfg.txt', 'trap.json', 'envlink.txt',
      '../secret.json', '%2e%2e/secret.json', 'site/../../secret.json', 'site/%2e%2e/%2e%2e/secret.json'
    ]) {
      assert.notEqual(status(rel), 200, `страница не должна читать ${rel}`)
    }
  })
})
