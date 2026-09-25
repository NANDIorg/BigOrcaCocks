import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { mt } from './i18n'
import type { ProjectBranchInfo } from '../shared/ipc'

// git вызывается только массивом аргументов без shell: на Windows execFileSync находит git.exe через PATH,
// сами команды (worktree, merge, branch, status, diff) одинаковы на всех платформах.
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim()
}

export function currentBranch(repoRoot: string): string {
  return git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
}

/** Состояние HEAD корня проекта для UI; см. `ProjectBranchInfo` в `shared/ipc.ts`. */
export function projectBranchInfo(repoRoot: string): ProjectBranchInfo {
  try {
    if (git(repoRoot, ['rev-parse', '--is-inside-work-tree']) !== 'true') return { isGitRepo: false, branch: null, detached: false }
  } catch {
    return { isGitRepo: false, branch: null, detached: false }
  }
  try {
    // symbolic-ref, а не `rev-parse --abbrev-ref`: в репозитории без коммитов последний падает, а этот отдаёт имя ветки.
    return { isGitRepo: true, branch: git(repoRoot, ['symbolic-ref', '--short', '-q', 'HEAD']), detached: false }
  } catch {
    // код 1 у symbolic-ref — HEAD не на ветке (detached)
    try {
      return { isGitRepo: true, branch: null, detached: true, sha: git(repoRoot, ['rev-parse', '--short', 'HEAD']) }
    } catch {
      return { isGitRepo: true, branch: null, detached: true }
    }
  }
}

export interface ReviewInfo {
  base: string
  branch: string
  stat: string
  commits: string[]
  dirty: boolean
}

/**
 * Что накопилось в ветке задачи относительно базовой ветки: ветки глобальной задачи (`reviewBase`) или, без неё,
 * текущей ветки корня. Refs у всех worktree общие, поэтому diff считается из корня.
 */
export function reviewInfo(repoRoot: string, worktree: string, branch: string, base = currentBranch(repoRoot)): ReviewInfo {
  const dirty = existsSync(worktree) && git(worktree, ['status', '--porcelain']) !== ''
  let stat = ''
  let commits: string[] = []
  try {
    stat = git(repoRoot, ['diff', '--stat', `${base}...${branch}`])
    commits = git(repoRoot, ['log', '--oneline', `${base}..${branch}`]).split('\n').filter(Boolean)
  } catch {
    // ветки может ещё не быть
  }
  if (dirty) {
    const wtStat = git(worktree, ['diff', '--stat'])
    const untracked = git(worktree, ['ls-files', '--others', '--exclude-standard'])
    stat = [stat, wtStat, untracked ? `${mt('review.untracked')}\n${untracked}` : ''].filter(Boolean).join('\n')
  }
  return { base, branch, stat, commits, dirty }
}

/** Незакоммиченное в worktree — коммитим от имени orca, чтобы не потерять при мерже. */
export function commitWorktree(worktree: string, message: string): void {
  if (git(worktree, ['status', '--porcelain']) === '') return
  git(worktree, ['add', '-A'])
  execFileSync('git', ['-c', 'user.name=orca-board', '-c', 'user.email=orca@local', 'commit', '-q', '-m', message], {
    cwd: worktree,
    stdio: 'pipe',
    encoding: 'utf8'
  })
}

/**
 * Слить ветку задачи в ветку, выбранную в каталоге `cwd`: worktree глобальной задачи или корень (`mergeTarget`).
 * Бросает с текстом конфликта.
 */
export function mergeBranch(cwd: string, branch: string, message: string): void {
  try {
    execFileSync('git', ['merge', '--no-ff', '-m', message, branch], { cwd, stdio: 'pipe', encoding: 'utf8' })
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    try {
      execFileSync('git', ['merge', '--abort'], { cwd, stdio: 'pipe', encoding: 'utf8' })
    } catch {
      /* нечего отменять */
    }
    throw new Error(`мерж не удался:\n${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`.trim())
  }
}

/** Убрать только worktree, ветку оставить: работа не слита, но и не потеряна (воркфлоу закончился без мержа). */
export function removeWorktreeKeepBranch(repoRoot: string, worktree: string): void {
  if (existsSync(worktree)) git(repoRoot, ['worktree', 'remove', '--force', worktree])
}

export function removeWorktree(repoRoot: string, worktree: string, branch: string): void {
  if (existsSync(worktree)) git(repoRoot, ['worktree', 'remove', '--force', worktree])
  try {
    git(repoRoot, ['branch', '-D', branch])
  } catch {
    /* уже удалена */
  }
}

/**
 * Команда подготовки нового worktree по lock-файлу.
 * Это строка для shell платформы (на Windows pnpm/npm/yarn — .cmd-шимы, нужен cmd.exe),
 * запуском занимается worker.ts.
 */
export function setupCommand(worktree: string): string | null {
  if (existsSync(join(worktree, 'pnpm-lock.yaml'))) return 'pnpm install --prefer-offline'
  if (existsSync(join(worktree, 'package-lock.json'))) return 'npm ci'
  if (existsSync(join(worktree, 'yarn.lock'))) return 'yarn install'
  if (existsSync(join(worktree, 'poetry.lock'))) return 'poetry install'
  return null
}
