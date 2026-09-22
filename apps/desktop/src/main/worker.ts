import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { BrowserWindow } from 'electron'
import type { TaskStore, AgentKind } from '@orca-board/core'
import { spawnPty } from './pty'

const AGENT_COMMANDS: Record<AgentKind, { command: string; args: string[] }> = {
  claude: { command: 'claude', args: [] },
  codex: { command: 'codex', args: [] },
  opencode: { command: 'opencode', args: [] },
  shell: { command: process.env.SHELL ?? '/bin/zsh', args: [] }
}

/**
 * Старт воркера: git worktree на ветке задачи → PTY с агентом → dispatch.
 * Worktree создаётся рядом с репозиторием: <repo>/../.orca-worktrees/<taskId>.
 */
export function startWorker(
  win: BrowserWindow,
  store: TaskStore,
  repoRoot: string,
  taskId: string,
  cols: number,
  rows: number
): { ptyId: string; dispatchId: string } {
  const task = store.getTask(taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)

  const branch = `orca/${task.id}`
  const worktree = join(repoRoot, '..', '.orca-worktrees', task.id)
  if (!existsSync(worktree)) {
    execFileSync('git', ['worktree', 'add', '-b', branch, worktree], { cwd: repoRoot, stdio: 'pipe' })
  }
  store.updateTask(task.id, { worktree, branch })

  const agent = AGENT_COMMANDS[task.agent]
  // dispatchId нужен до спавна PTY, чтобы положить его в env — генерируем заранее через store после спавна
  let dispatchId = ''
  const ptyId = spawnPty(
    win,
    {
      cwd: worktree,
      command: agent.command,
      args: agent.args,
      cols,
      rows,
      env: { ORCA_TASK_ID: task.id }
    },
    (id, code) => store.ptyExited(id, code)
  )
  dispatchId = store.startDispatch(task.id, ptyId).id
  return { ptyId, dispatchId }
}
