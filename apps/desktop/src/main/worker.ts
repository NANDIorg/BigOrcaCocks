import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join, resolve, delimiter, isAbsolute, dirname } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { app } from 'electron'
import { newId, getAgent, agentSystemPrompt, coordinatorPrompt, assistantRole, ASSISTANT_START_PROMPT, workerTaskPrompt, imageAttachmentFileName, type AgentSpec, type TaskStore, type Role, type ImageAttachment, type RunBranchSettings, type RunTypeInput, type Workflow } from '@orca-board/core'
import { BUILTIN_PROMPTS } from './prompts'
import { defaultShell, isAlive, killPty, spawnPty, type PtyCommand } from './pty'
import { setupCommand, taskWorktreePath } from './git'
import { extraPathDirs, findBin, isCmdScript, missingRoleText } from './agents'
import { OrcaError, mainLocale } from './i18n'
import { assistantEnv } from './assistant'
import { resumeObjective, returnGlobalTaskToWork } from './coordinator-resume'
import { ensureRunBranch } from './run-branch'

export type PermissionMode = 'auto' | 'bypassPermissions' | 'acceptEdits'

export interface WorkerEnvContext {
  socketPath: string
  projectId: string
  /** Режим разрешений типа задачи прогона (`resolveRunType`). */
  permissionMode: PermissionMode
  /** Роли типа задачи прогона: из них берутся агент и модель для задачи и координатора. */
  roles: Role[]
  /** Название типа задачи прогона — для ошибки «роли нет в типе задачи» (`missingRoleMessage`). */
  typeTitle: string
  /** Правила агентов типа задачи прогона: блок «Правила проекта» в системном промпте воркеров и координатора. */
  agentRules?: string
  /**
   * Граф типа прогона, который исполнитель может выполнить (`runnableWorkflow`): запасной для прогона без снимка
   * графа — по нему ищется этап «Работа» для промпта воркера. Нет — дефолтный по ролям.
   */
  workflow?: Workflow
  /** Тип нового прогона координатора: id, снимок и граф уходят в `Run.typeId`, `Run.taskType`, `Run.workflow`. */
  type?: RunTypeInput
  /** Ветки глобальных задач проекта (`Project.git`): заводить ли ветку фичи, от чего и как назвать. */
  git: RunBranchSettings
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
 * Id сессии агента для статистики (docs/architecture.md → «Статистика»): uuid задаётся агенту при запуске, и
 * main находит его транскрипт без догадок. Агент, которому id не задать, — `undefined` (codex ищется по cwd).
 */
function agentSessionId(spec: AgentSpec): string | undefined {
  return spec.acceptsSessionId ? randomUUID() : undefined
}

/**
 * Старт воркера: git worktree на ветке задачи → подготовка → PTY с агентом → dispatch.
 * Worktree создаётся рядом с репозиторием: <repo>/../.orca-worktrees/<taskId>. Ветка `orca/<taskId>` ответвляется
 * от ветки глобальной задачи (`ensureRunBranch`), а без неё — от текущего HEAD корня, как раньше.
 */
export function startWorker(
  store: TaskStore,
  repoRoot: string,
  ctx: WorkerEnvContext,
  taskId: string,
  cols = 120,
  rows = 30,
  roleId?: string
): { ptyId: string; dispatchId: string; worktree: string; branch: string } {
  const task = store.getTask(taskId)
  if (!task) {
    // Карточка глобальной задачи — не подзадача: на ней работает координатор, а не воркер.
    if (store.getRun(taskId)) throw new Error(`${taskId} — глобальная задача, воркер на ней не запускается (координатор: global start)`)
    throw new Error(`task not found: ${taskId}`)
  }
  if (store.columnKind(task.status) === 'in_progress') throw new Error(`task already in progress: ${taskId}`)
  // Роль этапа «Вопрос человеку» — только на этот запуск: задача сохраняет свою роль (`store.updateTask` ниже).
  const runRoleId = roleId ?? task.roleId
  const role = ctx.roles.find((r) => r.id === runRoleId)
  if (!role) throw new OrcaError('worker.cannotStart', { reason: missingRoleText(runRoleId, { title: ctx.typeTitle, roles: ctx.roles }) })
  const spec = getAgent(role.agent)
  if (!spec) throw new Error(`неизвестный агент: ${role.agent}`)

  // Ветку и worktree могла уже назначить нода воркфлоу «Git» (`create_branch`/`checkout`): работаем на них, а не
  // заводим `orca/<id>`. Нет worktree на диске (конец без мержа, удалили руками) — ставим на ту же ветку.
  const branch = task.branch ?? `orca/${task.id}`
  const worktree = task.worktree ?? taskWorktreePath(repoRoot, task.id)
  const runGit = ensureRunBranch(store, repoRoot, task.runId, ctx.git)
  let fresh = false
  if (!existsSync(worktree)) {
    const branchExists = execFileSync('git', ['branch', '--list', branch], { cwd: repoRoot }).toString().trim() !== ''
    const args = branchExists
      ? ['worktree', 'add', worktree, branch]
      : ['worktree', 'add', '-b', branch, worktree, ...(runGit ? [runGit.branch] : [])]
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' })
    fresh = true
  }
  // Агент задачи синхронизируется с ролью: роль могли перенастроить после создания задачи. Роль этапа «Вопрос
  // человеку» задачу не меняет (агент задачи остаётся прежним).
  store.updateTask(task.id, { ...(roleId ? {} : { agent: role.agent }), worktree, branch })

  const dispatchId = newId('disp')
  // Уточнение к задаче-ответу идёт вместе с прошлым ответом: воркер отвечает заново, а не с нуля.
  const snap = store.snapshot()
  const previousAnswer = snap.dispatches.filter((d) => d.taskId === task.id && d.answer).at(-1)?.answer
  // Ответы на вопросы прошлых запусков: перезапуск после ответа человека не должен спрашивать заново.
  const answers = snap.questions.filter((q) => q.taskId === task.id && q.answeredAt).sort((a, b) => a.createdAt - b.createdAt)
  // Этап «Работа» графа: его инструкция и требование показа человеку — раздел «Этап» в задании.
  const stage = task.answerFor
    ? undefined
    : store.taskWorkStage(task.id, { roleIds: ctx.roles.map((r) => r.id), ...(ctx.workflow ? { workflow: ctx.workflow } : {}) })
  const sessionId = agentSessionId(spec)
  const inv = spec.invoke(agentSystemPrompt(BUILTIN_PROMPTS.worker, { projectRules: ctx.agentRules, role, language: mainLocale() }), workerTaskPrompt(task, previousAnswer, answers, stage), { permissionMode: ctx.permissionMode, shell: defaultShell(), model: role.model, effort: role.effort, sessionId })

  // Свежий worktree без node_modules — ставим зависимости в том же PTY, потом exec агента.
  // Worktree, который создала нода «Git» до первого запуска, тоже «свежий»: зависимостей в нём ещё нет.
  const setup = fresh || !snap.dispatches.some((d) => d.taskId === task.id) ? setupCommand(worktree) : null
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
  store.startDispatch(task.id, ptyId, dispatchId, { roleId: role.id, agent: role.agent, model: role.model, sessionId })
  return { ptyId, dispatchId, worktree, branch }
}

const ATTACHMENTS_DIR = '.orca-attachments'

/**
 * Папка изображений координатора: `<cwd>/.orca-attachments` — внутри cwd координатора (чтение без лишних
 * разрешений агенту): worktree ветки глобальной задачи или корень. Внутри лежит свой `.gitignore` с `*`: папка
 * не попадает в `git status`/`git add -A`, не мешает `git worktree remove` без `--force`, а .gitignore
 * репозитория не трогаем.
 */
function attachmentsRoot(cwd: string): string {
  const root = join(cwd, ATTACHMENTS_DIR)
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
 * Координатор: агент роли coordinator (нет такой роли — claude без модели) с инструкцией и целью — в worktree ветки
 * глобальной задачи (`ensureRunBranch`), а без неё — в корне репозитория.
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
  // Вышел после run_done без `runs finish` — прогон закрывается, карточка на «Проверку».
  store.settleIdleRuns(isAlive)
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
  // Роль coordinator можно удалить из типа задачи («Настройки» → «Типы задач»); молча запускать claude вместо неё нельзя — человек её убрал.
  const role = ctx.roles.find((r) => r.id === 'coordinator')
  if (!role) throw new OrcaError('coordinator.cannotStart', { reason: missingRoleText('coordinator', { title: ctx.typeTitle, roles: ctx.roles }) })
  const spec = getAgent(role.agent)
  if (!spec) throw new Error(`неизвестный агент: ${role.agent}`)
  const resume = runId !== undefined ? resumeObjective(store, runId, isAlive) : undefined
  if (resume) objective = resume.objective
  const run = resume?.run ?? store.createRun(objective, undefined, ctx.type)
  let ptyId: string
  let root: string | undefined
  const sessionId = agentSessionId(spec)
  try {
    // Ветка фичи заводится до координатора: он декомпозирует по коду этой ветки, воркеры ответвятся от неё.
    const cwd = ensureRunBranch(store, repoRoot, run.id, ctx.git)?.worktree ?? repoRoot
    root = images.length > 0 ? attachmentsRoot(cwd) : undefined
    if (root) pruneAttachments(store, root)
    // Вложения прошлого запуска этой глобальной задачи: координатор не жив (проверено), файлы не нужны.
    if (root && resume) rmSync(join(root, run.id), { recursive: true, force: true })
    const paths = root ? writeAttachments(root, run.id, images) : []
    const inv = spec.invoke(agentSystemPrompt(BUILTIN_PROMPTS.coordinator, { projectRules: ctx.agentRules, role, language: mainLocale() }), coordinatorPrompt(objective, paths), {
      permissionMode: ctx.permissionMode,
      shell: defaultShell(),
      model: role.model,
      effort: role.effort,
      sessionId
    })
    const launch = process.platform === 'win32' ? win32Launch(inv.command, inv.args) : { ...inv, env: {} }
    ptyId = spawnPty({
      meta: { role: 'coordinator', label: 'координатор', projectId: ctx.projectId, runId: run.id },
      cwd,
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
    }, (id) => {
      store.coordinatorExited(run.id, id)
      escalateAfterCoordinator(store, run.id)
    })
  } catch (e) {
    // Координатор не запустился — пустой прогон не оставляем висеть открытым, его файлы не храним.
    // Существующую глобальную задачу не трогаем: она жила и до этого запуска.
    if (!resume) store.closeRun(run.id)
    if (root) rmSync(join(root, run.id), { recursive: true, force: true })
    throw e
  }
  store.setRunPty(run.id, ptyId, role.agent, { roleId: role.id, agent: role.agent, model: role.model, sessionId })
  return { ptyId, runId: run.id }
}

/**
 * «Вернуть в работу» с «Проверки»: уточнение человека сохраняется в прогоне (`returnGlobalTask`), и координатор
 * запускается повторно — уточнение он получит в цели (`resumeObjective` → `resumeCoordinatorObjective`).
 * Прежний координатор, если его терминал ещё жив, закрывается после правки стора (`returnGlobalTaskToWork`):
 * иначе возврат был бы недоступен, пока агент сам не выйдет.
 * Упал запуск после возврата — карточка остаётся «В работе» с уточнением, «Запустить координатора» его подхватит.
 */
export function returnToWork(
  store: TaskStore,
  repoRoot: string,
  ctx: WorkerEnvContext,
  runId: string,
  text: string,
  cols = 120,
  rows = 30
): { ptyId: string; runId: string } {
  returnGlobalTaskToWork(store, runId, text, isAlive, killPty)
  return startCoordinator(store, repoRoot, ctx, '', cols, rows, [], runId)
}

/**
 * Контекст ассистента: он один на приложение, поэтому без проекта — роли и режим из типа библиотеки по умолчанию.
 * Правил проекта у него нет: они относятся к агентам, работающим в репозитории проекта.
 */
export type AssistantContext = Omit<WorkerEnvContext, 'projectId' | 'agentRules' | 'git'>

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
  const inv = spec.invoke(agentSystemPrompt(BUILTIN_PROMPTS.assistant, { role, language: mainLocale() }), ASSISTANT_START_PROMPT, {
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
