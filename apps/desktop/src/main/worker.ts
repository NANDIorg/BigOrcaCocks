import { execFileSync } from 'node:child_process'
import { join, resolve, delimiter } from 'node:path'
import { existsSync } from 'node:fs'
import { app, type BrowserWindow } from 'electron'
import { newId, getAgent, type TaskStore, type Role } from '@orca-board/core'
import workerSkill from '../../../../skills/worker.md?raw'
import coordinatorSkill from '../../../../skills/coordinator.md?raw'
import { spawnPty } from './pty'
import { setupCommand } from './git'
import { extraPathDirs } from './agents'

export type PermissionMode = 'auto' | 'bypassPermissions' | 'acceptEdits'

export interface WorkerEnvContext {
  socketPath: string
  projectId: string
  permissionMode: PermissionMode
  /** Роли проекта: из них берутся агент и модель для задачи и координатора. */
  roles: Role[]
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

/** PATH для терминалов и агентов: bin CLI orca-board, PATH процесса, стандартные папки с агентами. */
export function workerPath(): string {
  return [cliBinDir(), ...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...extraPathDirs()].join(delimiter)
}

/** Оболочка пользователя — для агента shell и для установочного шага. */
function userShell(): string {
  return process.env.SHELL ?? '/bin/zsh'
}

function baseEnv(ctx: WorkerEnvContext): Record<string, string> {
  return {
    // В собранном приложении внешнего Node может не быть — обёртка orca-board использует Node из Electron.
    ...(app.isPackaged ? { ORCA_NODE: process.execPath } : {}),
    ORCA_SOCKET: ctx.socketPath,
    ORCA_PROJECT: ctx.projectId,
    PATH: workerPath()
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
  if (store.columnKind(task.status) === 'in_progress') throw new Error(`task already in progress: ${taskId}`)
  const role = ctx.roles.find((r) => r.id === task.roleId)
  if (!role) throw new Error(`роль ${task.roleId} не найдена в проекте`)
  const spec = getAgent(role.agent)
  if (!spec) throw new Error(`неизвестный агент: ${role.agent}`)

  const branch = `orca/${task.id}`
  const worktree = join(repoRoot, '..', '.orca-worktrees', task.id)
  let fresh = false
  if (!existsSync(worktree)) {
    const branchExists = execFileSync('git', ['branch', '--list', branch], { cwd: repoRoot }).toString().trim() !== ''
    const args = branchExists ? ['worktree', 'add', worktree, branch] : ['worktree', 'add', '-b', branch, worktree]
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' })
    fresh = true
  }
  // Агент задачи синхронизируется с ролью: роль могли перенастроить после создания задачи.
  store.updateTask(task.id, { agent: role.agent, worktree, branch })

  const dispatchId = newId('disp')
  const feedback = task.feedback ? `\n\n# Замечания после ревью\n\n${task.feedback}` : ''
  const prompt = [`# Задача: ${task.title}`, '', task.spec || '(описание не задано)', feedback].join('\n')
  const inv = spec.invoke(workerSkill, prompt, { permissionMode: ctx.permissionMode, shell: userShell(), model: role.model, effort: role.effort })

  // Свежий worktree без node_modules — ставим зависимости в том же PTY, потом exec агента.
  const setup = fresh ? setupCommand(worktree) : null
  const command = setup ? userShell() : inv.command
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

/**
 * Координатор: агент роли coordinator (нет такой роли — claude без модели) в корне репозитория с инструкцией и целью.
 * Каждый запуск — новый прогон (Run): его id уходит координатору в ORCA_RUN_ID.
 */
export function startCoordinator(
  win: BrowserWindow,
  store: TaskStore,
  repoRoot: string,
  ctx: WorkerEnvContext,
  objective: string,
  cols = 120,
  rows = 30
): { ptyId: string; runId: string } {
  const prompt = `Цель: ${objective}\n\nНачни с декомпозиции и создания задач через orca-board.`
  const role = ctx.roles.find((r) => r.id === 'coordinator')
  const spec = role ? getAgent(role.agent) : undefined
  if (role && !spec) throw new Error(`неизвестный агент: ${role.agent}`)
  const inv = (spec ?? getAgent('claude')!).invoke(coordinatorSkill, prompt, {
    permissionMode: ctx.permissionMode,
    shell: userShell(),
    model: role?.model,
    effort: role?.effort
  })
  const run = store.createRun(objective)
  let ptyId: string
  try {
    ptyId = spawnPty(win, {
      cwd: repoRoot,
      command: inv.command,
      args: inv.args,
      cols,
      rows,
      env: {
        ...baseEnv(ctx),
        ORCA_ROLE: 'coordinator',
        ORCA_RUN_ID: run.id,
        // Таймауты Bash-инструмента Claude Code: координатор подолгу ждёт воркеров в check --wait/--follow.
        BASH_DEFAULT_TIMEOUT_MS: '1800000',
        BASH_MAX_TIMEOUT_MS: '3600000'
      }
    })
  } catch (e) {
    // Координатор не запустился — пустой прогон не оставляем висеть открытым.
    store.closeRun(run.id)
    throw e
  }
  store.setRunPty(run.id, ptyId)
  return { ptyId, runId: run.id }
}
