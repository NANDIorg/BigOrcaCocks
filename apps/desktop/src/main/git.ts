import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
}

export function currentBranch(repoRoot: string): string {
  return git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
}

export interface ReviewInfo {
  base: string
  branch: string
  stat: string
  commits: string[]
  dirty: boolean
}

/** Что накопилось в ветке задачи относительно базовой ветки. */
export function reviewInfo(repoRoot: string, worktree: string, branch: string): ReviewInfo {
  const base = currentBranch(repoRoot)
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
    stat = [stat, wtStat, untracked ? `новые файлы:\n${untracked}` : ''].filter(Boolean).join('\n')
  }
  return { base, branch, stat, commits, dirty }
}

/** Незакоммиченное в worktree — коммитим от имени orca, чтобы не потерять при мерже. */
export function commitWorktree(worktree: string, message: string): void {
  if (git(worktree, ['status', '--porcelain']) === '') return
  git(worktree, ['add', '-A'])
  execFileSync('git', ['-c', 'user.name=orca-board', '-c', 'user.email=orca@local', 'commit', '-q', '-m', message], {
    cwd: worktree,
    stdio: 'pipe'
  })
}

/** Слить ветку задачи в текущую ветку репозитория. Бросает с текстом конфликта. */
export function mergeBranch(repoRoot: string, branch: string, message: string): void {
  try {
    execFileSync('git', ['merge', '--no-ff', '-m', message, branch], { cwd: repoRoot, stdio: 'pipe' })
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer }
    try {
      execFileSync('git', ['merge', '--abort'], { cwd: repoRoot, stdio: 'pipe' })
    } catch {
      /* нечего отменять */
    }
    throw new Error(`мерж не удался:\n${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`.trim())
  }
}

export function removeWorktree(repoRoot: string, worktree: string, branch: string): void {
  if (existsSync(worktree)) git(repoRoot, ['worktree', 'remove', '--force', worktree])
  try {
    git(repoRoot, ['branch', '-D', branch])
  } catch {
    /* уже удалена */
  }
}

/** Команда подготовки нового worktree по lock-файлу. */
export function setupCommand(worktree: string): string | null {
  if (existsSync(join(worktree, 'pnpm-lock.yaml'))) return 'pnpm install --prefer-offline'
  if (existsSync(join(worktree, 'package-lock.json'))) return 'npm ci'
  if (existsSync(join(worktree, 'yarn.lock'))) return 'yarn install'
  if (existsSync(join(worktree, 'poetry.lock'))) return 'poetry install'
  return null
}
