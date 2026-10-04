import { realpath } from 'node:fs/promises'
import { createGitProcessService, type GitProcessService } from './git-process.ts'

/** Linked worktree и алиас корня разделяют refs/locks одного Git commonDir. */
export async function canonicalGitCommonDir(root: string, processes: GitProcessService = createGitProcessService()): Promise<string> {
  const { stdout } = await processes.run(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
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
