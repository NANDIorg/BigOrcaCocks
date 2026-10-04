import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import * as runtime from '../src/index.ts'
import { until } from './conversation-fixture.ts'

export const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim()
export const asyncGit = (root: string, ...args: string[]) => promisify(execFile)('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 })
export function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
export function gitQueueFixture(t: { after(fn: () => void): void }) {
  assertQueue()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-git-queue-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const repo = (name: string, committed = true) => {
    const root = join(dir, name); git(dir, 'init', '-q', '-b', 'main', root)
    git(root, 'config', 'user.name', 'test'); git(root, 'config', 'user.email', 'test@local')
    git(root, 'config', 'commit.gpgsign', 'false'); git(root, 'config', 'core.hooksPath', join(dir, 'no-hooks'))
    if (committed) git(root, 'commit', '-q', '--allow-empty', '-m', 'initial')
    return root
  }
  const root = repo('A with spaces'); const other = repo('B'); const unborn = repo('unborn', false)
  const linked = join(dir, 'linked'); git(root, 'worktree', 'add', '-q', '-b', 'linked', linked)
  const alias = join(dir, 'alias'); symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const queue = runtime.createGitOperationQueue()
  return { dir, root, other, unborn, linked, alias, queue }
}
function assertQueue(): void {
  if (typeof runtime.createGitOperationQueue !== 'function' || typeof runtime.canonicalGitCommonDir !== 'function') throw new Error('Отсутствует общая очередь Git/commonDir')
}

/** Настоящий Git hook запускает Node; платных сервисов и shell запуска из production нет. */
export function commitGate(t: { after(fn: () => void): void }, dir: string, root: string) {
  const hooks = join(dir, 'hooks'); mkdirSync(hooks)
  const entered = join(dir, 'entered'); const release = join(dir, 'release'); const source = join(dir, 'git-hook.mjs')
  writeFileSync(source, `import { existsSync, writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(entered)}, 'entered');\nconst limit = Date.now() + 5000;\nconst timer = setInterval(() => { if (existsSync(${JSON.stringify(release)})) { clearInterval(timer); process.exit(0) } if (Date.now() > limit) { clearInterval(timer); process.exit(3) } }, 10);\n`)
  const quote = (value: string) => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'"
  writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(source)}\n`, { mode: 0o700 })
  git(root, 'config', 'core.hooksPath', hooks)
  t.after(() => { if (existsSync(dir)) writeFileSync(release, 'release') })
  return { entered: () => until(() => existsSync(entered)), release: () => writeFileSync(release, 'release') }
}
