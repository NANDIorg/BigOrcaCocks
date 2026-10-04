import type { EffectJournal, NativeEffect } from './effect-journal.ts'

export interface GitMutationTracker { completed(): void; failed(): void }
export type GitMutationObserver = (effect: NativeEffect) => GitMutationTracker | undefined

/** Никаких argv в journal: там могут быть credentials и пользовательское содержимое. */
export function gitNativeEffect(cwd: string, args: readonly string[]): NativeEffect | undefined {
  let index = 0
  while (args[index] === '-c') index += 2
  const command = args[index]; const rest = args.slice(index + 1)
  if (command === 'worktree') {
    if (!['add', 'remove', 'prune', 'move', 'repair', 'lock', 'unlock'].includes(rest[0])) return undefined
    return { kind: 'git', cwd, operation: `worktree.${rest[0]}` }
  }
  if (command === 'branch' && (!rest.length || rest.includes('--list') || rest.includes('--show-current'))) return undefined
  if (command === 'hash-object' && !rest.includes('-w')) return undefined
  if (!['branch', 'checkout', 'add', 'commit', 'merge', 'push', 'fetch', 'update-ref', 'commit-tree', 'hash-object'].includes(command)) return undefined
  return { kind: 'git', cwd, operation: command }
}

/** Unscoped операции не имеют последующего store checkpoint; их native result является собственным checkpoint. */
export function nativeOnlyGitObserver(getJournal: (() => EffectJournal | undefined) | undefined, root: string): GitMutationObserver {
  return effect => {
    const journal = getJournal?.(); if (!journal) return undefined
    const id = journal.begin({ repoRoot: root }, effect)
    return { completed: () => { journal.nativeCompleted(id); journal.applied([id]) }, failed: () => journal.nativeCompleted(id, 'failed') }
  }
}
