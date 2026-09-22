import { execFileSync } from 'node:child_process'
import { join, resolve, delimiter, isAbsolute } from 'node:path'
import { existsSync } from 'node:fs'
import { app, type BrowserWindow } from 'electron'
import { newId, getAgent, type TaskStore, type Role } from '@orca-board/core'
import workerSkill from '../../../../skills/worker.md?raw'
import coordinatorSkill from '../../../../skills/coordinator.md?raw'
import { defaultShell, spawnPty } from './pty'
import { setupCommand } from './git'
import { extraPathDirs, findBin, isCmdScript } from './agents'

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

/** Метасимволы cmd.exe, перед которыми ставится ^. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/**
 * Аргумент для командной строки `cmd.exe /d /s /c "..."` (схема как в cross-spawn):
 * 1) кавычки по правилам MSVCRT, чтобы запускаемая программа получила аргумент целиком:
 *    `"` → `\"`, обратные слэши перед `"` и в конце строки удваиваются;
 * 2) ^ перед метасимволами cmd (& | < > ^ % ! " и т.п.), чтобы cmd не выполнил их сам.
 * .cmd/.bat-shim (npm: claude.cmd) ещё раз разбирает аргументы через cmd (`%*`) — там ^ удваивается.
 * Перевод строки cmd передать не умеет (обрывает команду) — заменяется пробелом.
 */
function cmdQuoteArg(arg: string, doubleEscape: boolean): string {
  const msvcrt = `"${arg
    .replace(/\r?\n/g, ' ')
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, '$1$1')}"`
  const once = msvcrt.replace(CMD_META, '^$1')
  return doubleEscape ? once.replace(CMD_META, '^$1') : once
}

/** Имя/путь программы для cmd.exe: только ^ перед метасимволами (включая пробелы в пути). */
function cmdQuoteCommand(cmd: string): string {
  return cmd.replace(CMD_META, '^$1')
}

/**
 * Запуск агента на Windows. .exe без подготовки — напрямую: node-pty сам квотирует argv,
 * многострочный промпт доходит целиком. Иначе (.cmd-shim или есть setup) — через
 * `cmd.exe /d /s /c "<setup> & <agent> <args>"`; args строкой, чтобы node-pty не переквотировал.
 * `&`, а не `&&` — как `;` на unix: агент стартует, даже если установка зависимостей упала.
 */
function win32Launch(command: string, args: string[], setup: string | null): { command: string; args: string[] | string } {
  const bin = isAbsolute(command) ? command : (findBin(command) ?? command)
  const shim = isCmdScript(bin)
  if (!setup && !shim) return { command: bin, args }
  const agent = [cmdQuoteCommand(bin), ...args.map((a) => cmdQuoteArg(a, shim))].join(' ')
  const line = setup ? `echo [orca] ${setup} & ${setup} & ${agent}` : agent
  return { command: 'cmd.exe', args: `/d /s /c "${line}"` }
}

/** PATH для терминалов и агентов: bin CLI orca-board, PATH процесса, стандартные папки с агентами. */
export function workerPath(): string {
  return [cliBinDir(), ...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...extraPathDirs()].join(delimiter)
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
  const inv = spec.invoke(workerSkill, prompt, { permissionMode: ctx.permissionMode, shell: defaultShell(), model: role.model, effort: role.effort })

  // Свежий worktree без node_modules — ставим зависимости в том же PTY, потом exec агента.
  const setup = fresh ? setupCommand(worktree) : null
  const { command, args } =
    process.platform === 'win32'
      ? win32Launch(inv.command, inv.args, setup)
      : setup
        ? {
            command: defaultShell(),
            args: ['-c', `echo "[orca] ${setup}"; ${setup}; exec ${[inv.command, ...inv.args].map(shellQuote).join(' ')}`]
          }
        : { command: inv.command, args: inv.args }

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
    shell: defaultShell(),
    model: role?.model,
    effort: role?.effort
  })
  const run = store.createRun(objective)
  const launch = process.platform === 'win32' ? win32Launch(inv.command, inv.args, null) : inv
  let ptyId: string
  try {
    ptyId = spawnPty(win, {
      cwd: repoRoot,
      command: launch.command,
      args: launch.args,
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
