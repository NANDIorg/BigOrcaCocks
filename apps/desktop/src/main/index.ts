import type { Workflow } from '@orca-board/core'
import { buildWorkflowAssistantContext, saveWorkflowDraft } from './assistant-workflow'
import type { TaskTypePatch, AttachmentCapabilities } from '../shared/ipc'
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, net, protocol, shell, dialog, Notification, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { getAppTheme } from '../shared/theme'
import { mainWindowChrome, windowsTitleBarOverlay } from './window-chrome'
import { defaultSocketPath, validateAttachments, coordinatorsToClose, getAgent, withStatusSource, STATS_RANGES, type StatsRange, type ProjectStats, type TaskStats, type GlobalTaskStats, type Attachment, type TaskStore, type Task, type OrcaEvent, type AgentKind, type AgentInfo, type BoardColumn, type RequestResolution, type ResolvedRunType } from '@orca-board/core'
import { spawnPty, writePty, resizePty, killPty, killAll, silentFor, lastActivityAt, isAlive, setPtyWindow, terminalSnapshots } from './pty'
import { startWorker, startCoordinator, startAssistant, returnToWork, workerPath, pruneLaunchTempFiles, type WorkerEnvContext } from './worker'
import { assistantCwd, assistantEnv, assistantLaunch } from './assistant'
import { createAssistantConversation } from './assistant-conversation'
import { AssistantSession } from './assistant-session'
import { transcriptEnv } from './transcripts'
import { workflowServices } from './workflow-services'
import type { ResolveOutcome } from '@orca-board/runtime'
import { createDialogRepository, DIALOGS_FILE, startProfileRuntime, createBoardCommands, createAgentSelection, createGlobalTaskCommands, createGlobalTaskRemoval, createCoordinatorCommands, createCoordinatorOperations, createWorkerCommands, createWorkerOperations, createTaskWorkerLifecycle, createReviewCommands, createHumanRequestCommands, createReviewOperations, type ReviewOperationHost, type ReviewProject, type CoordinatorProject, type WorkerProject } from '@orca-board/runtime'
import type { BoardCommands, GlobalTaskCommands, CoordinatorCommands, WorkerCommands, ReviewCommands, HumanRequestCommands, ProjectCommandContext } from '@orca-board/contracts'
import { registerDesktopBoardCommands } from './board-commands'
import { registerDesktopGlobalTaskCommands } from './global-task-commands'
import { registerDesktopCoordinatorCommands } from './coordinator-commands'
import { registerDesktopWorkerCommands } from './worker-commands'
import { registerDesktopReviewRequestCommands } from './review-request-commands'
import { executionResources } from './execution-resources'
import { profileStartupMessage } from './profile-startup-errors'
import { attachmentCapabilities } from './attachments'
import { readShowcaseFile, resolveShowcasePath, showcasePreviewBase, showcasePreviewUrl, showcaseSource } from './showcase'
import { PREVIEW_SCHEME, PreviewTokens, allowFrameNavigation, handlePreviewRequest, isExternalWebUrl } from './preview-protocol'
import { showcaseSnapshotsRoot, snapshotDispatchShowcase, type ShowcaseSnapshots } from './showcase-snapshot'
import type { WorkflowDeps } from './workflow'
import { validateWorkerRole } from './worker-preflight'
import {
  escalateDecision, finishRunStage, runDecision,
  hasIdleStage, settleIdleRunStages,
  type RunWorkflowDeps
} from './workflow-run'
import { docSourceRoot, docTasks, listDocGroups, readDoc } from './docs'
import { docsOpenPath, docsPreviewUrl, docsRevealPath, readDocBytes, viewDoc } from './docs-view'
import { listRules, readRule, writeRule } from './rules'
import { listProjectDir, resolveProjectPath } from './project-files'
import { currentBranch, projectBranchInfo, projectBranches, projectFetch, projectPull, checkoutProjectBranch, createInitialCommit } from './git'
import { mergeTarget, RunBranchSync } from './run-branch'
import { runImagesRoot, revealTaskAttachment, openTaskAttachment } from './run-images'
import { startSocketServer, askWaiting } from './socket'
import { ProjectManager, runnableWorkflow } from './projects'
import { exportTaskTypeToFile } from './task-type-export'
import { writeFileAtomic } from './persistence'
import { agentInfos, assertAgentUsable, missingRoleText, pickRole } from './agents'
import { BUILTIN_PROMPTS } from './prompts'
import { createTray, refreshTray } from './tray'
import { projectStats, taskStats, globalTaskStats, type StatsDeps } from './stats'
import { createUpdater, type Updater, type InstallChoice, type InstallRequest } from './updater'
import { createPlatformUpdater } from './updaterBackend'
import type { AppSettingsPatch, UpdateInstallWhen, ProjectTaskTypesInput, TaskTypeInput, NodeTemplateInput, RequestFocus, PtySpawnOptions, OnboardingCompleteInput, ProjectBranchInfo, InteractionAnswer, InitialCommitMode } from '../shared/ipc'
import { shouldNotify } from '../shared/notifications'
import { describeEvent, answerNudge } from './notify'
import { backupOnVersionChange, getJustUpdatedFrom, rememberUpdate } from './backup'
import { OrcaError, ipcError, mt, setMainLocale, mainLocale } from './i18n'
import { columnTitle } from './defaultTitles'
import { rendererSource } from './renderer-source'
import { applicationMenuTemplate, applicationMenuSnapshot, runApplicationMenuCommand, windowMenuCommands, MenuActionQueue, type AppMenuHandlers } from './app-menu'
import { refreshAboutWindow, showAboutWindow } from './about-window'
import type { AppMenuAction } from '../shared/ipc'
import appIconPath from '../../build/icon.png?asset'

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
let desktopInitialized = false
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.exit(0)
else app.on('second-instance', () => { if (desktopInitialized && !quitting) showWindow() })

let win: BrowserWindow | null = null
let windowFullscreen = false
let projects: ProjectManager
let boardCommands: BoardCommands
let globalTaskCommands: GlobalTaskCommands
let coordinatorCommands: CoordinatorCommands
let coordinatorOperations: ReturnType<typeof createCoordinatorOperations>
let workerCommands: WorkerCommands
let workerOperations: ReturnType<typeof createWorkerOperations>
let reviewCommands: ReviewCommands
let humanRequestCommands: HumanRequestCommands
let reviewOperations: ReturnType<typeof createReviewOperations>
const taskWorkerLifecycle = createTaskWorkerLifecycle({ isAlive, killPty })
let globalTaskRemoval: ReturnType<typeof createGlobalTaskRemoval>
let updater: Updater
/** Уборка worktree веток глобальных задач (`run-branch.ts`): неудачные попытки помнит между изменениями доски. */
const runBranchSync = new RunBranchSync({ isAlive })
/** Выход подтверждён (или подтверждать нечего) — before-quit больше не перехватываем. */
let quitting = false
/** Диалог подтверждения уже открыт — второй не показываем. */
let confirmingQuit = false
const menuActions = new MenuActionQueue()

// Схема страниц показа (`preview-protocol.ts`) — только ДО ready, иначе Chromium считает её не-standard: относительные
// `./style.css` не разрешаются, а `fetch` к ней запрещён. `bypassCSP` и `corsEnabled` не включаем: CSP ответа и
// ACAO задаёт сам обработчик.
protocol.registerSchemesAsPrivileged([
  { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])
/** Токены `orca-preview://` → корень показа; выдаёт `showcase:previewUrl`, живут до выхода из приложения. */
const previewTokens = new PreviewTokens()

const SOCKET_PATH = defaultSocketPath({ env: process.env, platform: process.platform, homedir: homedir() })
const STUCK_MS = Number(process.env.ORCA_STUCK_MINUTES ?? 10) * 60_000

function createWindow(): BrowserWindow {
  menuActions.disconnect()
  windowFullscreen = false
  const chrome = mainWindowChrome(process.platform, projects.settings().appearance?.theme)
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    title: 'orca-board',
    icon: appIconPath,
    backgroundColor: getAppTheme(projects.settings().appearance?.theme).colors.page,
    ...chrome,
    webPreferences: {
      ...chrome.webPreferences,
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  setPtyWindow(win)
  // Windows WCO сам не обнуляет заданную height в fullscreen; иначе renderer оставляет пустой резерв.
  if (process.platform === 'win32') {
    win.on('enter-full-screen', () => setWindowFullscreen(true))
    win.on('leave-full-screen', () => setWindowFullscreen(false))
  }
  const created = win
  // В авторском меню renderer сначала возвращает фокус редактору и сам вызывает команду.
  // Blur/reload/crash возвращают нативные сочетания, даже если renderer не успел закрыть popup.
  const restoreMenuShortcuts = (): void => {
    if (process.platform === 'win32' && !created.webContents.isDestroyed()) created.webContents.setIgnoreMenuShortcuts(false)
  }
  if (process.platform === 'win32') created.on('blur', restoreMenuShortcuts)
  win.on('closed', () => {
    if (win === created) {
      win = null
      menuActions.clear()
    }
    setPtyWindow(win)
  })
  win.webContents.on('did-start-loading', () => {
    // Загрузка показа в iframe не размонтирует App: его подписка на меню остаётся действующей.
    if (created.webContents.isLoadingMainFrame()) {
      menuActions.disconnect()
      restoreMenuShortcuts()
    }
  })
  win.webContents.on('render-process-gone', () => { menuActions.disconnect(); restoreMenuShortcuts() })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalWebUrl(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // Фрейм показа не уходит со своего снимка (sandbox навигацию самого фрейма не запрещает), а окно — со страницы приложения.
  win.webContents.on('will-frame-navigate', (e) => {
    const nav = { url: e.url, isMainFrame: e.isMainFrame, appUrl: created.webContents.getURL() }
    if (allowFrameNavigation(nav)) return
    e.preventDefault()
    if (nav.isMainFrame && isExternalWebUrl(nav.url)) shell.openExternal(nav.url)
  })
  // Esc при фокусе внутри фрейма показа DOM родителя не видит (фрейм другого origin) — сообщаем renderer'у, а он
  // закрывает просмотрщик, только если фокус действительно во фрейме (иначе Esc уже пришёл обычным keydown).
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') created.webContents.send('showcase:escape')
  })
  const source = rendererSource({
    isPackaged: app.isPackaged,
    devUrl: process.env['ELECTRON_RENDERER_URL'],
    indexHtml: join(__dirname, '../renderer/index.html')
  })
  if (source.kind === 'url') win.loadURL(source.url)
  else win.loadFile(source.path)
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

function navigateFromMenu(action: AppMenuAction): void {
  const window = showWindow()
  const ready = menuActions.request(action)
  if (ready) window.webContents.send('app:menuAction', ready)
}

/** Меню и «О приложении» переводятся вместе с треем, в том числе при правке настроек через CLI. */
function refreshApplicationMenu(): void {
  refreshAboutWindow(projects.settings().appearance)
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(process.platform, !app.isPackaged, appMenuHandlers())))
}

function appMenuHandlers(): AppMenuHandlers {
  return {
    navigate: navigateFromMenu,
    about: () => { showAboutWindow({ parent: showWindow(), iconPath: appIconPath, version: app.getVersion(), appearance: projects.settings().appearance }) },
    open: () => { showWindow() },
    quit: () => { void requestQuit() },
    openExternal: (url) => { void shell.openExternal(url) }
  }
}

/** Событие Windows приходит раньше смены isFullScreen; сохраняем явное состояние для темы и renderer. */
function setWindowFullscreen(fullscreen: boolean): void {
  windowFullscreen = fullscreen
  syncMainAppearance()
  win?.webContents.send('app:windowFullscreen', fullscreen)
}

/** Фон при запуске/восстановлении и native controls согласованы с выбранной темой. */
function syncMainAppearance(): void {
  const settings = projects.settings().appearance
  const theme = getAppTheme(settings?.theme)
  if (nativeTheme.themeSource !== theme.colorScheme) nativeTheme.themeSource = theme.colorScheme
  if (win && !win.isDestroyed()) {
    win.setBackgroundColor(theme.colors.page)
    if (process.platform === 'win32') win.setTitleBarOverlay(windowsTitleBarOverlay(settings?.theme, windowFullscreen))
  }
  refreshAboutWindow(settings)
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
  assistantSession.dispose()
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
    runImagesRoot: runImagesRoot(app.getPath('userData')),
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

/** Снимки показа проекта (`<userData>/showcase`, `showcase-snapshot.ts`): пишет `worker.done`, читают IPC `showcase:*`. */
function showcaseSnapshots(projectId: string): ShowcaseSnapshots {
  return { root: showcaseSnapshotsRoot(app.getPath('userData')), projectId }
}

function resolveProject(projectId?: string): { id: string; root: string; store: TaskStore } {
  const p = projectId ? projects.get(projectId) : projects.active()
  if (!p) throw projectId ? new Error(`project not found: ${projectId}`) : new OrcaError('projects.none')
  return { id: p.id, root: p.root, store: projects.store(p.id) }
}

/** Legacy socket/workflow выбирают проект здесь, проверки и orchestration выполняет runtime. */
function runWorker(taskId: string, projectId?: string, cols?: number, rows?: number, opts: { roleId?: string } = {}): ReturnType<typeof startWorker> {
  const p = resolveProject(projectId)
  return workerOperations.start(workerProject(p.id)!, taskId, { cols, rows, roleId: opts.roleId })
}

/** Host предоставляет ports конкретного проекта; создание callback не запускает workflow. */
function workerProject(projectId: string): WorkerProject | undefined {
  const project = projects.get(projectId)
  return project ? { store: projects.store(projectId), root: project.root,
    environment: runId => ctx(projectId, runId), agents: () => projectAgents(projectId), workflow: workflowDeps(projectId) } : undefined
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
    workflowServices.forProject(runWorkflowDeps(projectId)).handleEvents(events)
  })
}

/**
 * Доска проекта открыта впервые за запуск: подзадачи, чей эффект (мерж, git, конец) или переход после `done` прервал
 * выход приложения, доводятся до ожидания (`resumeStuckStages`). В `setImmediate`: store открывается посреди чужого вызова
 * (IPC, сокет), а мерж синхронный и долгий — пусть тот вызов сначала закончится.
 */
function resumeProjectStages(projectId: string): void {
  setImmediate(() => {
    if (!projects.get(projectId)) return
    try {
      workflowServices.forProject(runWorkflowDeps(projectId)).resumeStuckStages()
    } catch (e) {
      // Проект могли удалить между открытием и тиком; исключение из setImmediate уронило бы main.
      console.error(`[orca] воркфлоу: не удалось добрать прерванные этапы (${projectId}):`, (e as Error).message)
    }
  })
}

/**
 * Решение по задаче на этапе проверки (`review accept|reject`, «Принять»/«Вернуть» на карточке проверки): проверка ветки
 * глобальной задачи — исход ноды `gate` (`workflow-run.ts`), остальное — прежний движок (`workflow.ts`). Задачу-решатель
 * развилки `runGateDecision` отвергает: её ветку выбирают `decision choose` или человек по запросу `decision`.
 */
function reviewDecision(projectId: string, taskId: string, decision: 'accept' | 'reject', text?: string, images?: unknown): Task | undefined {
  const p = resolveProject(projectId)
  return reviewOperations.decide(reviewProject(p.id)!, taskId, decision, text, images)
}

/** Явный project port одинаков для IPC и callbacks socket; выбор окна не попадает в runtime. */
function reviewProject(projectId: string): ReviewProject | undefined {
  const project = projects.get(projectId)
  return project ? { store: projects.store(projectId), root: project.root, workflow: runWorkflowDeps(projectId) } : undefined
}

function runCoordinator(
  objective: string,
  projectId?: string,
  cols?: number,
  rows?: number,
  images: Attachment[] = [],
  runId?: string,
  typeId?: string
): string {
  const p = resolveProject(projectId)
  return coordinatorOperations.start(coordinatorProject(p.id)!, objective, cols, rows, images, runId, typeId).ptyId
}

/** Host собирает ports одного явного проекта; runtime не знает выбора проекта в окне. */
function coordinatorProject(projectId: string): CoordinatorProject | undefined {
  const project = projects.get(projectId)
  if (!project) return undefined
  return {
    store: projects.store(projectId), root: project.root,
    environment: runId => ctx(projectId, runId),
    newRunEnvironment: typeId => {
      const type = projects.runType(projectId, typeId)
      return { ...typeCtx(projectId, projects.resolveType(projectId, type.typeId)), type }
    },
    workflow: runWorkflowDeps(projectId)
  }
}

/** Чат живёт независимо от окна и выбранного проекта. Amp/Shell используют отдельный PTY. */
const assistantSession = new AssistantSession({
  repository: createDialogRepository(join(app.getPath('userData'), DIALOGS_FILE)),
  onError: error => console.error(error),
  settings: () => projects.settings().assistant,
  assertUsable: (agent) => assertAgentUsable(agentInfos(undefined), agent),
  isAlive,
  killTerminal: killPty,
  startTerminal: (settings, cols, rows, onExit) => startAssistant({ socketPath: SOCKET_PATH, settings }, cols, rows, onExit).ptyId,
  create: (settings, onUpdate) => {
    const launch = assistantLaunch(settings, BUILTIN_PROMPTS.assistant, mainLocale())
    const cwd = assistantCwd(app.getPath('userData'))
    mkdirSync(cwd, { recursive: true })
    return createAssistantConversation({
      agent: launch.agent, system: launch.system, model: launch.model, effort: launch.effort, extraArgs: launch.extraArgs, cwd,
      env: assistantEnv({ socketPath: SOCKET_PATH, path: workerPath(), nodePath: app.isPackaged ? process.execPath : undefined }),
      onUpdate
    })
  },
  onUpdate: (update) => { if (win && !win.isDestroyed()) win.webContents.send(`assistantChat:message:${update.ptyId}`, update) }
})

/**
 * Удаление глобальной задачи (IPC и сокет): при живом координаторе — ошибка; store отвергает подзадачи
 * с живым dispatch и удаление с подзадачами без cascade. Оставшиеся терминалы подзадач (после `done`
 * dispatch закрыт, а PTY жив) закрываются после удаления.
 */
function removeGlobalTask(p: { id: string; store: TaskStore; root: string }, runId: string, cascade: boolean): { deleted: string; tasks: string[] } {
  return globalTaskRemoval(p, runId, cascade)
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
      if (snap.runs.some(hasIdleStage)) {
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
function resolveRequest(projectId: string | undefined, id: string, resolution: RequestResolution, images?: unknown): ResolveOutcome {
  const p = resolveProject(projectId)
  return reviewOperations.resolve(reviewProject(p.id)!, id, resolution, images)
}

/** Тестовое уведомление из настроек: показывается всегда, звук и превью — по настройкам. */
function testNotification(): void {
  if (!Notification.isSupported()) throw new OrcaError('notify.unsupported')
  const s = projects.settings().notifications
  const body = s.showPreview ? mt('notify.testPreview') : mt('notify.question')
  new Notification({ title: 'orca-board', body, silent: !s.sound }).show()
}

/** Корень источника документов: проект или worktree его задачи в работе. Чужие id — ошибка. */
function docRoot(source: unknown): string {
  const p = resolveProject()
  return docSourceRoot(source, p.root, docTasks(p.store))
}

/** Диалог выбора репозитория для «Добавить проект»; отмена — null. */
async function pickRepoFolder(): Promise<string | null> {
  if (!win) throw new Error('no window')
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: mt('dialog.pickRepo') })
  return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
}

/**
 * Диалог «Сохранить как» для файла экспорта типа; отмена — null. Перезапись существующего файла подтверждает сам
 * диалог. Окна нет — диалог без родителя (как `showMessageBox` при выходе).
 */
async function pickExportFile(defaultName: string): Promise<string | null> {
  const opts = {
    title: mt('dialog.exportType'),
    defaultPath: join(app.getPath('downloads'), defaultName),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  }
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  return res.canceled || !res.filePath ? null : res.filePath
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
  ipcMain.on('app:windowFullscreenReady', (event) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return
    event.sender.send('app:windowFullscreen', windowFullscreen)
  })
  handle('app:getMenu', (event) => {
    if (process.platform !== 'win32' || !win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return []
    win.webContents.setIgnoreMenuShortcuts(true)
    return applicationMenuSnapshot(Menu.getApplicationMenu()?.items ?? [])
  })
  handle('app:invokeMenu', (event, id: unknown) => {
    if (process.platform !== 'win32' || !win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return
    win.webContents.setIgnoreMenuShortcuts(false)
    const menu = applicationMenuSnapshot(Menu.getApplicationMenu()?.items ?? [])
    runApplicationMenuCommand(menu, id, windowMenuCommands(win, appMenuHandlers()))
  })
  handle('app:dismissMenu', (event) => {
    if (process.platform !== 'win32' || !win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return
    win.webContents.setIgnoreMenuShortcuts(false)
  })
  ipcMain.on('app:menuReady', (event, ready: unknown) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return
    if (ready === true) {
      const pending = menuActions.connect()
      if (pending) win.webContents.send('app:menuAction', pending)
    } else if (ready === false) menuActions.disconnect()
  })
  handle('app:getSettings', () => projects.settings())
  handle('app:setSettings', (_e, patch: AppSettingsPatch) => {
    const settings = projects.setSettings(patch ?? {})
    // Язык меняется без перезапуска: трей пересобирается сразу, диалоги и уведомления берут его при показе.
    setMainLocale(settings.language)
    refreshApplicationMenu()
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
  // Начальный коммит — только по кнопке человека после `git.noCommits`; неизвестный режим от renderer — пустой коммит,
  // он не забирает файлы человека в историю.
  handle('projects:createInitialCommit', (_e, id: string, mode: InitialCommitMode) =>
    createInitialCommit(projectRoot(id), mode === 'snapshot' ? 'snapshot' : 'empty')
  )
  handle('projects:setActive', (_e, id: string) => projects.setActive(id))
  // Картинки глобальных задач (userData/run-images) и снимки показа (userData/showcase) удаляет сам
  // ProjectManager.remove — общий путь с сокетом.
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
  handle('taskTypes:patch', (_e, id: string, patch: TaskTypePatch) => projects.patchTaskType(id, patch))
  handle('taskTypes:rename', (_e, id: string, title: string, description: string) => projects.renameTaskType(id, { title, description }))
  handle('workflowAssistant:save', (_e, id: string, baseline: Workflow, workflow: Workflow | null) => saveWorkflowDraft(projects, id, baseline, workflow))
  handle('taskTypes:save', (_e, input: TaskTypeInput) => projects.saveTaskType(input))
  handle('taskTypes:delete', (_e, id: string) => projects.deleteTaskType(id))
  handle('taskTypes:duplicate', (_e, id: string) => projects.duplicateTaskType(id))
  handle('taskTypes:setDefault', (_e, id: string) => projects.setDefaultTaskType(id))
  handle('taskTypes:export', (_e, id: string) => exportTaskTypeToFile({
    export: (typeId) => projects.exportTaskType(typeId, { appVersion: app.getVersion(), exportedAt: new Date().toISOString() }),
    chooseFile: pickExportFile,
    write: writeFileAtomic
  }, id))
  handle('nodeTemplates:list', () => projects.nodeTemplates())
  handle('nodeTemplates:save', (_e, input: NodeTemplateInput) => projects.saveNodeTemplate(input))
  handle('nodeTemplates:delete', (_e, id: string) => projects.deleteNodeTemplate(id))

  registerDesktopBoardCommands(handle, {
    commands: boardCommands,
    activeProjectId: () => projects.active()?.id,
    clientId: event => win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
      ? `desktop:${event.sender.id}` : null
  })
  handle('runs:list', () => (projects.active() ? projects.activeStore().listRuns() : []))
  handle('runs:close', (_e, runId: string) => projects.activeStore().closeRun(runId))

  registerDesktopGlobalTaskCommands(handle, {
    commands: globalTaskCommands,
    activeProjectId: () => projects.active()?.id,
    clientId: event => win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
      ? `desktop:${event.sender.id}` : null
  })
  // Показать в папке — любое вложение задачи (только из её метаданных).
  handle('globalTasks:revealAttachment', (_e, id: string, imageId: string) => {
    const p = resolveProject()
    shell.showItemInFolder(revealTaskAttachment(p.store, runImagesRoot(app.getPath('userData')), p.id, id, imageId))
  })
  // Открыть приложением системы — только белый список (`attachmentOpenable`: картинки, Markdown, PDF), не HTML, SVG и не программы.
  handle('globalTasks:openAttachment', async (_e, id: string, imageId: string) => {
    const p = resolveProject()
    const err = await shell.openPath(openTaskAttachment(p.store, runImagesRoot(app.getPath('userData')), p.id, id, imageId))
    if (err) throw new Error(err)
  })
  registerDesktopCoordinatorCommands(handle, {
    commands: coordinatorCommands,
    activeProjectId: () => projects.active()?.id,
    clientId: event => win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
      ? `desktop:${event.sender.id}` : null
  })
  registerDesktopReviewRequestCommands(handle, {
    review: reviewCommands, requests: humanRequestCommands,
    activeProjectId: () => projects.active()?.id,
    clientId: event => win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
      ? `desktop:${event.sender.id}` : null
  })

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

  registerDesktopWorkerCommands(handle, {
    commands: workerCommands, activeProjectId: () => projects.active()?.id,
    clientId: event => win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
      ? `desktop:${event.sender.id}` : null
  })
  handle('assistant:open', (_e, cols: number, rows: number) => assistantSession.open(cols, rows, false))
  handle('assistant:reset', (_e, cols: number, rows: number) => assistantSession.open(cols, rows, true))
  handle('assistantChat:available', (_e, id: string) => assistantSession.available(id))
  handle('assistantChat:getMessages', (_e, id: string) => assistantSession.snapshot(id))
  handle('assistantChat:sendWithWorkflow', (_e, id: string, text: unknown, context: unknown) => assistantSession.send(id, text, buildWorkflowAssistantContext(projects, context)))
  handle('assistantChat:send', (_e, id: string, text: unknown) => assistantSession.send(id, text))
  handle('assistantChat:interrupt', (_e, id: string) => assistantSession.interrupt(id))
  handle('assistantChat:respond', (_e, id: string, requestId: string, answer: InteractionAnswer) => assistantSession.respond(id, requestId, answer))
  handle('docs:list', () => {
    if (!projects.active()) return []
    const p = resolveProject()
    return listDocGroups(p.root, currentBranch(p.root), docTasks(p.store))
  })
  handle('docs:read', (_e, source: unknown, path: unknown) => readDoc(docRoot(source), path))
  // Любой файл источника (main/docs-view.ts): бинарь, не UTF-8, большой и PDF — `stub`, не ошибка.
  handle('docs:view', (_e, source: unknown, path: unknown, opts: unknown) => viewDoc(docRoot(source), path, opts))
  handle('docs:bytes', (_e, source: unknown, path: unknown) => readDocBytes(docRoot(source), path))
  // Токен протокола показа на корень источника — всегда без сети: HTML проекта — недоверенный код.
  handle('docs:previewUrl', (_e, source: unknown, path: unknown) => docsPreviewUrl(previewTokens, docRoot(source), path))
  // Открыть приложением системы — только белый список показа (по пути и по цели симлинка); показать в папке — любой файл.
  handle('docs:open', async (_e, source: unknown, path: unknown) => {
    const err = await shell.openPath(await docsOpenPath(docRoot(source), path))
    if (err) throw new Error(err)
  })
  handle('docs:reveal', async (_e, source: unknown, path: unknown) => {
    shell.showItemInFolder(await docsRevealPath(docRoot(source), path))
  })
  // Рукопожатие для вложений к замечаниям: renderer проверяет, что main новый и принимает `images`.
  handle('attachments:ping', () => true)
  // Что main принимает во вложениях: любые файлы в лимитах `ATTACHMENT_LIMITS` (`validateAttachments`).
  handle('attachments:capabilities', (): AttachmentCapabilities => attachmentCapabilities())
  // Показ человеку: файлы задачи активного проекта (снимок запуска или worktree — showcaseSource), белый список
  // расширений — main/showcase.ts.
  const source = (taskId: unknown, dispatchId: unknown): string => {
    const p = resolveProject()
    return showcaseSource(p.store, taskId, dispatchId, showcaseSnapshots(p.id))
  }
  handle('showcase:read', (_e, taskId: unknown, path: unknown, dispatchId: unknown) => readShowcaseFile(source(taskId, dispatchId), path))
  handle('showcase:open', async (_e, taskId: unknown, path: unknown, dispatchId: unknown) => {
    const err = await shell.openPath(resolveShowcasePath(source(taskId, dispatchId), path))
    if (err) throw new Error(err)
  })
  handle('showcase:reveal', (_e, taskId: unknown, path: unknown, dispatchId: unknown) =>
    shell.showItemInFolder(resolveShowcasePath(source(taskId, dispatchId), path))
  )
  // Страница показа для изолированного фрейма: токен протокола orca-preview:// на корень показа (preview-protocol.ts).
  handle('showcase:previewUrl', (_e, dispatchId: unknown, path: unknown, opts: unknown) => {
    const p = resolveProject()
    return showcasePreviewUrl(p.store, previewTokens, dispatchId, path, opts, showcaseSnapshots(p.id))
  })
  // База для картинок описания показа (`showcase.text`): токен без сети на тот же корень.
  handle('showcase:previewBase', (_e, dispatchId: unknown) => {
    const p = resolveProject()
    return showcasePreviewBase(p.store, previewTokens, dispatchId, showcaseSnapshots(p.id))
  })
  // Одна папка проекта (main/project-files.ts) для диалога начального коммита; вкладки «Файлы» нет. Корень — явного projectId, неизвестный id — обычная ошибка «project not found».
  handle('files:list', (_e, projectId: unknown, dir: unknown) => listProjectDir(projectRoot(String(projectId)), dir ?? ''))
  // Только показать в Finder/Проводнике, не openPath: запуск произвольного файла опасен. Симлинк — сам симлинк.
  handle('files:reveal', async (_e, projectId: unknown, path: unknown) => {
    shell.showItemInFolder(await resolveProjectPath(projectRoot(String(projectId)), path, false))
  })
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
}

function initializeDesktop(): void {
  app.setAppUserModelId('orca-board')
  if (process.platform === 'darwin') app.dock?.setIcon(appIconPath)
  protocol.handle(PREVIEW_SCHEME, (request) => handlePreviewRequest(request, previewTokens))
  // ДО ProjectManager и досок: их миграции переписывают файлы, а бэкап хранит состояние в формате старой версии.
  rememberUpdate(backupOnVersionChange(app.getPath('userData'), app.getVersion()))
  // До первого запуска агентов: system prompt прошлых запусков на Windows (`win32Launch`) больше никто не читает.
  pruneLaunchTempFiles()
  projects = new ProjectManager(app.getPath('userData'))
  const authorize = (context: ProjectCommandContext) => Boolean(win && !win.isDestroyed()
    && context.clientId === `desktop:${win.webContents.id}` && context.actor.kind === 'operator' && context.actor.id === 'local-user')
  const selection = createAgentSelection({ error: (key, params) => new OrcaError(key, params) })
  const removal = {
    resources: executionResources, dataDir: app.getPath('userData'),
    messages: { error: (key: 'global.coordinatorAlive') => new OrcaError(key) },
    sessions: { isAlive, kill: killPty }
  }
  globalTaskRemoval = createGlobalTaskRemoval(removal)
  boardCommands = createBoardCommands({
    project: id => projects.get(id) ? {
      store: projects.store(id), roles: () => projects.resolveRun(id), agents: () => projectAgents(id)
    } : undefined,
    authorize, selection
  })
  globalTaskCommands = createGlobalTaskCommands({
    ...removal, authorize, selection,
    project: id => {
      const project = projects.get(id)
      return project ? {
        store: projects.store(id), root: project.root,
        runType: typeId => projects.runType(id, typeId),
        roles: runId => projects.resolveRun(id, runId), agents: () => projectAgents(id)
      } : undefined
    }
  })
  const coordinatorHost = {
    workers: { startCoordinator, returnToWork }, workflow: workflowServices.run,
    resources: executionResources,
    messages: { error: (key: 'workflow.runFinished' | 'workflow.coordinatorNotRunning') => new OrcaError(key) }
  }
  coordinatorOperations = createCoordinatorOperations(coordinatorHost)
  coordinatorCommands = createCoordinatorCommands({ ...coordinatorHost, project: coordinatorProject, authorize })
  const workerHost = { workers: { startWorker }, workflow: workflowServices.task,
    preflight: { validate: validateWorkerRole }, lifecycle: taskWorkerLifecycle }
  workerOperations = createWorkerOperations(workerHost)
  workerCommands = createWorkerCommands({ ...workerHost, project: workerProject, authorize })
  const reviewHost: ReviewOperationHost = { workflow: workflowServices, resources: executionResources,
    lifecycle: taskWorkerLifecycle, messages: { error: (key, params) => new OrcaError(key, params) } }
  reviewOperations = createReviewOperations(reviewHost)
  reviewCommands = createReviewCommands({ ...reviewHost, project: reviewProject, authorize })
  humanRequestCommands = createHumanRequestCommands({ ...reviewHost, project: reviewProject, authorize })
  syncMainAppearance()
  setMainLocale(projects.settings().language)
  refreshApplicationMenu()
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
    taskWorkerLifecycle.closeDoneWorkers(store)
    // Закрытие и «Сделано» глобальной задачи — тоже любой путь (runs finish, перенос, выход координатора).
    const project = projects.get(projectId)
    if (project) runBranchSync.sync(store, project.root)
    refreshTray()
  })
  projects.onEvents(notify)
  projects.onEvents(deliverAnswers)
  projects.onEvents(runWorkflowEvents)
  projects.onStoreOpened(resumeProjectStages)
  // Настройки/проекты/типы/роли/шаблоны нод правит и CLI/ассистент через сокет — окно должно узнать об этом
  // так же, как о своих собственных IPC-правках (docs/assistant-chat.md → «Настройки»).
  projects.onDataChange(() => {
    syncMainAppearance()
    if (win && !win.isDestroyed()) win.webContents.send('app:changed')
  })
  projects.onWorkflowSaved((saved) => {
    if (win && !win.isDestroyed()) win.webContents.send('workflowAssistant:saved', saved)
  })
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
        assistantSession.dispose()
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
    libraryTaskTypes: () => ({ taskTypes: projects.taskTypes(), defaultTypeId: projects.defaultTaskTypeId() }),
    workflowGet: (id) => projects.workflowGet(id),
    workflowValidate: (definition, selection) => projects.workflowValidate(definition, selection),
    workflowSet: (id, revision, definition) => projects.workflowSet(id, revision, definition),
    workflowCreate: (input) => projects.workflowCreate(input),
    resolve: (projectId) => {
      const p = resolveProject(projectId)
      return {
        store: p.store,
        startWorker: (taskId) => runWorker(taskId, p.id),
        stopWorker: (taskId) => workerOperations.stop(p, taskId),
        review: (taskId) => reviewOperations.info(reviewProject(p.id)!, taskId),
        accept: (taskId, decision) => void reviewDecision(p.id, taskId, 'accept', decision),
        reject: (taskId, feedback) => reviewDecision(p.id, taskId, 'reject', feedback),
        finishStage: (runId, summary, nodeId) => finishRunStage(runWorkflowDeps(p.id), runId, summary, nodeId),
        decide: (taskId, option, reason) => runDecision(runWorkflowDeps(p.id), taskId, option, reason),
        escalateDecision: (taskId, reason) => escalateDecision(runWorkflowDeps(p.id), taskId, reason),
        resolveRequest: (id, resolution) => resolveRequest(p.id, id, resolution),
        startCoordinator: (objective, runId, typeId) => runCoordinator(objective, p.id, undefined, undefined, [], runId, typeId),
        deleteGlobalTask: (runId, cascade) => removeGlobalTask(p, runId, cascade),
        snapshotShowcase: (dispatchId, files, text) => snapshotDispatchShowcase(p.store, showcaseSnapshots(p.id), dispatchId, files, text),
        agents: () => projectAgents(p.id),
        resolveRun: (runId) => projects.resolveRun(p.id, runId),
        taskTypes: () => ({ taskTypes: projects.projectTaskTypes(p.id), defaultTypeId: projects.projectDefaultTypeId(p.id) }),
        runType: (typeId) => projects.runType(p.id, typeId),
        saveTaskTypeRules: (typeId, roleId, text) => projects.saveTaskTypeRules(typeId, roleId, text),
        columns: () => projects.columns(p.id),
        workflow: (typeId) => projects.taskTypeWorkflow(typeId ?? projects.projectDefaultTypeId(p.id)),
        // Настройки: библиотека типов задач, роли, шаблоны нод — общая для всех проектов, `p` только определяет,
        // через какой проект команда пришла (docs/assistant-chat.md → «2. Контракт CLI/сокета для настроек»).
        typesCreate: (input) => projects.saveTaskType({ ...input, settings: {} }),
        typesRename: (id, patch) => projects.renameTaskType(id, patch),
        typesSetDefault: (id) => projects.setDefaultTaskType(id),
        typesDuplicate: (id) => projects.duplicateTaskType(id),
        typesUsage: (id) => projects.taskTypeUsage(id),
        typesDelete: (id) => projects.deleteTaskType(id),
        rolesAdd: (typeId, input) => projects.addRole(typeId, input),
        rolesUpdate: (typeId, roleId, patch) => projects.updateRole(typeId, roleId, patch),
        rolesRemove: (typeId, roleId) => projects.removeRole(typeId, roleId),
        permissionMode: (typeId) => projects.permissionMode(typeId),
        setPermissionMode: (typeId, mode) => {
          projects.patchTaskType(typeId, { permissionMode: mode })
          return projects.permissionMode(typeId)
        },
        nodeTemplates: () => projects.nodeTemplates(),
        deleteNodeTemplate: (id) => projects.deleteNodeTemplate(id),
        setActive: () => projects.setActive(p.id),
        removeProject: () => {
          projects.remove(p.id)
          return { removed: p.id }
        },
        // Сокет уже сверил id с реестром агентов (project.agents.set в socket.ts) — здесь как есть.
        setEnabledAgents: (ids) => projects.setEnabledAgents(p.id, ids as AgentKind[]),
        setColumns: (columns) => projects.setColumns(p.id, columns),
        setProjectTaskTypes: (input) => projects.setProjectTaskTypes(p.id, input),
        projectRulesGet: (file) => readRule(p.root, file),
        projectRulesSet: (file, text) => writeRule(p.root, file, text)
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
    },
    settings: () => projects.settings(),
    // Как `app:setSettings` в registerIpc: язык, трей и апдейтер должны узнать о правке независимо от того,
    // пришла ли она из renderer или от ассистента через `settings set`.
    setSettings: (patch) => {
      const settings = projects.setSettings(patch)
      setMainLocale(settings.language)
      refreshApplicationMenu()
      refreshTray()
      updater.settingsChanged()
      return settings
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
}

function failDesktopStartup(error: unknown): void {
  quitting = true
  console.error(error)
  const message = profileStartupMessage(error)
  try {
    dialog.showErrorBox(mt('runtime.startupTitle'), mt(message.key, message.params))
  } finally {
    app.exit(1)
  }
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock || quitting) return
  await startProfileRuntime({
    dataDir: app.getPath('userData'),
    start: () => {
      if (quitting) return
      try {
        initializeDesktop()
        desktopInitialized = true
      } catch (error) {
        // Частичный Desktop startup может уже открыть IPC/PTY: процесс выходит до освобождения guard.
        failDesktopStartup(error)
        throw error
      }
    }
  })
  // Legacy IPC/socket живут до quit, поэтому Desktop удерживает ownership до выхода процесса.
}).catch(failDesktopStartup)

// Cmd+Q, «Выйти» из меню приложения, app.quit() — всё идёт через подтверждение.
app.on('before-quit', (e) => {
  if (quitting) return
  if (!projects) {
    quitting = true
    return
  }
  e.preventDefault()
  void requestQuit()
})

app.on('window-all-closed', () => {
  // Фоновый режим: окно закрыто, приложение, PTY и уведомления живут; вернуться — Dock или трей.
  if (projects?.settings().keepInBackground ?? true) return
  quitNow()
})
