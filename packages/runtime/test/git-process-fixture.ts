import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git } from './git-queue-fixture.ts'
import { until } from './conversation-fixture.ts'

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    if (process.platform === 'linux' && readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z')) return false
    return true
  } catch { return false }
}

/** Hook действительно запускается Git; ребёнок наследует его process group. */
export function heldGitHook(dir: string, root: string, label: string) {
  const hooks = join(dir, `hooks-${label}`); mkdirSync(hooks)
  const entered = join(dir, `entered-${label}`); const release = join(dir, `release-${label}`)
  const source = join(dir, `hook-${label}.mjs`)
  writeFileSync(source, `import { spawn } from 'node:child_process';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 8000)'], { stdio: 'ignore' });
child.on('spawn', () => {
  writeFileSync(${JSON.stringify(entered + '.tmp')}, JSON.stringify([process.pid, child.pid]));
  renameSync(${JSON.stringify(entered + '.tmp')}, ${JSON.stringify(entered)});
});
const deadline = Date.now() + 6000;
const timer = setInterval(() => { if (existsSync(${JSON.stringify(release)}) || Date.now() >= deadline) {
  clearInterval(timer); child.kill('SIGKILL'); process.exit(existsSync(${JSON.stringify(release)}) ? 0 : 3);
} }, 10);
`)
  const quote = (value: string) => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'"
  writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(source)}\n`, { mode: 0o700 })
  git(root, 'config', 'core.hooksPath', hooks)
  return {
    entered: async (): Promise<number[]> => { await until(() => existsSync(entered)); return JSON.parse(readFileSync(entered, 'utf8')) as number[] },
    release: () => writeFileSync(release, 'release')
  }
}
