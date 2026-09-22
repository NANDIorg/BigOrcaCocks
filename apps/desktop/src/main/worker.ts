import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { app, type BrowserWindow } from 'electron'
import { newId, type TaskStore, type AgentKind } from '@orca-board/core'
import workerSkill from '../../../../skills/worker.md?raw'
import { spawnPty } from './pty'

export interface WorkerEnvContext {
  socketPath: string
}

/** Путь к bin CLI. В dev — из monorepo, в сборке — рядом с ресурсами. */
export function cliBinDir(): string {
  const dev = resolve(app.getAppPath(), '../../packages/cli/bin')
  if (existsSync(dev)) return dev
  return join(process.resourcesPath, 'cli')
}

function agentInvocation(agent: AgentKind, prompt: string): { command: string; args: string[] } {
  switch (agent) {
    case 'claude':
      return { command: 'claude', args: ['--append-system-prompt', workerSkill, prompt] }
    case 'codex':
      return { command: 'codex', args: [`${workerSkill}\n\n---\n\n${prompt}`] }
    case 'opencode':
      return { command: 'opencode', args: ['--prompt', `${workerSkill}\n\n---\n\n${prompt}`] }
    case 'shell':
      return { command: process.env.SHELL ?? '/bin/zsh', args: [] }
  }
}

/**
 * Старт воркера: git worktree на ветке задачи → PTY с агентом → dispatch.
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
  if (!existsSync(worktree)) {
    const branchExists = execFileSync('git', ['branch', '--list', branch], { cwd: repoRoot }).toString().trim() !== ''
    const args = branchExists ? ['worktree', 'add', worktree, branch] : ['worktree', 'add', '-b', branch, worktree]
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' })
  }
  store.updateTask(task.id, { worktree, branch })

  const dispatchId = newId('disp')
  const prompt = [`# Задача: ${task.title}`, '', task.spec || '(описание не задано)'].join('\n')
  const inv = agentInvocation(task.agent, prompt)

  const ptyId = spawnPty(
    win,
    {
      cwd: worktree,
      command: inv.command,
      args: inv.args,
      cols,
      rows,
      env: {
        ORCA_TASK_ID: task.id,
        ORCA_DISPATCH_ID: dispatchId,
        ORCA_SOCKET: ctx.socketPath,
        PATH: `${cliBinDir()}:${process.env.PATH ?? ''}`
      }
    },
    (id, code) => store.ptyExited(id, code)
  )
  store.startDispatch(task.id, ptyId, dispatchId)
  return { ptyId, dispatchId, worktree, branch }
}
