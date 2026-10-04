import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { promisify } from 'node:util'

/** Linked worktree и алиас корня разделяют refs/locks одного Git commonDir. */
export async function canonicalGitCommonDir(root: string): Promise<string> {
  const { stdout } = await promisify(execFile)('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: root, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_PAGER: 'cat', NO_COLOR: '1' }
  })
  // Удаляем только окончание строки: пробел может быть частью имени директории.
  return realpath(stdout.replace(/\r?\n$/, ''))
}
export interface GitOperationQueue {
  enqueue<T>(canonicalCommonDir: string, operation: () => Promise<T>): Promise<T>
}
export function createGitOperationQueue(): GitOperationQueue {
  const tails = new Map<string, Promise<unknown>>()
  return { enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const next = (tails.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation)
    tails.set(key, next)
    const cleanup = () => { if (tails.get(key) === next) tails.delete(key) }
    next.then(cleanup, cleanup)
    return next
  } }
}
