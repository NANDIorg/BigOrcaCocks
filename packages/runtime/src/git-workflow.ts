import { existsSync } from 'node:fs'
import { canonicalGitCommonDir, type GitOperationQueue } from './git-operation-queue.ts'
import { GitProcessError, type GitProcessService, type GitProcessResult } from './git-process.ts'
import { GitOpError, MergeError, type GitMessages, type ReviewInfo } from './git-errors.ts'
import { gitNativeEffect, type GitMutationObserver } from './git-effects.ts'

export interface GitWorkflowOptions { guard?: () => void; signal?: AbortSignal; onMutation?: GitMutationObserver }
export interface GitWorkflowReadRepository {
  head(ref?: string): Promise<string | undefined>
  remotes(): Promise<string[]>
  checkedOutAt(branch: string): Promise<string | undefined>
  isDirty(worktree: string): Promise<boolean>
  currentBranch(): Promise<string>
  hasCommits(): Promise<boolean>
  assertHasCommits(): Promise<void>
  headBase(): Promise<string>
  localBranchExists(branch: string): Promise<boolean>
  isBranchNameAcceptedByGit(name: string): Promise<boolean>
  worktreeBranch(worktree: string): Promise<string | undefined>
  reviewInfo(worktree: string, branch: string, base?: string): Promise<ReviewInfo>
}
export interface GitWorkflowRepository extends GitWorkflowReadRepository {
  addRunWorktree(worktree: string, branch: string, base: string): Promise<void>
  pruneWorktrees(): Promise<void>
  removeCleanWorktree(worktree: string): Promise<boolean>
  addTaskWorktree(worktree: string, branch: string, base?: string): Promise<void>
  commitWorktree(worktree: string, message: string): Promise<void>
  mergeBranch(cwd: string, branch: string, message: string): Promise<void>
  removeWorktreeKeepBranch(worktree: string): Promise<void>
  removeWorktree(worktree: string, branch: string, foreign?: boolean): Promise<void>
  gitCreateBranch(worktree: string, branch: string, base: string | undefined, own: boolean): Promise<void>
  gitCheckout(worktree: string, branch: string): Promise<void>
  gitCommit(worktree: string, message: string): Promise<void>
  gitPush(worktree: string | undefined, remote: string, branch: string): Promise<void>
}
export interface GitWorkflowService {
  transaction<T>(root: string, operation: (repo: GitWorkflowRepository) => Promise<T>, options?: GitWorkflowOptions): Promise<T>
  read<T>(root: string, operation: (repo: GitWorkflowReadRepository) => Promise<T>, options?: GitWorkflowOptions): Promise<T>
}

/** Scoped методы не входят повторно в очередь: compound review/launch выполняются одной repo job. */
export function createGitWorkflowService(messages: GitMessages, queue: GitOperationQueue, processes: GitProcessService,
  fallbackObserver?: (root: string) => GitMutationObserver): GitWorkflowService {
  const check = (options: GitWorkflowOptions) => {
    options.guard?.()
    if (options.signal?.aborted) throw new GitProcessError('Вызов Git отменён', 'ABORT_ERR', '', '', true)
  }
  async function keyOf(root: string, options: GitWorkflowOptions): Promise<string> {
    check(options)
    try {
      const key = await canonicalGitCommonDir(root, processes); check(options); return key
    } catch (error) {
      check(options)
      if (!(error instanceof GitProcessError) || error.cancelled) throw error
      throw new GitProcessError(`git rev-parse --git-common-dir: ${[error.stderr, error.stdout].join('').trim() || error.message}`,
        error.code, error.stdout, error.stderr, false, error.timedOut, error.killed)
    }
  }
  function scope(root: string, key: string, options: GitWorkflowOptions) {
    let open = true
    const guard = () => { if (!open) throw new Error('Область Git операции уже завершена'); check(options) }
    const paths = new Set([root])
    async function run(cwd: string, args: string[], timeoutMs = 30_000, acceptedExitCodes?: number[]): Promise<GitProcessResult> {
      guard()
      if (!paths.has(cwd)) {
        const target = await keyOf(cwd, options); guard()
        if (target !== key) throw new GitOpError('Git операция обращается к другому репозиторию вне своей очереди')
        paths.add(cwd)
      }
      const effect = gitNativeEffect(cwd, args)
      const tracker = effect ? (options.onMutation ?? fallbackObserver?.(root))?.(effect) : undefined
      guard()
      let result: GitProcessResult | undefined; let failure: unknown
      try { result = await processes.run(cwd, args, { timeoutMs, acceptedExitCodes, signal: options.signal }) }
      catch (error) { failure = error }
      // Native outcome сохраняется до stale guard: Git уже мог изменить refs.
      if (failure) tracker?.failed(); else tracker?.completed()
      // Guard вне native catch: поздний результат не форматируется как Git failure.
      guard()
      if (failure) throw failure
      if (!result) throw new Error('Git не вернул результат')
      return result
    }
    const text = async (cwd: string, args: string[], timeout?: number) => (await run(cwd, args, timeout)).stdout.trim()
    const absent = (error: unknown) => error instanceof GitProcessError && error.code === 1 && !error.cancelled && !error.timedOut
    const reason = (error: GitProcessError) => error.timedOut ? 'git не ответил за отведённое время' : [error.stdout, error.stderr].join('').trim() || error.message
    async function op(cwd: string, args: string[], timeout = 120_000): Promise<string> {
      try { return await text(cwd, args, timeout) }
      catch (error) {
        if (!(error instanceof GitProcessError) || error.cancelled) throw error
        const shown: string[] = []
        for (let i = 0; i < args.length; i++) { if (args[i] === '-c') i++; else shown.push(args[i]) }
        throw new GitOpError(`git ${shown.join(' ')}: ${reason(error)}`)
      }
    }
    async function currentBranch(): Promise<string> {
      const result = await run(root, ['symbolic-ref', '--short', '-q', 'HEAD'], 30_000, [1])
      return result.code === 1 ? 'HEAD' : result.stdout.trim()
    }
    async function head(ref = 'HEAD'): Promise<string | undefined> {
      const result = await run(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], 30_000, [1])
      return result.code === 1 ? undefined : result.stdout.trim() || undefined
    }
    async function remotes(): Promise<string[]> { return (await text(root, ['remote'])).split('\n').filter(Boolean) }
    async function checkedOutAt(branch: string): Promise<string | undefined> {
      const result = await run(root, ['worktree', 'list', '--porcelain', '-z']); let path: string | undefined
      for (const field of result.stdout.split('\0')) {
        if (field.startsWith('worktree ')) path = field.slice('worktree '.length)
        else if (field === `branch refs/heads/${branch}`) return path
      }
      return undefined
    }
    async function isDirty(worktree: string): Promise<boolean> { return await text(worktree, ['status', '--porcelain']) !== '' }
    async function addRunWorktree(worktree: string, branch: string, base: string): Promise<void> {
      await text(root, ['worktree', 'add', '--no-track', '-b', branch, worktree, base], 120_000)
    }
    async function pruneWorktrees(): Promise<void> { await text(root, ['worktree', 'prune'], 120_000) }
    async function removeCleanWorktree(worktree: string): Promise<boolean> {
      guard(); if (!existsSync(worktree)) return true
      try { await text(root, ['worktree', 'remove', worktree], 120_000); return true }
      catch (error) { if (!(error instanceof GitProcessError) || error.cancelled) throw error; return false }
    }
    async function hasCommits(): Promise<boolean> { return (await run(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], 30_000, [1])).code === 0 }
    async function assertHasCommits(): Promise<void> {
      if (!await hasCommits()) throw messages.error('git.noCommits', { branch: await currentBranch() })
    }
    async function headBase(): Promise<string> { const branch = await currentBranch(); return branch === 'HEAD' ? text(root, ['rev-parse', 'HEAD']) : branch }
    async function localBranchExists(branch: string): Promise<boolean> {
      return (await run(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], 30_000, [1])).code === 0
    }
    async function isBranchNameAcceptedByGit(name: string): Promise<boolean> {
      return (await run(root, ['check-ref-format', '--branch', name], 30_000, [128])).code === 0
    }
    async function worktreeBranch(worktree: string): Promise<string | undefined> {
      const result = await run(worktree, ['symbolic-ref', '--short', '-q', 'HEAD'], 30_000, [1]); return result.code === 1 ? undefined : result.stdout.trim()
    }
    async function reviewInfo(worktree: string, branch: string, base?: string): Promise<ReviewInfo> {
      const target = base ?? await currentBranch()
      const dirty = existsSync(worktree) && await text(worktree, ['status', '--porcelain']) !== ''
      let stat = ''; let commits: string[] = []
      const commitExists = async (ref: string) => (await run(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], 30_000, [1])).code === 0
      // Отсутствующий ref допустим для старого preview; ошибка diff не означает «нечего сливать».
      if (await commitExists(target) && await commitExists(branch)) {
        stat = await text(root, ['diff', '--stat', `${target}...${branch}`])
        commits = (await text(root, ['log', '--oneline', `${target}..${branch}`])).split('\n').filter(Boolean)
      }
      if (dirty) {
        const wtStat = await text(worktree, ['diff', '--stat']); const untracked = await text(worktree, ['ls-files', '--others', '--exclude-standard'])
        stat = [stat, wtStat, untracked ? `${messages.untrackedLabel()}\n${untracked}` : ''].filter(Boolean).join('\n')
      }
      return { base: target, branch, stat, commits, dirty }
    }
    async function addTaskWorktree(worktree: string, branch: string, base?: string): Promise<void> {
      if (await localBranchExists(branch)) { await text(root, ['worktree', 'add', worktree, branch], 120_000); return }
      await assertHasCommits(); await text(root, ['worktree', 'add', '-b', branch, worktree, ...(base ? [base] : [])], 120_000)
    }
    async function commitWorktree(worktree: string, message: string): Promise<void> {
      if (await text(worktree, ['status', '--porcelain']) === '') return
      await text(worktree, ['add', '-A'], 120_000)
      try { await text(worktree, ['-c', 'user.name=orca-board', '-c', 'user.email=orca@local', 'commit', '-q', '-m', message], 120_000) }
      catch (error) {
        if (!(error instanceof GitProcessError) || error.cancelled) throw error
        throw new Error(`коммит хвостов worktree не удался: ${reason(error)}`)
      }
    }
    async function mergeBranch(cwd: string, branch: string, message: string): Promise<void> {
      try { await text(cwd, ['merge', '--no-ff', '-m', message, branch], 120_000) }
      catch (error) {
        if (!(error instanceof GitProcessError) || error.cancelled) throw error
        let conflict = false
        try { conflict = await text(cwd, ['diff', '--name-only', '--diff-filter=U']) !== '' }
        catch (probe) { if (!(probe instanceof GitProcessError) || probe.cancelled) throw probe }
        try { await text(cwd, ['merge', '--abort'], 120_000) }
        catch (abort) { if (!(abort instanceof GitProcessError) || abort.cancelled) throw abort }
        throw new MergeError(`мерж не удался:\n${reason(error)}`, conflict)
      }
    }
    async function removeWorktreeKeepBranch(worktree: string): Promise<void> {
      guard(); if (existsSync(worktree)) await text(root, ['worktree', 'remove', '--force', worktree], 120_000)
    }
    async function removeWorktree(worktree: string, branch: string, foreign = false): Promise<void> {
      if (foreign) { await removeWorktreeKeepBranch(worktree); return }
      guard()
      if (existsSync(worktree)) await text(root, ['worktree', 'remove', '--force', worktree], 120_000)
      else await text(root, ['worktree', 'prune'], 120_000)
      if (await localBranchExists(branch)) await text(root, ['branch', '-D', branch], 120_000)
    }
    async function assertClean(worktree: string, action: string): Promise<void> {
      if (await op(worktree, ['status', '--porcelain']) !== '') throw new GitOpError(`в worktree есть незакоммиченные изменения — ${action} не выполняется; добавьте перед ним операцию commit`)
    }
    async function checkoutBranch(worktree: string, branch: string): Promise<void> {
      guard()
      if (!existsSync(worktree)) { await op(root, ['worktree', 'add', '-q', worktree, branch]); return }
      if (await worktreeBranch(worktree) === branch) return
      await assertClean(worktree, 'переключение ветки'); await op(worktree, ['checkout', '-q', branch])
    }
    async function gitCreateBranch(worktree: string, branch: string, base: string | undefined, own: boolean): Promise<void> {
      if (await localBranchExists(branch)) {
        if (!own) throw new GitOpError(`ветка «${branch}» уже существует`)
        await checkoutBranch(worktree, branch); return
      }
      const verify = async (start: string) => {
        try { await text(root, ['rev-parse', '--verify', '--quiet', `${start}^{commit}`]) }
        catch (error) { if (!absent(error)) throw error; throw new GitOpError(`базовой ветки «${start}» нет — не от чего создавать «${branch}»`) }
      }
      if (existsSync(worktree)) {
        await assertClean(worktree, 'создание ветки'); if (base) await verify(base)
        await op(worktree, ['checkout', '-q', '--no-track', '-b', branch, ...(base ? [base] : [])]); return
      }
      if (!base && !await hasCommits()) throw new GitOpError(`в репозитории нет ни одного коммита — не от чего создавать «${branch}»: создайте начальный коммит`)
      const start = base ?? await headBase(); await verify(start)
      await op(root, ['worktree', 'add', '-q', '--no-track', '-b', branch, worktree, start])
    }
    async function gitCheckout(worktree: string, branch: string): Promise<void> {
      if (!await localBranchExists(branch)) throw new GitOpError(`ветки «${branch}» нет`)
      await checkoutBranch(worktree, branch)
    }
    async function gitCommit(worktree: string, message: string): Promise<void> {
      guard(); if (!existsSync(worktree)) throw new GitOpError('у задачи нет worktree — коммитить нечего')
      if (await op(worktree, ['status', '--porcelain']) === '') return
      await op(worktree, ['add', '-A']); await op(worktree, ['-c', 'user.name=orca-board', '-c', 'user.email=orca@local', 'commit', '-q', '-m', message])
    }
    async function gitPush(worktree: string | undefined, remote: string, branch: string): Promise<void> {
      guard(); await op(worktree && existsSync(worktree) ? worktree : root, ['push', '-u', remote, branch])
    }
    const read: GitWorkflowReadRepository = { head, remotes, checkedOutAt, isDirty, currentBranch, hasCommits, assertHasCommits, headBase, localBranchExists, isBranchNameAcceptedByGit, worktreeBranch, reviewInfo }
    const repo: GitWorkflowRepository = { ...read, addRunWorktree, pruneWorktrees, removeCleanWorktree, addTaskWorktree, commitWorktree, mergeBranch, removeWorktreeKeepBranch, removeWorktree, gitCreateBranch, gitCheckout, gitCommit, gitPush }
    return { read, repo, guard, close: () => { open = false } }
  }
  return {
    async transaction(root, operation, options = {}) {
      const key = await keyOf(root, options)
      return queue.enqueue(key, async () => {
        check(options); const current = scope(root, key, options)
        try { const result = await operation(current.repo); current.guard(); return result } finally { current.close() }
      })
    },
    async read(root, operation, options = {}) {
      const current = scope(root, await keyOf(root, options), options)
      try { const result = await operation(current.read); current.guard(); return result } finally { current.close() }
    }
  }
}
