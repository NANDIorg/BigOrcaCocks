import { app, BrowserWindow, ipcMain, net, shell, dialog, Notification, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { defaultSocketPath, validateImageAttachments, coordinatorsToClose, getAgent, DEFAULT_IMAGE_OBJECTIVE, resolveTaskType, withStatusSource, STATS_RANGES, type StatsRange, type ProjectStats, type TaskStats, type GlobalTaskStats, type ImageAttachment, type TaskStore, type Task, type OrcaEvent, type AgentKind, type AgentInfo, type BoardColumn, type RequestResolution, type TaskPriority, type ResolvedRunType } from '@orca-board/core'
import { spawnPty, writePty, resizePty, killPty, killAll, silentFor, lastActivityAt, isAlive, setPtyWindow, terminalSnapshots } from './pty'
import { startWorker, startCoordinator, startAssistant, returnToWork, workerPath, type WorkerEnvContext } from './worker'
import { getReview, resolveHumanRequest } from './review'
import { hasImageInput, rejectWithImages, resolveWithImages, returnRunWithImages } from './attachments'
import { readShowcaseFile, resolveShowcasePath, showcaseRoot } from './showcase'
import { approvalResolved, enterWork, handleWorkflowEvents, reviewAccept, reviewReject, type WorkflowDeps } from './workflow'
import {
  acceptRun, finishRunStage, handleRunApproval, handleRunWorkflowEvents, isRunGate, isRunScope, returnRun, runGateDecision, settleIdleRunStages, startRunWorkflow,
  type RunWorkflowDeps
} from './workflow-run'
import { listDocGroups, readDoc, resolveDocPath, PROJECT_SOURCE, type DocTask } from './docs'
import { listRules, writeRule } from './rules'
import { currentBranch, projectBranchInfo, projectBranches, projectFetch, projectPull, checkoutProjectBranch } from './git'
import { mergeTarget, removeRunWorktree, RunBranchSync } from './run-branch'
import { startSocketServer, askWaiting, answerQuestion, syncWorkerLiveness } from './socket'
import { ProjectManager, runnableWorkflow } from './projects'
import { agentInfos, assertAgentUsable, missingRoleText, pickRole } from './agents'
import { BUILTIN_PROMPTS } from './prompts'
import { createTray, refreshTray } from './tray'
import { projectStats, taskStats, globalTaskStats, type StatsDeps } from './stats'
import { createUpdater, type Updater, type InstallChoice, type InstallRequest } from './updater'
import { createPlatformUpdater } from './updaterBackend'
import type { AppSettingsPatch, UpdateInstallWhen, ProjectTaskTypesInput, TaskTypeInput, NodeTemplateInput, RequestListOptions, RequestFocus, GlobalTaskInput, GlobalTaskPatch, PtySpawnOptions, SubtaskInput, TaskPatch, OnboardingCompleteInput, ProjectBranchInfo } from '../shared/ipc'
import { shouldNotify } from '../shared/notifications'
import { describeEvent, answerNudge } from './notify'
import { backupOnVersionChange, getJustUpdatedFrom, rememberUpdate } from './backup'
import { OrcaError, ipcError, mt, setMainLocale } from './i18n'
import { columnTitle } from './defaultTitles'

// Имя пакета скоупное (@orca-board/desktop) — задаём userData явно, чтобы путь был предсказуем.
app.setName('orca-board')

/**
 * PATH из интерактивной оболочки пользователя. Приложение, запущенное из Dock или из чужой
 * сессии, получает урезанный PATH, и агенты (claude, codex) находятся не те или не находятся вовсе.
 */
function shellPath(): string | null {
  if (process.platform === 'win32') return null
  try {
    const sh = process.env.SHELL ?? '/bin/zsh'
    const out = execFileSync(sh, ['-ilc', 'printf "%s" "$PATH"'], {
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString()
    const line = out.split('\n').filter(Boolean).pop()?.trim()
    return line && line.includes('/') ? line : null
  } catch {
    return null
  }
}
const userPath = shellPath()
if (userPath) process.env.PATH = userPath
app.setPath('userData', join(app.getPath('appData'), 'orca-board'))

// Второй экземпляр отобрал бы у первого сокет и писал бы в те же файлы состояния — он фокусирует первый и выходит.
// Блокировка привязана к userData, поэтому изолированный `pnpm dev` со своим userData живёт рядом с основным.
// `app.exit`, а не `quit`: before-quit → requestQuit трогает то, что у второго экземпляра не создано.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.exit(0)
else app.on('second-instance', () => { if (app.isReady()) showWindow() })

let win: BrowserWindow | null = null
let projects: ProjectManager
let updater: Updater
/** Уборка worktree веток глобальных задач (`run-branch.ts`): неудачные попытки помнит между изменениями доски. */
const runBranchSync = new RunBranchSync({ isAlive })
/** Выход подтверждён (или подтверждать нечего) — before-quit больше не перехватываем. */
let quitting = false
/** Диалог подтверждения уже открыт — второй не показываем. */
let confirmingQuit = false

const SOCKET_PATH = defaultSocketPath({ env: process.env, platform: process.platform, homedir: homedir() })
const STUCK_MS = Number(process.env.ORCA_STUCK_MINUTES ?? 10) * 60_000

function createWindow(): BrowserWindow {
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    title: 'orca-board',
    backgroundColor: '#26282e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  setPtyWindow(win)
  const created = win
  win.on('closed', () => {
    if (win === created) win = null
    setPtyWindow(win)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

/** Показать окно: существующее — развернуть и сфокусировать, закрытое — создать заново. */
function showWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return win
  }
  return createWindow()
}

/** Незавершённые dispatch'и по всем загруженным проектам (для трея). */
function activeDispatchCount(): number {
  return projects.loadedStores().reduce((n, [, store]) => n + store.activeDispatches().length, 0)
}

/** Воркеры, которых выход реально остановит: dispatch не завершён и PTY жив. */
function liveWorkerCount(): number {
  return projects.loadedStores().reduce((n, [, store]) => n + store.activeDispatches().filter((d) => isAlive(d.ptyId)).length, 0)
}

function quitNow(): void {
  quitting = true
  killAll()
  // Обновление скачано и установка при выходе не снята — её установщик сам завершит приложение.
  if (updater.installOnQuit()) return
  app.quit()
}

/** Единая точка выхода: при живых воркерах — подтверждение. */
async function requestQuit(): Promise<void> {
  if (quitting || confirmingQuit) return
  const n = liveWorkerCount()
  if (n === 0) return quitNow()
  confirmingQuit = true
  try {
    const opts = {
      type: 'warning' as const,
      message: mt('dialog.quit.message', { count: n }),
      buttons: [mt('dialog.quit.quit'), mt('dialog.cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    }
    const parent = win && !win.isDestroyed() ? win : null
    const { response } = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts)
    if (response === 0) quitNow()
  } finally {
    confirmingQuit = false
  }
}

/**
 * Подтверждение установки обновления (`UpdaterHost.confirmInstall`) — тот же диалог, что у выхода, только с выбором
 * «сейчас / когда агенты закончат / отмена». Делит `confirmingQuit` с `requestQuit`: два диалога сразу не показываем.
 */
async function confirmInstall(req: InstallRequest): Promise<InstallChoice> {
  if (confirmingQuit) return 'cancel'
  confirmingQuit = true
  try {
    const parent = win && !win.isDestroyed() ? win : null
    const opts =
      req.reason === 'idle-reached'
        ? {
            type: 'question' as const,
            message: mt('dialog.update.idleReached', { version: req.version }),
            buttons: [mt('dialog.update.restart'), mt('dialog.update.later')],
            defaultId: 0,
            cancelId: 1,
            noLink: true
          }
        : {
            type: 'warning' as const,
            message: mt('dialog.update.busy', { count: req.workers, version: req.version }),
            buttons: [mt('dialog.update.now'), mt('dialog.update.whenIdle'), mt('dialog.cancel')],
            defaultId: 1,
            cancelId: 2,
            noLink: true
          }
    const { response } = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts)
    if (req.reason === 'idle-reached') return response === 0 ? 'now' : 'cancel'
    return response === 0 ? 'now' : response === 1 ? 'idle' : 'cancel'
  } finally {
    confirmingQuit = false
  }
}

/** Версия, с которой приложение только что обновилось («Обновлено до …»): итог бэкапа при смене версии (`backup.ts`). */
function takeJustUpdated(): string | null {
  return getJustUpdatedFrom()
}

/**
 * Окружение агентов прогона `runId`: роли, правила и разрешения — из типа его глобальной задачи
 * (`projects.resolveRun`); без прогона («Входящие») — из типа проекта по умолчанию.
 */
function ctx(projectId: string, runId?: string): WorkerEnvContext {
  return typeCtx(projectId, projects.resolveRun(projectId, runId))
}

function typeCtx(projectId: string, type: ResolvedRunType): WorkerEnvContext {
  return {
    socketPath: SOCKET_PATH,
    projectId,
    permissionMode: type.permissionMode,
    roles: type.roles,
    typeTitle: type.title,
    agentRules: type.agentRules,
    ...(runnableWorkflow(type.workflow) ? { workflow: runnableWorkflow(type.workflow) } : {})
  }
}

/** Агенты с учётом настроек проекта; refresh — пересканировать PATH. */
function projectAgents(projectId: string, refresh = false): AgentInfo[] {
  return agentInfos(projects.get(projectId)?.enabledAgents, refresh)
}

/**
 * Статистика проекта `projectId` за период. Названия ролей — из типов всех его глобальных задач и типа по
 * умолчанию: роль удалённого типа остаётся в снимке прогона.
 */
function statsDeps(projectId: string): StatsDeps & { projectId: string } {
  const p = resolveProject(projectId)
  const titles = new Map<string, string>()
  const addRoles = (runId?: string): void => {
    for (const r of projects.roles(p.id, runId)) if (!titles.has(r.id)) titles.set(r.id, r.title)
  }
  addRoles()
  for (const run of p.store.snapshot().runs) addRoles(run.id)
  return {
    projectId: p.id,
    store: p.store,
    repoRoot: p.root,
    columns: projects.columns(p.id),
    roleTitle: (id) => titles.get(id),
    isAlive
  }
}

function collectProjectStats(projectId: string, range: StatsRange): Promise<ProjectStats> {
  return projectStats({ ...statsDeps(projectId), range })
}

function collectTaskStats(projectId: string, taskId: string): Promise<TaskStats> {
  const deps = statsDeps(projectId)
  // Граф прогона задачи — только для названий этапов; без прогона («Входящие») берётся граф типа по умолчанию.
  const workflow = runnableWorkflow(projects.resolveRun(deps.projectId, deps.store.getTask(taskId)?.runId).workflow)
  return taskStats({ ...deps, taskId, ...(workflow ? { workflow } : {}) })
}

function collectGlobalTaskStats(projectId: string, runId: string): Promise<GlobalTaskStats> {
  return globalTaskStats({ ...statsDeps(projectId), runId })
}

function resolveProject(projectId?: string): { id: string; root: string; store: TaskStore } {
  const p = projectId ? projects.get(projectId) : projects.active()
  if (!p) throw projectId ? new Error(`project not found: ${projectId}`) : new OrcaError('projects.none')
  return { id: p.id, root: p.root, store: projects.store(p.id) }
}

/**
 * Закрыть терминалы воркеров задачи: живые dispatch'и помечаются завершёнными (иначе ptyExited
 * примет kill за падение), PTY убиваются — реестр pty.ts сам разошлёт terminals:changed. PTY координатора
 * не привязан к dispatch и сюда не попадает.
 */
function closeTaskWorkers(store: TaskStore, taskId: string): void {
  const ptyIds = new Set<string>()
  for (const d of store.closeDispatches(taskId)) ptyIds.add(d.ptyId)
  // Старые dispatch'и уже закрыты (например, после `orca-board done`), но их PTY может жить до сих пор.
  for (const d of store.snapshot().dispatches) if (d.taskId === taskId && isAlive(d.ptyId)) ptyIds.add(d.ptyId)
  for (const ptyId of ptyIds) killPty(ptyId)
}

/**
 * Задача попала в колонку kind=done — её воркерам больше нечего делать. Смотрим не только
 * незакрытые dispatch'и, но и живые PTY уже закрытых: после `orca-board done` dispatch завершён,
 * а терминал агента ещё открыт до самого review accept.
 */
function closeDoneWorkers(store: TaskStore): void {
  const doneTasks = new Set<string>()
  for (const d of store.snapshot().dispatches) {
    if (d.endedAt && !isAlive(d.ptyId)) continue
    const task = store.getTask(d.taskId)
    if (task && store.columnKind(task.status) === 'done') doneTasks.add(task.id)
  }
  for (const taskId of doneTasks) closeTaskWorkers(store, taskId)
}

/**
 * Запуск воркера с проверками роли и агента. `opts.roleId` — роль этапа «Вопрос человеку» (`WorkflowDeps.startWorker`);
 * без неё роль этапа берётся из графа (`worker start`, перезапуск), иначе — роль задачи.
 */
function runWorker(taskId: string, projectId?: string, cols?: number, rows?: number, opts: { roleId?: string } = {}): ReturnType<typeof startWorker> {
  const p = resolveProject(projectId)
  // Роль могли удалить, а её агента — выключить в проекте после создания задачи.
  const task0 = p.store.getTask(taskId)
  if (task0) {
    if (p.store.columnKind(task0.status) === 'in_progress') throw new Error(`task already in progress: ${taskId}`)
    const type = projects.resolveRun(p.id, task0.runId)
    // Рабочая задача входит в воркфлоу или возвращается на этап «Работа» (роль ноды «Работа» становится ролью
    // задачи). Роль этапа «Вопрос человеку» на задачу не переносится: она едет в запуск отдельным параметром.
    const entered = enterWork(workflowDeps(p.id), taskId)
    const stageRoleId = opts.roleId ?? entered.roleId
    const roleId = stageRoleId ?? p.store.getTask(taskId)?.roleId ?? task0.roleId
    const role = type.roles.find((r) => r.id === roleId)
    if (!role) throw new OrcaError('worker.cannotStart', { reason: missingRoleText(roleId, type) })
    assertAgentUsable(projectAgents(p.id), role.agent)
    // Перезапуск: старый терминал задачи (если ещё жив) закрываем до запуска нового.
    closeTaskWorkers(p.store, taskId)
    return startWorker(p.store, p.root, ctx(p.id, task0.runId), taskId, cols, rows, stageRoleId)
  }
  return startWorker(p.store, p.root, ctx(p.id, undefined), taskId, cols, rows)
}

/**
 * Исполнитель воркфлоу проекта: store, репозиторий, тип прогона задачи (роли и граф) и запуск воркера
 * (docs/workflow.md). Граф будущей версии не исполняется — прогон без снимка пойдёт по дефолтному по ролям.
 */
function workflowDeps(projectId: string): WorkflowDeps {
  const p = resolveProject(projectId)
  return {
    store: p.store,
    repoRoot: p.root,
    run: (runId) => {
      const t = projects.resolveRun(p.id, runId)
      const workflow = runnableWorkflow(t.workflow)
      return { roles: t.roles, ...(workflow ? { workflow } : {}) }
    },
    startWorker: (taskId, opts) => runWorker(taskId, p.id, undefined, undefined, opts),
    mergeTarget: (task) => mergeTarget(p.store, p.root, task)
  }
}

/**
 * Исполнитель воркфлоу глобальных задач проекта (`workflow-run.ts`): те же store, тип прогона и запуск воркера, плюс
 * координатор (его перезапускает граф на входе в «Работу»).
 */
function runWorkflowDeps(projectId: string): RunWorkflowDeps {
  const p = resolveProject(projectId)
  const legacy = workflowDeps(projectId)
  return {
    store: p.store,
    repoRoot: p.root,
    run: legacy.run,
    startWorker: legacy.startWorker,
    isAlive,
    // Без `startRunWorkflow`: граф уже стоит на «Работе», повторный вход не нужен (и зациклил бы ensureCoordinator).
    startCoordinator: (runId) => {
      startCoordinator(p.store, p.root, ctx(p.id, runId), '', undefined, undefined, [], runId)
    },
    ...(legacy.mergeTarget ? { mergeTarget: legacy.mergeTarget } : {})
  }
}

/**
 * Шаги воркфлоу по событиям store. Не внутри commit, где пришло событие: иначе `orca-board done` ждал бы мержа
 * и запуска проверки, а вложенные commit перемешали бы порядок событий у подписчиков. Каждое событие обрабатывает ровно один
 * исполнитель: граф прогона (проверки и вопросы этапов) — `workflow-run.ts`, старый формат и путь подзадачи — `workflow.ts`;
 * чужие задачи каждый пропускает по `taskEngine`.
 */
function runWorkflowEvents(projectId: string, events: OrcaEvent[]): void {
  if (!events.some((e) => e.type === 'worker_done' || e.type === 'escalation' || e.type === 'question_answered')) return
  setImmediate(() => {
    if (!projects.get(projectId)) return
    handleWorkflowEvents(workflowDeps(projectId), events)
    handleRunWorkflowEvents(runWorkflowDeps(projectId), events)
  })
}

/**
 * Решение по задаче на этапе проверки (`review accept|reject`, «Принять»/«Вернуть» на карточке проверки): проверка ветки
 * глобальной задачи — исход ноды `gate` (`workflow-run.ts`), остальное — прежний движок (`workflow.ts`).
 */
function reviewDecision(projectId: string, taskId: string, decision: 'accept' | 'reject', text?: string, images?: unknown): Task | undefined {
  const p = resolveProject(projectId)
  // Картинки — только к замечаниям «Вернуть»; их сохраняет main (в cwd читателя) и подставляет пути.
  if (decision === 'accept' && hasImageInput(images)) throw new OrcaError('attachments.notForAction')
  if (isRunGate(p.store.getTask(taskId))) {
    if (decision === 'reject') rejectWithImages(p.store, p.root, taskId, images, text ?? '', (paths) => runGateDecision(runWorkflowDeps(p.id), taskId, decision, text, paths))
    else runGateDecision(runWorkflowDeps(p.id), taskId, decision, text)
    return p.store.getTask(taskId)
  }
  if (decision === 'accept') {
    reviewAccept(workflowDeps(p.id), taskId, text)
    return p.store.getTask(taskId)
  }
  return rejectWithImages(p.store, p.root, taskId, images, text ?? '', (paths) => reviewReject(workflowDeps(p.id), taskId, text ?? '', paths))
}

/**
 * `orca-board worker stop`: закрыть воркеров задачи (dispatch'и — unknown без эскалации, PTY убиты)
 * и вернуть задачу из in_progress в ready. Задачу в другой колонке не двигает.
 */
function stopTaskWorker(store: TaskStore, taskId: string): { stopped: string[] } {
  const stopped = store.activeDispatches().filter((d) => d.taskId === taskId).map((d) => d.id)
  closeTaskWorkers(store, taskId)
  const task = store.getTask(taskId)
  if (task && store.columnKind(task.status) === 'in_progress') store.moveTask(taskId, store.columnId('ready'))
  return { stopped }
}

function runCoordinator(
  objective: string,
  projectId?: string,
  cols?: number,
  rows?: number,
  images: ImageAttachment[] = [],
  runId?: string,
  typeId?: string
): string {
  const p = resolveProject(projectId)
  // Повторный запуск — роли типа прогона; новый прогон — выбранного типа (нет — типа проекта по умолчанию).
  if (runId !== undefined) {
    // Воркфлоу глобальной задачи дошёл до конца: координатору нечего делать, а запуск переоткрыл бы закрытый прогон.
    if (runFinished(p.store, runId)) throw new OrcaError('workflow.runFinished')
    const started = startCoordinator(p.store, p.root, ctx(p.id, runId), objective, cols, rows, images, runId)
    startRunWorkflow(runWorkflowDeps(p.id), started.runId)
    return started.ptyId
  }
  const type = projects.runType(p.id, typeId)
  const env = { ...typeCtx(p.id, projects.resolveType(p.id, type.typeId)), type }
  const started = startCoordinator(p.store, p.root, env, objective, cols, rows, images)
  // Новый прогон с воркфлоу прогона: координатор запущен — граф входит в первую ноду (обычно `stage_started`).
  startRunWorkflow(runWorkflowDeps(p.id), started.runId)
  return started.ptyId
}

/** Воркфлоу глобальной задачи (`workflowScope: 'run'`) дошёл до ноды `end`: прогон закрыт, повторный запуск координатора не нужен. */
function runFinished(store: TaskStore, runId: string): boolean {
  const run = store.getRun(runId)
  if (run?.workflowScope !== 'run' || !run.stage) return false
  return store.runWorkflow(runId).nodes.find((n) => n.id === run.stage!.nodeId)?.type === 'end'
}

/** Живой терминал ассистента: один на всё приложение, повторное открытие — тот же PTY при любом активном проекте. */
let assistantPty: string | null = null

/**
 * Терминал ассистента приложения: живой — возвращается как есть, иначе (или при `reset` — всегда,
 * старый закрывается) запускается новый. Роли, агент и режим разрешений — из настроек по умолчанию:
 * ассистент не принадлежит ни одному проекту.
 */
function openAssistant(cols: number, rows: number, reset: boolean): { ptyId: string } {
  if (assistantPty && isAlive(assistantPty)) {
    if (!reset) return { ptyId: assistantPty }
    killPty(assistantPty)
  }
  assistantPty = null
  // Ассистент один на все проекты: роли и режим разрешений — из типа библиотеки по умолчанию, не из проекта.
  const d = resolveTaskType(projects.taskType(projects.defaultTaskTypeId())!)
  const { ptyId } = startAssistant({ socketPath: SOCKET_PATH, permissionMode: d.permissionMode, roles: d.roles, typeTitle: d.title }, cols, rows)
  assistantPty = ptyId
  return { ptyId }
}

/**
 * Удаление глобальной задачи (IPC и сокет): при живом координаторе — ошибка; store отвергает подзадачи
 * с живым dispatch и удаление с подзадачами без cascade. Оставшиеся терминалы подзадач (после `done`
 * dispatch закрыт, а PTY жив) закрываются после удаления.
 */
function removeGlobalTask(p: { store: TaskStore; root: string }, runId: string, cascade: boolean): { deleted: string; tasks: string[] } {
  const { store } = p
  const run = store.getRun(runId)
  if (run?.coordinatorPtyId && isAlive(run.coordinatorPtyId)) {
    throw new OrcaError('global.coordinatorAlive')
  }
  const ptyIds = store.snapshot().dispatches.filter((d) => store.getTask(d.taskId)?.runId === runId && isAlive(d.ptyId)).map((d) => d.ptyId)
  const result = store.deleteGlobalTask(runId, { cascade })
  ptyIds.forEach((id) => killPty(id))
  // Worktree ветки фичи больше некому убрать; сама ветка остаётся — в ней может быть работа. Грязный — не трогаем.
  if (run?.git?.worktree) removeRunWorktree(p.root, run.git.worktree)
  return result
}

/** Раз в минуту: живой воркер без вывода дольше STUCK_MS → эскалация. */
function watchStuck(): void {
  setInterval(() => {
    for (const [, store] of projects.loadedStores()) {
      for (const d of store.activeDispatches()) {
        if (!isAlive(d.ptyId)) continue
        const silent = silentFor(d.ptyId)
        if (silent > STUCK_MS) store.markStuck(d.id, silent)
      }
    }
  }, 60_000)
}

/**
 * Раз в 5 с: терминал координатора завершённого прогона (run_done), чей агент сам не выходит
 * после финального ответа (Codex), закрывается после его сигнала `runs finish` и короткой тишины
 * (без сигнала — только после долгой тишины). Решение — в coordinatorsToClose, killPty идемпотентен.
 * Там же прогоны после run_done, чей координатор уже не жив (закрыли терминал, перезапуск приложения),
 * уходят на «Проверку» — settleIdleRuns.
 */
function watchFinishedCoordinators(): void {
  setInterval(() => {
    for (const [projectId, store] of projects.loadedStores()) {
      const snap = store.snapshot()
      const due = coordinatorsToClose({
        ...snap,
        isDone: (status) => store.columnKind(status) === 'done',
        lingers: (agent) => (agent ? getAgent(agent)?.lingersAfterAnswer === true : false),
        lastActivityAt,
        now: Date.now()
      })
      for (const { ptyId } of due) killPty(ptyId)
      store.settleIdleRuns(isAlive)
      // Воркфлоу прогона: координатор умер, не закрыв этап `stage finish` — этап закрывается без сводки.
      if (snap.runs.some((r) => r.workflowScope === 'run' && r.stageTasksDoneAt !== undefined && r.closedAt === undefined)) {
        try {
          settleIdleRunStages(runWorkflowDeps(projectId))
        } catch (e) {
          // Проект могли закрыть между тиками; исключение из таймера уронило бы main.
          console.error(`[orca] воркфлоу прогона: не удалось закрыть этап без координатора (${projectId}):`, (e as Error).message)
        }
      }
    }
  }, 5_000)
}

/** Пауза между текстом и Enter: иначе TUI агента принимает Enter за часть вставки и не отправляет сообщение. */
const SUBMIT_DELAY_MS = 150

/**
 * Ответ на вопрос воркера, чей `orca-board ask` уже не ждёт (инструмент агента оборвал команду по
 * таймауту — человек отвечает дольше; или `--no-wait`): в терминал живого воркера — короткий пинок с командой,
 * по которой он заберёт ответ сам (основной путь — ask/переподключение). Ждёт ask — ответ уйдёт через сокет.
 */
function deliverAnswers(projectId: string, events: OrcaEvent[]): void {
  const store = projects.store(projectId)
  for (const e of events) {
    if (e.type !== 'question_answered' || !e.dispatchId) continue
    const questionId = String(e.payload.questionId ?? '')
    if (askWaiting(questionId)) continue
    const d = store.getDispatch(e.dispatchId)
    if (!d || d.endedAt || !isAlive(d.ptyId)) continue
    const requestId = typeof e.payload.requestId === 'string' ? e.payload.requestId : undefined
    writePty(d.ptyId, answerNudge(questionId, requestId))
    setTimeout(() => writePty(d.ptyId, '\r'), SUBMIT_DELAY_MS)
  }
}

/** Отправить в renderer, когда он сможет принять: новое окно ещё грузится. */
function sendWhenReady(w: BrowserWindow, existed: boolean, channel: string, payload: unknown): void {
  if (existed && !w.webContents.isLoading()) w.webContents.send(channel, payload)
  else w.webContents.once('did-finish-load', () => w.webContents.send(channel, payload))
}

/**
 * Окно по клику на уведомление: показать и перейти в проект; уведомление о запросе к человеку —
 * ещё и открыть Инбокс на этом запросе (`requests:focus`).
 */
function focusProject(projectId: string, requestId?: string): void {
  const existed = win !== null && !win.isDestroyed()
  const w = showWindow()
  sendWhenReady(w, existed, 'projects:focus', projectId)
  if (requestId) sendWhenReady(w, existed, 'requests:focus', { projectId, requestId } satisfies RequestFocus)
}

/**
 * Системные уведомления на события, требующие человека (запрос к человеку, готовая к ревью задача,
 * «нет вывода», конец прогона — см. notifyKind); фильтр — «Настройки → Уведомления» (shouldNotify).
 */
function notify(projectId: string, events: OrcaEvent[]): void {
  if (!Notification.isSupported()) return
  const settings = projects.settings().notifications
  const focused = BrowserWindow.getFocusedWindow() !== null
  const project = projects.get(projectId)
  const store = projects.store(projectId)
  for (const e of events) {
    const task = e.taskId ? store.getTask(e.taskId) : undefined
    const content = describeEvent(e, task, project?.name ?? 'orca-board', settings.showPreview)
    if (!content || !shouldNotify(content, settings, new Date(), focused)) continue
    const column = task && settings.showPreview ? projects.columns(projectId).find((c) => c.id === task.status) : undefined
    const n = new Notification({ title: content.title, body: content.body, subtitle: column ? columnTitle(column) : undefined, silent: !settings.sound })
    n.on('click', () => focusProject(projectId, content.requestId))
    n.show()
  }
}

/** Решение запроса к человеку (IPC и сокет): accept — с git-частью, clarify/restart — сразу старт воркера. */
function resolveRequest(projectId: string | undefined, id: string, resolution: RequestResolution, images?: unknown): ReturnType<typeof resolveHumanRequest> {
  const p = resolveProject(projectId)
  const request = p.store.getRequest(id)
  if (request?.taskId) syncWorkerLiveness(p.store, request.taskId)
  const deps = workflowDeps(p.id)
  const runDeps = runWorkflowDeps(p.id)
  // Approval прогона (нода `human`, без задачи) ведёт `workflow-run.ts`; запрос на задаче (нода `human` пути подзадачи, в том числе
  // «Конфликт мержа») — движок по подзадачам (`workflow.ts`).
  // `resolution.images` из IPC и сокета вырезается: пути к картинкам ставит только main после записи файлов.
  return resolveWithImages(p.store, p.root, id, resolution, images, (clean) =>
    resolveHumanRequest(p.store, p.root, id, clean, deps.startWorker, (r) => {
      if (!handleRunApproval(runDeps, r)) approvalResolved(deps, r)
    }, deps.mergeTarget))
}

/** Тестовое уведомление из настроек: показывается всегда, звук и превью — по настройкам. */
function testNotification(): void {
  if (!Notification.isSupported()) throw new OrcaError('notify.unsupported')
  const s = projects.settings().notifications
  const body = s.showPreview ? mt('notify.testPreview') : mt('notify.question')
  new Notification({ title: 'orca-board', body, silent: !s.sound }).show()
}

/**
 * Задачи в работе для «Документов»: у задачи есть worktree на диске и она не в колонке kind=done.
 * После принятия ревью worktree удаляется — документы задачи уже в проекте.
 */
function docTasks(store: TaskStore): DocTask[] {
  return store
    .snapshot()
    .tasks.filter((t) => t.worktree && store.columnKind(t.status) !== 'done' && existsSync(t.worktree))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((t) => ({ id: t.id, title: t.title, worktree: t.worktree!, branch: t.branch }))
}

/** Корень источника документов: проект или worktree его задачи в работе. Чужие id — ошибка. */
function docRoot(source: unknown): string {
  const p = resolveProject()
  if (source === PROJECT_SOURCE) return p.root
  const task = docTasks(p.store).find((t) => t.id === source)
  if (!task) throw new OrcaError('docs.noTaskSource', { id: String(source) })
  return task.worktree
}

/** Диалог выбора репозитория для «Добавить проект»; отмена — null. */
async function pickRepoFolder(): Promise<string | null> {
  if (!win) throw new Error('no window')
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: mt('dialog.pickRepo') })
  return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
}

/**
 * `ipcMain.handle` для вызовов renderer: всё, что они меняют на доске, сделал человек в UI — так переходы
 * попадают в историю статусов с `human` (`withStatusSource`, действует до первого await обработчика).
 */
function handle<A extends unknown[]>(channel: string, fn: (e: IpcMainInvokeEvent, ...args: A) => unknown): void {
  ipcMain.handle(channel, async (e, ...args: unknown[]) => {
    try {
      return await withStatusSource('human', () => fn(e, ...(args as A)))
    } catch (err) {
      throw ipcError(err)
    }
  })
}

/** Корень проекта по id (не обязательно активного); неизвестный id — ошибка. */
function projectRoot(id: string): string {
  const p = projects.get(id)
  if (!p) throw new Error(`project not found: ${id}`)
  return p.root
}

/**
 * Живые воркеры и координаторы проекта: у них worktree и рабочая ветка растут от корня, переключать его нельзя
 * (CLAUDE.md, «Git и ветки»). Считаются процессы, а не записи: dispatch без живого PTY — уже мёртвый.
 */
function liveAgentCount(projectId: string): number {
  const store = projects.store(projectId)
  const workers = store.activeDispatches().filter((d) => isAlive(d.ptyId)).length
  const coordinators = store.listRuns().filter((r) => r.coordinatorPtyId && isAlive(r.coordinatorPtyId)).length
  return workers + coordinators
}

function registerIpc(): void {
  handle('app:getSettings', () => projects.settings())
  handle('app:setSettings', (_e, patch: AppSettingsPatch) => {
    const settings = projects.setSettings(patch ?? {})
    // Язык меняется без перезапуска: трей пересобирается сразу, диалоги и уведомления берут его при показе.
    setMainLocale(settings.language)
    refreshTray()
    updater.settingsChanged()
    return settings
  })
  handle('app:testNotification', () => testNotification())
  handle('onboarding:getState', () => projects.onboardingState())
  handle('onboarding:complete', (_e, input?: OnboardingCompleteInput) => projects.completeOnboarding(input))
  handle('updates:getState', () => updater.getState())
  handle('updates:check', () => updater.check())
  handle('updates:download', () => updater.download())
  handle('updates:install', (_e, opts: { when: UpdateInstallWhen }) => updater.install(opts))
  handle('updates:cancelPending', () => updater.cancelPending())
  handle('updates:getJustUpdated', () => updater.getJustUpdated())
  handle('app:info', () => ({ socketPath: SOCKET_PATH, active: projects.active(), projects: projects.list() }))
  handle('projects:list', () => ({ active: projects.active(), projects: projects.list(), groups: projects.groups() }))
  handle('projects:createGroup', (_e, name: string) => projects.createGroup(name))
  handle('projects:renameGroup', (_e, id: string, name: string) => projects.renameGroup(id, name))
  handle('projects:removeGroup', (_e, id: string) => projects.removeGroup(id))
  handle('projects:setGroupCollapsed', (_e, id: string, collapsed: boolean) => projects.setGroupCollapsed(id, collapsed))
  handle('projects:setProjectGroup', (_e, projectId: string, groupId: string | null) => projects.setProjectGroup(projectId, groupId))
  handle('projects:reorderGroups', (_e, ids: string[]) => projects.reorderGroups(ids))
  handle('projects:inProgressCounts', () => projects.inProgressCounts())
  // Неизвестный проект (удалён, устаревший id в renderer) — не ошибка IPC, а «не репозиторий»: бейдж просто скрывается.
  handle('projects:branch', (_e, id: string): ProjectBranchInfo => {
    const p = projects.get(id)
    return p ? projectBranchInfo(p.root) : { isGitRepo: false, branch: null, detached: false }
  })
  // Git корня проекта. Renderer сам перезапрашивает ветку по результату (`ProjectGitResult.branch` / возврат checkout).
  handle('projects:branches', (_e, id: string) => projectBranches(projectRoot(id)))
  handle('projects:gitFetch', (_e, id: string) => projectFetch(projectRoot(id)))
  handle('projects:gitPull', (_e, id: string) => projectPull(projectRoot(id)))
  handle('projects:checkoutBranch', (_e, id: string, branch: string) => {
    const root = projectRoot(id)
    return checkoutProjectBranch(root, typeof branch === 'string' ? branch : '', liveAgentCount(id))
  })
  handle('projects:setActive', (_e, id: string) => projects.setActive(id))
  handle('projects:remove', (_e, id: string) => projects.remove(id))
  handle('projects:setEnabledAgents', (_e, id: string, agents: AgentKind[]) => projects.setEnabledAgents(id, agents))
  handle('projects:setColumns', (_e, id: string, columns: BoardColumn[]) => projects.setColumns(id, columns))
  handle('prompts:builtin', () => BUILTIN_PROMPTS)
  handle('agents:list', (_e, refresh?: boolean) => agentInfos(projects.active()?.enabledAgents, Boolean(refresh)))
  handle('projects:add', async (_e, typeId?: string, path?: string) => {
    const dir = typeof path === 'string' && path ? path : await pickRepoFolder()
    return dir ? projects.add(dir, typeof typeId === 'string' && typeId ? typeId : undefined) : null
  })
  handle('projects:detectTaskType', async (_e, path?: string) => {
    const dir = typeof path === 'string' && path ? path : await pickRepoFolder()
    return dir ? projects.detectTaskType(dir) : null
  })
  handle('projects:setTaskTypes', (_e, id: string, input: ProjectTaskTypesInput) => projects.setProjectTaskTypes(id, input))
  handle('taskTypes:list', () => projects.taskTypesState())
  handle('taskTypes:save', (_e, input: TaskTypeInput) => projects.saveTaskType(input))
  handle('taskTypes:delete', (_e, id: string) => projects.deleteTaskType(id))
  handle('taskTypes:duplicate', (_e, id: string) => projects.duplicateTaskType(id))
  handle('taskTypes:setDefault', (_e, id: string) => projects.setDefaultTaskType(id))
  handle('nodeTemplates:list', () => projects.nodeTemplates())
  handle('nodeTemplates:save', (_e, input: NodeTemplateInput) => projects.saveNodeTemplate(input))
  handle('nodeTemplates:delete', (_e, id: string) => projects.deleteNodeTemplate(id))

  handle('board:get', () =>
    projects.active() ? projects.activeStore().snapshot() : { tasks: [], dispatches: [], events: [], questions: [], runs: [] }
  )
  handle('runs:list', () => (projects.active() ? projects.activeStore().listRuns() : []))
  handle('runs:close', (_e, runId: string) => projects.activeStore().closeRun(runId))
  handle('tasks:create', (_e, input: { title: string; spec?: string; deps?: string[]; roleId?: string; priority?: TaskPriority }) => {
    const p = resolveProject()
    // «Входящие» — по типу проекта по умолчанию.
    const role = pickRole(projects.resolveRun(p.id), projectAgents(p.id), input.roleId)
    return p.store.createTask({ ...input, roleId: role.id, agent: role.agent })
  })
  handle('tasks:move', (_e, id: string, status: string) => projects.activeStore().moveTask(id, status))
  handle('tasks:update', (_e, id: string, patch: TaskPatch) => projects.activeStore().editTask(id, patch ?? {}))
  handle('tasks:remove', (_e, id: string) => projects.activeStore().deleteTask(id))

  // Глобальные задачи активного проекта (docs/nested-kanban.md). Изменения — в board:changed.
  handle('globalTasks:list', () => (projects.active() ? projects.activeStore().listGlobalTasks() : []))
  handle('globalTasks:get', (_e, id: string) => projects.activeStore().getGlobalTask(id))
  handle('globalTasks:create', (_e, input: GlobalTaskInput) => {
    const p = resolveProject()
    const { typeId, ...rest } = input ?? {}
    // Тип проверяется до создания: недоступный проекту — ошибка, задача не создаётся.
    return p.store.createGlobalTask({ ...rest, type: projects.runType(p.id, typeof typeId === 'string' && typeId ? typeId : undefined) })
  })
  handle('globalTasks:update', (_e, id: string, patch: GlobalTaskPatch) => projects.activeStore().updateGlobalTask(id, patch ?? {}))
  handle('globalTasks:changeType', (_e, id: string, typeId: string) => {
    if (typeof typeId !== 'string' || !typeId) throw new OrcaError('global.typeRequired')
    const p = resolveProject()
    // Тип — из библиотеки проекта, как при создании: недоступный проекту — ошибка, тип не меняется.
    return p.store.changeGlobalTaskType(id, projects.runType(p.id, typeId))
  })
  handle('globalTasks:move', (_e, id: string, status: string) => projects.activeStore().moveGlobalTask(id, status))
  handle('globalTasks:remove', (_e, id: string, opts?: { cascade?: boolean }) =>
    removeGlobalTask(resolveProject(), id, opts?.cascade === true)
  )
  handle('globalTasks:tasks', (_e, id: string) => projects.activeStore().listSubtasks(id))
  handle('globalTasks:createTask', (_e, id: string, input: SubtaskInput) => {
    if (!input?.title?.trim()) throw new OrcaError('global.subtaskTitleEmpty')
    const p = resolveProject()
    const role = pickRole(projects.resolveRun(p.id, id), projectAgents(p.id), input.roleId ?? p.store.stageDefaultRole(id))
    return p.store.createTask({ ...input, roleId: role.id, agent: role.agent, runId: id })
  })
  handle('globalTasks:startCoordinator', (_e, id: string, cols: number, rows: number, images?: unknown) =>
    runCoordinator('', undefined, cols, rows, validateImageAttachments(images), id)
  )
  handle('globalTasks:accept', (_e, id: string, decision?: string) =>
    acceptRun(runWorkflowDeps(resolveProject().id), id, typeof decision === 'string' ? decision : undefined))
  // `images` — картинки к уточнению (байты): main проверяет их и пишет в cwd координатора, дальше по возврату идут пути.
  handle('globalTasks:returnToWork', (_e, id: string, text: string, cols: number, rows: number, images?: unknown) => {
    const p = resolveProject()
    const reason = typeof text === 'string' ? text : ''
    if (isRunScope(p.store, id)) {
      // «Вернуть» — reject ноды `human`: граф идёт по ребру reject, координатор получает `stage_started` с замечаниями (живой
      // не закрывается — он ждёт этап в Monitor, мёртвый запускается заново). Терминал — тот, что сейчас у координатора.
      // Проверка живости — после записи: файлы уже в `stageInput.images`, и «Запустить координатора» их подхватит.
      returnRunWithImages(p.store, p.root, id, images, reason, (paths) => returnRun(runWorkflowDeps(p.id), id, reason, paths))
      const ptyId = p.store.getRun(id)?.coordinatorPtyId
      if (!ptyId || !isAlive(ptyId)) throw new OrcaError('workflow.coordinatorNotRunning')
      return ptyId
    }
    return returnRunWithImages(p.store, p.root, id, images, reason, (paths) => returnToWork(p.store, p.root, ctx(p.id, id), id, reason, cols, rows, paths)).ptyId
  })
  handle('questions:answer', (_e, id: string, answer: string) => answerQuestion(projects.activeStore(), id, answer))
  handle('requests:list', (_e, opts?: RequestListOptions) => {
    if (!projects.active()) return []
    const store = projects.activeStore()
    return store.listRequests().filter((r) => (!opts?.runId || r.runId === opts.runId) && (!opts?.pending || r.status === 'pending'))
  })
  // `images` — картинки к «Уточнить»/«Вернуть» (см. returnToWork).
  handle('requests:resolve', (_e, id: string, resolution: RequestResolution, images?: unknown) => resolveRequest(undefined, id, resolution, images))

  handle('pty:spawn', (_e, { label, projectId, ...opts }: PtySpawnOptions) => {
    const p = projectId ? projects.get(projectId) : projects.active()
    return spawnPty(
      {
        ...opts,
        meta: { role: 'shell', label: label ?? 'терминал', projectId: projectId ?? p?.id },
        cwd: opts.cwd ?? p?.root,
        env: {
          ...(app.isPackaged ? { ORCA_NODE: process.execPath } : {}),
          ORCA_SOCKET: SOCKET_PATH,
          ...(p ? { ORCA_PROJECT: p.id } : {}),
          PATH: workerPath(),
          ...(opts.env ?? {})
        }
      },
      (id, code) => projects.loadedStores().forEach(([, s]) => s.ptyExited(id, code))
    )
  })
  ipcMain.on('pty:write', (_e, id: string, data: string) => writePty(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => resizePty(id, cols, rows))
  ipcMain.on('pty:kill', (_e, id: string) => killPty(id))
  handle('terminals:list', () => terminalSnapshots())

  handle('worker:start', (_e, taskId: string, cols: number, rows: number) => runWorker(taskId, undefined, cols, rows))
  handle('coordinator:start', (_e, objective: unknown, cols: number, rows: number, images?: unknown) => {
    // Данные из renderer не доверенные: изображения проверяются по сигнатуре и лимитам.
    const valid = validateImageAttachments(images)
    const text = typeof objective === 'string' ? objective.trim() : ''
    if (!text && valid.length === 0) throw new OrcaError('coordinator.noObjective')
    return runCoordinator(text || DEFAULT_IMAGE_OBJECTIVE, undefined, cols, rows, valid)
  })
  handle('assistant:open', (_e, cols: number, rows: number) => openAssistant(cols, rows, false))
  handle('assistant:reset', (_e, cols: number, rows: number) => openAssistant(cols, rows, true))
  handle('docs:list', () => {
    if (!projects.active()) return []
    const p = resolveProject()
    return listDocGroups(p.root, currentBranch(p.root), docTasks(p.store))
  })
  handle('docs:read', (_e, source: unknown, path: unknown) => readDoc(docRoot(source), path))
  handle('docs:open', async (_e, source: unknown, path: unknown) => {
    const err = await shell.openPath(resolveDocPath(docRoot(source), path))
    if (err) throw new Error(err)
  })
  handle('docs:reveal', (_e, source: unknown, path: unknown) => shell.showItemInFolder(resolveDocPath(docRoot(source), path)))
  // Рукопожатие для картинок к замечаниям: renderer проверяет, что main новый и принимает `images`.
  handle('attachments:ping', () => true)
  // Показ человеку: файлы из worktree задачи активного проекта, белый список расширений — main/showcase.ts.
  handle('showcase:read', (_e, taskId: unknown, path: unknown) => readShowcaseFile(showcaseRoot(resolveProject().store, taskId), path))
  handle('showcase:open', async (_e, taskId: unknown, path: unknown) => {
    const err = await shell.openPath(resolveShowcasePath(showcaseRoot(resolveProject().store, taskId), path))
    if (err) throw new Error(err)
  })
  handle('showcase:reveal', (_e, taskId: unknown, path: unknown) =>
    shell.showItemInFolder(resolveShowcasePath(showcaseRoot(resolveProject().store, taskId), path))
  )
  // Правила — всегда корень репозитория проекта; имя сверяется с белым списком в rules.ts.
  handle('rules:list', () => listRules(resolveProject().root))
  handle('rules:save', (_e, name: unknown, text: unknown) => writeRule(resolveProject().root, name, text))
  // Сбор по запросу: снапшот store + транскрипты агентов (docs/architecture.md, «Статистика»).
  handle('stats:project', (_e, projectId: string, range: StatsRange) => {
    if (!STATS_RANGES.includes(range)) throw new OrcaError('stats.badRange', { range: String(range), expected: STATS_RANGES.join(' | ') })
    return collectProjectStats(projectId, range)
  })
  handle('stats:task', (_e, projectId: string, taskId: string) => collectTaskStats(projectId, taskId))
  handle('stats:global', (_e, projectId: string, runId: string) => collectGlobalTaskStats(projectId, runId))
  handle('review:info', (_e, taskId: string) => {
    const p = resolveProject()
    return getReview(p.store, p.root, taskId)
  })
  handle('review:accept', (_e, taskId: string, decision?: string) => void reviewDecision(resolveProject().id, taskId, 'accept', decision))
  // `images` — картинки к замечаниям (см. returnToWork).
  handle('review:reject', (_e, taskId: string, feedback: string, images?: unknown) => reviewDecision(resolveProject().id, taskId, 'reject', feedback, images))
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return
  app.setAppUserModelId('orca-board')
  // ДО ProjectManager и досок: их миграции переписывают файлы, а бэкап хранит состояние в формате старой версии.
  rememberUpdate(backupOnVersionChange(app.getPath('userData'), app.getVersion()))
  projects = new ProjectManager(app.getPath('userData'))
  setMainLocale(projects.settings().language)
  projects.markRun(app.getVersion())
  if (process.env.ORCA_REPO) {
    try {
      projects.add(process.env.ORCA_REPO)
    } catch (e) {
      console.error((e as Error).message)
    }
  }
  projects.onChange((projectId, store) => {
    if (win && !win.isDestroyed()) win.webContents.send('board:changed', { projectId, snapshot: store.snapshot() })
    // Любой путь в done (review accept, task move, tasks:move из UI) проходит через commit store — ловим здесь.
    closeDoneWorkers(store)
    // Закрытие и «Сделано» глобальной задачи — тоже любой путь (runs finish, перенос, выход координатора).
    const project = projects.get(projectId)
    if (project) runBranchSync.sync(store, project.root)
    refreshTray()
  })
  projects.onEvents(notify)
  projects.onEvents(deliverAnswers)
  projects.onEvents(runWorkflowEvents)
  const { support, backend } = createPlatformUpdater({
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    portableExe: process.env.PORTABLE_EXECUTABLE_FILE,
    electron: { app, net }
  })
  updater = createUpdater({
    version: app.getVersion(),
    support,
    backend,
    host: {
      settings: () => projects.settings().updates,
      liveWorkerCount,
      confirmInstall,
      lockQuit: () => {
        quitting = true
      },
      unlockQuit: () => {
        quitting = false
      },
      quit: () => {
        killAll()
        app.quit()
      },
      takeJustUpdated
    }
  })
  updater.onChanged((state) => {
    if (win && !win.isDestroyed()) win.webContents.send('updates:changed', state)
    refreshTray()
  })
  updater.start()
  registerIpc()
  startSocketServer(SOCKET_PATH, {
    resolve: (projectId) => {
      const p = resolveProject(projectId)
      return {
        store: p.store,
        startWorker: (taskId) => runWorker(taskId, p.id),
        stopWorker: (taskId) => stopTaskWorker(p.store, taskId),
        review: (taskId) => getReview(p.store, p.root, taskId),
        accept: (taskId, decision) => void reviewDecision(p.id, taskId, 'accept', decision),
        reject: (taskId, feedback) => reviewDecision(p.id, taskId, 'reject', feedback),
        finishStage: (runId, summary) => finishRunStage(runWorkflowDeps(p.id), runId, summary),
        resolveRequest: (id, resolution) => resolveRequest(p.id, id, resolution),
        startCoordinator: (objective, runId, typeId) => runCoordinator(objective, p.id, undefined, undefined, [], runId, typeId),
        deleteGlobalTask: (runId, cascade) => removeGlobalTask(p, runId, cascade),
        agents: () => projectAgents(p.id),
        resolveRun: (runId) => projects.resolveRun(p.id, runId),
        taskTypes: () => ({ taskTypes: projects.projectTaskTypes(p.id), defaultTypeId: projects.projectDefaultTypeId(p.id) }),
        runType: (typeId) => projects.runType(p.id, typeId),
        saveTaskTypeRules: (typeId, roleId, text) => projects.saveTaskTypeRules(typeId, roleId, text),
        columns: () => projects.columns(p.id),
        workflow: (typeId) => projects.taskTypeWorkflow(typeId ?? projects.projectDefaultTypeId(p.id))
      }
    },
    projects: () => {
      const activeId = projects.active()?.id
      const counts = projects.inProgressCounts()
      return projects.list().map((p) => {
        const type = projects.projectDefaultType(p.id)
        return {
          id: p.id,
          name: p.name,
          root: p.root,
          active: p.id === activeId,
          inProgress: counts[p.id] ?? 0,
          defaultTypeId: type.id,
          defaultTypeTitle: type.title
        }
      })
    }
  })
  watchStuck()
  watchFinishedCoordinators()
  createTray({
    open: () => showWindow(),
    quit: () => void requestQuit(),
    activeCount: activeDispatchCount,
    readyUpdate: () => updater.readyVersion(),
    installUpdate: () => void updater.install({ when: 'now' })
  })
  createWindow()
  // Клик по иконке в Dock (macOS) — вернуть окно.
  app.on('activate', () => showWindow())
})

// Cmd+Q, «Выйти» из меню приложения, app.quit() — всё идёт через подтверждение.
app.on('before-quit', (e) => {
  if (quitting) return
  e.preventDefault()
  void requestQuit()
})

app.on('window-all-closed', () => {
  // Фоновый режим: окно закрыто, приложение, PTY и уведомления живут; вернуться — Dock или трей.
  if (projects?.settings().keepInBackground ?? true) return
  quitNow()
})
