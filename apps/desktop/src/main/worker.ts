import { execFileSync } from 'node:child_process'
import { join, resolve, delimiter, isAbsolute, dirname } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { app } from 'electron'
import { newId, getAgent, withRoleInstructions, coordinatorPrompt, assistantRole, ASSISTANT_START_PROMPT, workerTaskPrompt, resumeCoordinatorObjective, imageAttachmentFileName, globalTaskTitle, type TaskStore, type Role, type ImageAttachment, type Run } from '@orca-board/core'
import { BUILTIN_PROMPTS } from './prompts'
import { defaultShell, isAlive, spawnPty, type PtyCommand } from './pty'
import { setupCommand } from './git'
import { extraPathDirs, findBin, isCmdScript, missingRoleMessage } from './agents'
import { assistantEnv } from './assistant'

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

/** Командная строка cmd.exe длиннее ~8191 символа обрезается молча — проверяем с запасом. */
const CMD_LINE_LIMIT = 8000

/**
 * Точка входа npm-шима (`claude.cmd`, `codex.cmd`), сгенерированного cmd-shim:
 * `"%_prog%"  "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*` (старые версии — `%~dp0\`).
 * Возвращает абсолютный путь к скрипту/программе или undefined, если шим не распознан.
 */
function npmShimTarget(shim: string): string | undefined {
  let text: string
  try {
    text = readFileSync(shim, 'utf8')
  } catch {
    return undefined
  }
  // Цель — последний путь от папки шима; `"%~dp0\node.exe"` старых шимов — это интерпретатор, не цель.
  const rel = [...text.matchAll(/"%(?:~dp0|dp0%)\\?([^"%]+\.(?:js|cjs|mjs|exe))"/gi)]
    .map((m) => m[1])
    .filter((p) => !/(^|\\)node\.exe$/i.test(p))
    .pop()
  if (!rel) return undefined
  const target = join(dirname(shim), rel)
  return existsSync(target) ? target : undefined
}

/**
 * Node для JS-точки входа шима: node.exe рядом с шимом (так делает сам шим), в сборке — Node из Electron
 * (ORCA_NODE, с ELECTRON_RUN_AS_NODE=1), иначе node из PATH.
 */
function win32Node(shim: string): { command: string; env: Record<string, string> } | undefined {
  const local = join(dirname(shim), 'node.exe')
  if (existsSync(local)) return { command: local, env: {} }
  if (app.isPackaged) return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
  const node = findBin('node')
  return node ? { command: node, env: {} } : undefined
}

interface Win32Launch extends PtyCommand {
  /** Доп. переменные окружения для агента (ELECTRON_RUN_AS_NODE при запуске через Electron). */
  env: Record<string, string>
}

/**
 * Запуск агента на Windows. Промпт и system prompt длинные и многострочные, поэтому по возможности
 * идут через argv node-pty (CreateProcess, лимит 32767, переводы строк сохраняются), а не через cmd.exe:
 * 1) `<bin>.exe` (или файл без расширения) — напрямую;
 * 2) npm-шим `<bin>.cmd` — node с JS-точкой входа из шима напрямую (или .exe, на который указывает шим);
 * 3) шим не распознан — `cmd.exe /d /s /c "<agent> <args>"` с экранированием; строка длиннее
 *    CMD_LINE_LIMIT — ошибка (cmd молча обрезал бы её), переводы строк при этом теряются.
 */
function win32Launch(command: string, args: string[]): Win32Launch {
  const bin = isAbsolute(command) ? command : (findBin(command) ?? command)
  if (!isCmdScript(bin)) return { command: bin, args, env: {} }
  const target = npmShimTarget(bin)
  if (target && /\.exe$/i.test(target)) return { command: target, args, env: {} }
  const node = target ? win32Node(bin) : undefined
  if (target && node) return { command: node.command, args: [target, ...args], env: node.env }
  const line = [cmdQuoteCommand(bin), ...args.map((a) => cmdQuoteArg(a, true))].join(' ')
  if (line.length > CMD_LINE_LIMIT) {
    throw new Error(
      `не удалось запустить ${command} на Windows: ${bin} — не стандартный npm-шим, а через cmd.exe ` +
        `командная строка (${line.length} символов) превышает лимит ${CMD_LINE_LIMIT}. ` +
        `Установите агента так, чтобы в PATH был ${command}.exe, или сократите описание задачи/цель.`
    )
  }
  return { command: 'cmd.exe', args: `/d /s /c "${line}"`, env: {} }
}

/**
 * Подготовка worktree на Windows — отдельным шагом перед агентом (spawnPty `before`), чтобы не
 * склеивать её с агентом в одну cmd-строку. Команда короткая (setupCommand), без пользовательского текста.
 * Агент стартует после неё с любым кодом выхода — как `;` на unix.
 */
function win32Setup(setup: string): PtyCommand {
  return { command: 'cmd.exe', args: `/d /s /c "echo [orca] ${setup} & ${setup}"` }
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
  store: TaskStore,
  repoRoot: string,
  ctx: WorkerEnvContext,
  taskId: string,
  cols = 120,
  rows = 30
): { ptyId: string; dispatchId: string; worktree: string; branch: string } {
  const task = store.getTask(taskId)
  if (!task) {
    // Карточка глобальной задачи — не подзадача: на ней работает координатор, а не воркер.
    if (store.getRun(taskId)) throw new Error(`${taskId} — глобальная задача, воркер на ней не запускается (координатор: global start)`)
    throw new Error(`task not found: ${taskId}`)
  }
  if (store.columnKind(task.status) === 'in_progress') throw new Error(`task already in progress: ${taskId}`)
  const role = ctx.roles.find((r) => r.id === task.roleId)
  if (!role) throw new Error(`воркер не запустится: ${missingRoleMessage(task.roleId, ctx.roles)}`)
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
  // Уточнение к задаче-ответу идёт вместе с прошлым ответом: воркер отвечает заново, а не с нуля.
  const snap = store.snapshot()
  const previousAnswer = snap.dispatches.filter((d) => d.taskId === task.id && d.answer).at(-1)?.answer
  // Ответы на вопросы прошлых запусков: перезапуск после ответа человека не должен спрашивать заново.
  const answers = snap.questions.filter((q) => q.taskId === task.id && q.answeredAt).sort((a, b) => a.createdAt - b.createdAt)
  const inv = spec.invoke(withRoleInstructions(BUILTIN_PROMPTS.worker, role), workerTaskPrompt(task, previousAnswer, answers), { permissionMode: ctx.permissionMode, shell: defaultShell(), model: role.model, effort: role.effort })

  // Свежий worktree без node_modules — ставим зависимости в том же PTY, потом exec агента.
  const setup = fresh ? setupCommand(worktree) : null
  const win32 = process.platform === 'win32' ? win32Launch(inv.command, inv.args) : undefined
  const { command, args } = win32
    ? win32
    : setup
      ? {
          command: defaultShell(),
          args: ['-c', `echo "[orca] ${setup}"; ${setup}; exec ${[inv.command, ...inv.args].map(shellQuote).join(' ')}`]
        }
      : { command: inv.command, args: inv.args }

  const ptyId = spawnPty(
    {
      meta: { role: 'worker', label: task.title, taskId: task.id, projectId: ctx.projectId },
      cwd: worktree,
      command,
      args,
      ...(win32 && setup ? { before: win32Setup(setup) } : {}),
      cols,
      rows,
      env: { ...baseEnv(ctx), ...win32?.env, ORCA_TASK_ID: task.id, ORCA_DISPATCH_ID: dispatchId }
    },
    (id, code) => store.ptyExited(id, code)
  )
  store.startDispatch(task.id, ptyId, dispatchId)
  return { ptyId, dispatchId, worktree, branch }
}

const ATTACHMENTS_DIR = '.orca-attachments'

/**
 * Папка изображений координатора: `<repoRoot>/.orca-attachments` — внутри cwd координатора (чтение
 * без лишних разрешений агенту), в том числе когда repoRoot сам linked worktree. Внутри лежит свой
 * `.gitignore` с `*`: папка не попадает в `git status`/`git add -A`, а .gitignore репозитория не трогаем.
 */
function attachmentsRoot(repoRoot: string): string {
  const root = join(repoRoot, ATTACHMENTS_DIR)
  try {
    mkdirSync(root, { recursive: true })
    const ignore = join(root, '.gitignore')
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
    return root
  } catch (e) {
    throw new Error(`не удалось создать папку ${ATTACHMENTS_DIR} для изображений координатора: ${(e as Error).message}`)
  }
}

/** Удаляет папки изображений закрытых прогонов, чей координатор уже не работает. */
function pruneAttachments(store: TaskStore, root: string): void {
  let dirs: string[]
  try {
    dirs = readdirSync(root)
  } catch {
    return
  }
  for (const id of dirs) {
    if (id === '.gitignore') continue
    const run = store.getRun(id)
    if (!run?.closedAt || (run.coordinatorPtyId && isAlive(run.coordinatorPtyId))) continue
    try {
      rmSync(join(root, id), { recursive: true, force: true })
    } catch (e) {
      console.error(`[orca] не удалось удалить вложения прогона ${id}:`, (e as Error).message)
    }
  }
}

/** Пишет изображения прогона в `<root>/<runId>/image-N.ext` и возвращает абсолютные пути. */
function writeAttachments(root: string, runId: string, images: ImageAttachment[]): string[] {
  const dir = join(root, runId)
  try {
    mkdirSync(dir, { recursive: true })
    return images.map((img, i) => {
      const file = join(dir, imageAttachmentFileName(i, img.ext))
      writeFileSync(file, img.data, { flag: 'wx', mode: 0o600 })
      return file
    })
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`не удалось сохранить изображения для координатора: ${(e as Error).message}`)
  }
}

/**
 * Проверка перед повторным запуском координатора на существующей глобальной задаче и его цель:
 * описание (нет — название) плюс список уже созданных подзадач, чтобы координатор продолжил их, а не
 * создал заново. Второй живой координатор на одной глобальной задаче — ошибка.
 */
export function resumeObjective(store: TaskStore, runId: string): { run: Run; objective: string } {
  const run = store.getRun(runId)
  if (!run) throw new Error(`глобальная задача не найдена: ${runId}`)
  if (run.inbox) throw new Error('«Входящие» — не цель для координатора: создай глобальную задачу')
  if (run.coordinatorPtyId && isAlive(run.coordinatorPtyId)) {
    throw new Error(`координатор этой глобальной задачи уже работает (терминал ${run.coordinatorPtyId})`)
  }
  const goal = run.objective.trim() || globalTaskTitle(run)
  const title = (status: string): string => store.columns().find((c) => c.id === status)?.title ?? status
  const tasks = store.listSubtasks(runId).map((t) => ({ id: t.id, title: t.title, status: title(t.status) }))
  return { run, objective: resumeCoordinatorObjective(goal, tasks) }
}

/**
 * Координатор: агент роли coordinator (нет такой роли — claude без модели) в корне репозитория с инструкцией и целью.
 * Без `runId` запуск создаёт новый прогон = глобальную задачу; с `runId` — повторный запуск на существующей
 * (цель — её описание и список подзадач, см. `resumeObjective`). Id прогона уходит координатору в ORCA_RUN_ID.
 * `images` (уже проверенные `validateImageAttachments`) сохраняются файлами на время прогона,
 * в промпт уходят только их пути — содержимое через терминал не передаётся.
 */
/**
 * PTY координатора закрылся: его открытые вопросы больше некому разбирать — они уходят человеку
 * (запросы к человеку). Прогон могли удалить, пока терминал жил, — тогда нечего эскалировать.
 */
function escalateAfterCoordinator(store: TaskStore, runId: string): void {
  if (!store.getRun(runId)) return
  store.escalateOpenQuestions(runId)
}

export function startCoordinator(
  store: TaskStore,
  repoRoot: string,
  ctx: WorkerEnvContext,
  objective: string,
  cols = 120,
  rows = 30,
  images: ImageAttachment[] = [],
  runId?: string
): { ptyId: string; runId: string } {
  // Роль coordinator можно удалить в «О проекте»; молча запускать claude вместо неё нельзя — человек её убрал.
  const role = ctx.roles.find((r) => r.id === 'coordinator')
  if (!role) throw new Error(`координатор не запустится: ${missingRoleMessage('coordinator', ctx.roles)}`)
  const spec = getAgent(role.agent)
  if (!spec) throw new Error(`неизвестный агент: ${role.agent}`)
  const resume = runId !== undefined ? resumeObjective(store, runId) : undefined
  if (resume) objective = resume.objective
  const root = images.length > 0 ? attachmentsRoot(repoRoot) : undefined
  if (root) pruneAttachments(store, root)
  const run = resume?.run ?? store.createRun(objective)
  let ptyId: string
  try {
    // Вложения прошлого запуска этой глобальной задачи: координатор не жив (проверено), файлы не нужны.
    if (root && resume) rmSync(join(root, run.id), { recursive: true, force: true })
    const paths = root ? writeAttachments(root, run.id, images) : []
    const inv = spec.invoke(withRoleInstructions(BUILTIN_PROMPTS.coordinator, role), coordinatorPrompt(objective, paths), {
      permissionMode: ctx.permissionMode,
      shell: defaultShell(),
      model: role.model,
      effort: role.effort
    })
    const launch = process.platform === 'win32' ? win32Launch(inv.command, inv.args) : { ...inv, env: {} }
    ptyId = spawnPty({
      meta: { role: 'coordinator', label: 'координатор', projectId: ctx.projectId, runId: run.id },
      cwd: repoRoot,
      command: launch.command,
      args: launch.args,
      cols,
      rows,
      env: {
        ...baseEnv(ctx),
        ...launch.env,
        ORCA_ROLE: 'coordinator',
        ORCA_RUN_ID: run.id,
        // Таймауты Bash-инструмента Claude Code: координатор подолгу ждёт воркеров в check --wait/--follow.
        BASH_DEFAULT_TIMEOUT_MS: '1800000',
        BASH_MAX_TIMEOUT_MS: '3600000'
      }
    }, () => escalateAfterCoordinator(store, run.id))
  } catch (e) {
    // Координатор не запустился — пустой прогон не оставляем висеть открытым, его файлы не храним.
    // Существующую глобальную задачу не трогаем: она жила и до этого запуска.
    if (!resume) store.closeRun(run.id)
    if (root) rmSync(join(root, run.id), { recursive: true, force: true })
    throw e
  }
  store.setRunPty(run.id, ptyId, role.agent)
  return { ptyId, runId: run.id }
}

/** Контекст ассистента: он один на приложение, поэтому без проекта — роли и режим из настроек по умолчанию. */
export type AssistantContext = Omit<WorkerEnvContext, 'projectId'>

/**
 * Ассистент доски: интерактивный агент роли assistant (нет такой роли — агент роли coordinator, нет и её — claude).
 * Один на всё приложение: работает со всеми проектами через orca-board --project (без флага — активный в UI).
 * cwd — нейтральный userData/assistant, а не репозиторий: файлового доступа к проектам у ассистента нет.
 * Прогон не создаётся и ORCA_RUN_ID нет (skills/assistant.md).
 */
export function startAssistant(ctx: AssistantContext, cols = 120, rows = 30): { ptyId: string } {
  const role = assistantRole(ctx.roles)
  const spec = getAgent(role?.agent ?? 'claude')
  if (!spec) throw new Error(`неизвестный агент: ${role?.agent}`)
  const inv = spec.invoke(withRoleInstructions(BUILTIN_PROMPTS.assistant, role), ASSISTANT_START_PROMPT, {
    permissionMode: ctx.permissionMode,
    shell: defaultShell(),
    model: role?.model,
    effort: role?.effort
  })
  const cwd = join(app.getPath('userData'), 'assistant')
  mkdirSync(cwd, { recursive: true })
  const launch = process.platform === 'win32' ? win32Launch(inv.command, inv.args) : { ...inv, env: {} }
  const ptyId = spawnPty({
    meta: { role: 'assistant', label: 'ассистент' },
    cwd,
    command: launch.command,
    args: launch.args,
    cols,
    rows,
    env: {
      ...assistantEnv({ socketPath: ctx.socketPath, path: workerPath(), nodePath: app.isPackaged ? process.execPath : undefined }),
      ...launch.env
    }
  })
  return { ptyId }
}
