import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { app, type BrowserWindow } from 'electron'
import { newId, type TaskStore, type AgentKind } from '@orca-board/core'
import workerSkill from '../../../../skills/worker.md?raw'
import coordinatorSkill from '../../../../skills/coordinator.md?raw'
import { spawnPty } from './pty'
import { setupCommand } from './git'

export interface WorkerEnvContext {
  socketPath: string
  projectId: string
}

/** Путь к bin CLI. В dev — из monorepo, в сборке — рядом с ресурсами. */
export function cliBinDir(): string {
  const dev = resolve(app.getAppPath(), '../../packages/cli/bin')
  if (existsSync(dev)) return dev
  return join(process.resourcesPath, 'cli')
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function agentInvocation(agent: AgentKind, system: string, prompt: string): { command: string; args: string[] } {
  switch (agent) {
    case 'claude':
      // orca-board разрешён без подтверждения, правки файлов — тоже; остальной Bash спросит в терминале
      return {
        command: 'claude',
        args: ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(orca-board:*)', '--append-system-prompt', system, prompt]
      }
    case 'codex':
      return { command: 'codex', args: [`${system}\n\n---\n\n${prompt}`] }
    case 'opencode':
      return { command: 'opencode', args: ['--prompt', `${system}\n\n---\n\n${prompt}`] }
    case 'shell':
      return { command: process.env.SHELL ?? '/bin/zsh', args: [] }
  }
}

function baseEnv(ctx: WorkerEnvContext): Record<string, string> {
  return {
    ORCA_SOCKET: ctx.socketPath,
    ORCA_PROJECT: ctx.projectId,
    PATH: `${cliBinDir()}:${process.env.PATH ?? ''}`
  }
}

/**
 * Старт воркера: git worktree на ветке задачи → подготовка → PTY с агентом → dispatch.
 * Worktree создаётся рядом с репозиторием: <repo>/../.orca-worktrees/<taskId>.
 */
export function startWorker(
  win: BrowserWindow,
  store: TaskStore,
  repoRoot: string,
  ctx: WorkerEnvContext,
  taskId: string,
  cols = 120,
  rows = 30
): { ptyId: string; dispatchId: string; worktree: string; branch: string } {
  const task = store.getTask(taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  if (task.status === 'in_progress') throw new Error(`task already in progress: ${taskId}`)

  const branch = `orca/${task.id}`
  const worktree = join(repoRoot, '..', '.orca-worktrees', task.id)
  let fresh = false
  if (!existsSync(worktree)) {
    const branchExists = execFileSync('git', ['branch', '--list', branch], { cwd: repoRoot }).toString().trim() !== ''
    const args = branchExists ? ['worktree', 'add', worktree, branch] : ['worktree', 'add', '-b', branch, worktree]
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' })
    fresh = true
  }
  store.updateTask(task.id, { worktree, branch })

  const dispatchId = newId('disp')
  const feedback = task.feedback ? `\n\n# Замечания после ревью\n\n${task.feedback}` : ''
  const prompt = [`# Задача: ${task.title}`, '', task.spec || '(описание не задано)', feedback].join('\n')
  const inv = agentInvocation(task.agent, workerSkill, prompt)

  // Свежий worktree без node_modules — ставим зависимости в том же PTY, потом exec агента.
  const setup = fresh ? setupCommand(worktree) : null
  const command = setup ? process.env.SHELL ?? '/bin/zsh' : inv.command
  const args = setup
    ? ['-c', `echo "[orca] ${setup}"; ${setup}; exec ${[inv.command, ...inv.args].map(shellQuote).join(' ')}`]
    : inv.args

  const ptyId = spawnPty(
    win,
    {
      cwd: worktree,
      command,
      args,
      cols,
      rows,
      env: { ...baseEnv(ctx), ORCA_TASK_ID: task.id, ORCA_DISPATCH_ID: dispatchId }
    },
    (id, code) => store.ptyExited(id, code)
  )
  store.startDispatch(task.id, ptyId, dispatchId)
  return { ptyId, dispatchId, worktree, branch }
}

/** Координатор: claude в корне репозитория с инструкцией и целью. */
export function startCoordinator(
  win: BrowserWindow,
  repoRoot: string,
  ctx: WorkerEnvContext,
  objective: string,
  cols = 120,
  rows = 30
): string {
  const prompt = `Цель: ${objective}\n\nНачни с декомпозиции и создания задач через orca-board.`
  return spawnPty(win, {
    cwd: repoRoot,
    command: 'claude',
    args: ['--allowedTools', 'Bash(orca-board:*)', '--append-system-prompt', coordinatorSkill, prompt],
    cols,
    rows,
    env: { ...baseEnv(ctx), ORCA_ROLE: 'coordinator' }
  })
}
