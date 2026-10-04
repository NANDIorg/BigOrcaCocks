import type { Workflow } from '@orca-board/core'
import { buildWorkflowAssistantContext } from './assistant-workflow'
import type { AttachmentCapabilities } from '../shared/ipc'
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, net, protocol, shell, dialog, Notification, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { getAppTheme } from '../shared/theme'
import { mainWindowChrome, windowsTitleBarOverlay } from './window-chrome'
import { defaultSocketPath, validateAttachments, coordinatorsToClose, getAgent, withStatusSource, type Attachment, type TaskStore, type Task, type OrcaEvent, type AgentKind, type AgentInfo, type BoardColumn, type RequestResolution, type ResolvedRunType } from '@orca-board/core'
import { sessionRegistry, writePty, killPty, killAll, silentFor, lastActivityAt, isAlive, setPtyWindow } from './pty'
import { startWorker, startCoordinator, startAssistant, returnToWork, workerPath, pruneLaunchTempFiles, type WorkerEnvContext } from './worker'
import { assistantCwd, assistantEnv, assistantLaunch } from './assistant'
import { createAssistantConversation, stopAssistantConversations } from './assistant-conversation'
import { disposeAgentLauncher } from './agent-launch'
import { AssistantSession } from './assistant-session'
import { transcriptEnv } from './transcripts'
import { workflowServices } from './workflow-services'
import type { ResolveOutcome, ProfileRuntime } from '@orca-board/runtime'
import { createDialogRepository, DIALOGS_FILE, startProfileRuntime, createRuntimeServices, assertProfileSchemas, createLegacySocketDeps, createRecoveryCommands, createBoardCommands, createAgentSelection, createGlobalTaskCommands, createGlobalTaskRemoval, createCoordinatorCommands, createCoordinatorOperations, createWorkerCommands, createWorkerOperations, createTaskWorkerLifecycle, createReviewCommands, createHumanRequestCommands, createReviewOperations, createProfileCommands, createProjectConfigCommands, createWorkflowAssistantServices, createRuleCommands, createStatsCommands, statsProject, isStatsProjectCurrent, statsProjectDeps, createFileCommands, createProjectGitCommands, createRunCommands, createAgentCommands, createSessionCommands, createSessionWriterLeases, createAssistantCommands, registeredProject, isRegisteredProjectCurrent, obsoleteEffect, type ReviewOperationHost, type ReviewProject, type CoordinatorProject, type WorkerProject } from '@orca-board/runtime'
import type { BoardCommands, GlobalTaskCommands, CoordinatorCommands, WorkerCommands, ReviewCommands, HumanRequestCommands, ClientCommandContext, ProfileCommands, ProjectConfigCommands, RuleCommands, StatsCommands, FileCommands, ProjectGitCommands, RunCommands, AgentCommands, SessionCommands, AssistantCommands, RecoveryCommands } from '@orca-board/contracts'
import { registerDesktopBoardCommands } from './board-commands'
import { registerDesktopGlobalTaskCommands } from './global-task-commands'
import { registerDesktopCoordinatorCommands } from './coordinator-commands'
import { registerDesktopWorkerCommands } from './worker-commands'
import { registerDesktopReviewRequestCommands } from './review-request-commands'
import { registerDesktopProfileCommands } from './profile-commands'
import { registerDesktopRulesStatsCommands } from './rules-stats-commands'
import { registerDesktopFileCommands } from './file-commands'
import { registerDesktopProjectRunAgentCommands } from './project-run-agent-commands'
import { registerDesktopSessionAssistantCommands } from './session-assistant-commands'
import { executionResources } from './execution-resources'
import { initializeEffectJournal, getEffectJournal, requiredEffectJournal } from './effect-journal'
import { registerDesktopRecoveryCommands } from './recovery-commands'
import { gitProcesses } from './git'
import { profileStartupMessage } from './profile-startup-errors'
import { attachmentCapabilities } from './attachments'
import { showcaseServices } from './showcase'
import { PREVIEW_SCHEME, PreviewTokens, allowFrameNavigation, handlePreviewRequest, isExternalWebUrl } from './preview-protocol'
import { showcaseSnapshotsRoot, snapshotDispatchShowcase, type ShowcaseSnapshots } from './showcase-snapshot'
import type { WorkflowDeps } from './workflow'
import { validateWorkerRole } from './worker-preflight'
import {
  escalateDecision, finishRunStage, runDecision,
  hasIdleStage, settleIdleRunStages,
  type RunWorkflowDeps
} from './workflow-run'
import { docServices } from './docs'
import { docViewServices } from './docs-view'
import { ruleServices, readRule, writeRule } from './rules'
import { projectFileServices } from './project-files'
import { currentBranch } from './git'
import { mergeTarget, RunBranchSync } from './run-branch'
import { runImagesRoot, revealTaskAttachment, openTaskAttachment } from './run-images'
import { startSocketServer, askWaiting, stopAgentSocket } from './socket'
import { ProjectManager, runnableWorkflow } from './projects'
import { writeFileAtomic } from './persistence'
import { agentInfos, assertAgentUsable, missingRoleText, pickRole } from './agents'
import { BUILTIN_PROMPTS } from './prompts'
import { createTray, refreshTray } from './tray'
import { statsServices } from './stats'
import { createUpdater, type Updater, type InstallChoice, type InstallRequest } from './updater'
import { createPlatformUpdater } from './updaterBackend'
import type { AppSettings, AppSettingsPatch, UpdateInstallWhen, RequestFocus } from '../shared/ipc'
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
let runtimeServices: ReturnType<typeof createRuntimeServices<AppSettings, AppSettingsPatch>>
let desktopRuntime: ProfileRuntime<void> | undefined
let desktopCleanup: Promise<void> | undefined
let projects: ProjectManager
let recoveryCommands: RecoveryCommands
let boardCommands: BoardCommands
let globalTaskCommands: GlobalTaskCommands
let coordinatorCommands: CoordinatorCommands
let coordinatorOperations: ReturnType<typeof createCoordinatorOperations>
let workerCommands: WorkerCommands
let workerOperations: ReturnType<typeof createWorkerOperations>
let reviewCommands: ReviewCommands
let humanRequestCommands: HumanRequestCommands
let reviewOperations: ReturnType<typeof createReviewOperations>
let profileCommands: ProfileCommands<AppSettings, AppSettingsPatch>
let projectConfigCommands: ProjectConfigCommands
let ruleCommands: RuleCommands
let statsCommands: StatsCommands
let fileCommands: FileCommands
let projectGitCommands: ProjectGitCommands
let runCommands: RunCommands
let agentCommands: AgentCommands
let sessionCommands: SessionCommands
let assistantCommands: AssistantCommands
const sessionWriterLeases = createSessionWriterLeases({ isAlive })
sessionRegistry.subscribe(event => { if (event.type === 'exit') sessionWriterLeases.dropSession(event.ptyId) })
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
  const sessionClientId = `desktop:${created.webContents.id}`
  // В авторском меню renderer сначала возвращает фокус редактору и сам вызывает команду.
  // Blur/reload/crash возвращают нативные сочетания, даже если renderer не успел закрыть popup.
  const restoreMenuShortcuts = (): void => {
    if (process.platform === 'win32' && !created.webContents.isDestroyed()) created.webContents.setIgnoreMenuShortcuts(false)
  }
  if (process.platform === 'win32') created.on('blur', restoreMenuShortcuts)
  win.on('closed', () => {
    sessionWriterLeases.dropClient(sessionClientId)
    if (win === created) {
      win = null
      menuActions.clear()
    }
    setPtyWindow(win)
  })
  win.webContents.on('did-start-loading', () => {
    // Загрузка показа в iframe не размонтирует App: его подписка на меню остаётся действующей.
    if (created.webContents.isLoadingMainFrame()) {
      sessionWriterLeases.dropClient(sessionClientId)
      menuActions.disconnect()
      restoreMenuShortcuts()
    }
  })
  win.webContents.on('render-process-gone', () => { sessionWriterLeases.dropClient(sessionClientId); menuActions.disconnect(); restoreMenuShortcuts() })
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

function cleanupDesktop(): Promise<void> {
  if (desktopCleanup) return desktopCleanup
  quitting = true
  assistantSession.dispose()
  desktopCleanup = Promise.all([stopAgentSocket(), runtimeServices?.stop(), stopAssistantConversations(), sessionRegistry.stop(), gitProcesses.stop()])
    .then(() => { disposeAgentLauncher() })
  void desktopCleanup.catch(() => { desktopCleanup = undefined })
  return desktopCleanup
}

async function quitNow(): Promise<void> {
  quitting = true
  await cleanupDesktop()
  await desktopRuntime?.stop()
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
    if (response === 0) await quitNow()
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
const executionContextFor = (...args: Parameters<typeof runtimeServices.executionContextFor>) => runtimeServices.executionContextFor(...args)
const ctx = (...args: Parameters<typeof runtimeServices.ctx>) => runtimeServices.ctx(...args)
const typeCtx = (...args: Parameters<typeof runtimeServices.typeCtx>) => runtimeServices.typeCtx(...args)
const projectAgents = (...args: Parameters<typeof runtimeServices.projectAgents>) => runtimeServices.projectAgents(...args)
const showcaseSnapshots = (...args: Parameters<typeof runtimeServices.showcaseSnapshots>) => runtimeServices.showcaseSnapshots(...args)
const resolveProject = (...args: Parameters<typeof runtimeServices.resolveProject>) => runtimeServices.resolveProject(...args)
const runWorker = (...args: Parameters<typeof runtimeServices.runWorker>) => runtimeServices.runWorker(...args)
const workerProject = (...args: Parameters<typeof runtimeServices.workerProject>) => runtimeServices.workerProject(...args)
const workflowDeps = (...args: Parameters<typeof runtimeServices.workflowDeps>) => runtimeServices.workflowDeps(...args)
const runWorkflowDeps = (...args: Parameters<typeof runtimeServices.runWorkflowDeps>) => runtimeServices.runWorkflowDeps(...args)

/**
 * Решение по задаче на этапе проверки (`review accept|reject`, «Принять»/«Вернуть» на карточке проверки): проверка ветки
 * глобальной задачи — исход ноды `gate` (`workflow-run.ts`), остальное — прежний движок (`workflow.ts`). Задачу-решатель
 * развилки `runGateDecision` отвергает: её ветку выбирают `decision choose` или человек по запросу `decision`.
 */
function reviewDecision(projectId: string, taskId: string, decision: 'accept' | 'reject', text?: string, images?: unknown): Promise<Task | undefined> {
  const p = resolveProject(projectId)
  return reviewOperations.decide(reviewProject(p.id)!, taskId, decision, text, images)
}

/** Явный project port одинаков для IPC и callbacks socket; выбор окна не попадает в runtime. */
const reviewProject = (...args: Parameters<typeof runtimeServices.reviewProject>) => runtimeServices.reviewProject(...args)
const runCoordinator = (...args: Parameters<typeof runtimeServices.runCoordinator>) => runtimeServices.runCoordinator(...args)
const coordinatorProject = (...args: Parameters<typeof runtimeServices.coordinatorProject>) => runtimeServices.coordinatorProject(...args)

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
function removeGlobalTask(p: { id: string; store: TaskStore; root: string }, runId: string, cascade: boolean): Promise<{ deleted: string; tasks: string[] }> {
  return globalTaskRemoval({ ...p, ...executionContextFor(p.id) }, runId, cascade)
}

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
function resolveRequest(projectId: string | undefined, id: string, resolution: RequestResolution, images?: unknown): Promise<ResolveOutcome> {
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
  registerDesktopProfileCommands(handle, {
    commands: profileCommands, config: projectConfigCommands,
    clientId: event => win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
      ? `desktop:${event.sender.id}` : null,
    activeProject: () => projects.active(), setActive: id => projects.setActive(id),
    chooseFolder: pickRepoFolder, chooseExportFile: pickExportFile, writeExport: writeFileAtomic,
    settingsChanged: settings => {
      // Язык и системные оболочки Desktop обновляются после успешной записи общих настроек.
      setMainLocale(settings.language)
      refreshApplicationMenu()
      refreshTray()
      updater.settingsChanged()
    }
  })
  handle('app:testNotification', () => testNotification())
  handle('updates:getState', () => updater.getState())
  handle('updates:check', () => updater.check())
  handle('updates:download', () => updater.download())
  handle('updates:install', (_e, opts: { when: UpdateInstallWhen }) => updater.install(opts))
  handle('updates:cancelPending', () => updater.cancelPending())
  handle('updates:getJustUpdated', () => updater.getJustUpdated())
  handle('app:info', () => ({ socketPath: SOCKET_PATH, active: projects.active(), projects: projects.list() }))
  registerDesktopProjectRunAgentCommands(handle, {
    projects: projectGitCommands, runs: runCommands, agents: agentCommands,
    activeProjectId: () => projects.active()?.id,
    clientId: event => win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
      ? `desktop:${event.sender.id}` : null
  })
  handle('prompts:builtin', () => BUILTIN_PROMPTS)

  registerDesktopBoardCommands(handle, {
    commands: boardCommands,
    activeProjectId: () => projects.active()?.id,
    clientId: event => win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
      ? `desktop:${event.sender.id}` : null
  })

  registerDesktopGlobalTaskCommands(handle, {
    commands: globalTaskCommands,
    activeProjectId: () => projects.active()?.id,
    clientId: event => win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
      ? `desktop:${event.sender.id}` : null,
    attachments: {
      reveal: (ctx, id, imageId) => {
        const p = resolveProject(ctx.projectId)
        shell.showItemInFolder(revealTaskAttachment(p.store, runImagesRoot(app.getPath('userData')), p.id, id, imageId))
      },
      open: async (ctx, id, imageId) => {
        const p = resolveProject(ctx.projectId)
        const error = await shell.openPath(openTaskAttachment(p.store, runImagesRoot(app.getPath('userData')), p.id, id, imageId))
        if (error) throw new Error(error)
      }
    }
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

  registerDesktopSessionAssistantCommands<IpcMainInvokeEvent>(handle, (channel, listener) => ipcMain.on(channel, listener), {
    sessions: sessionCommands, assistant: assistantCommands,
    activeProjectId: () => projects.active()?.id,
    clientId: event => win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
      ? `desktop:${event.sender.id}` : null,
    onEventError: (error, channel) => console.error(channel, error)
  })

  registerDesktopWorkerCommands(handle, {
    commands: workerCommands, activeProjectId: () => projects.active()?.id,
    clientId: event => win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
      ? `desktop:${event.sender.id}` : null
  })
  registerDesktopFileCommands<IpcMainInvokeEvent>(handle, {
    commands: fileCommands, activeProjectId: () => projects.active()?.id,
    clientId: event => win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
      ? `desktop:${event.sender.id}` : null
  })
  // Рукопожатие для вложений к замечаниям: renderer проверяет, что main новый и принимает `images`.
  registerDesktopRecoveryCommands<IpcMainInvokeEvent>(handle, { commands: recoveryCommands,
    clientId: event => win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
      ? `desktop:${event.sender.id}` : null })
  handle('attachments:ping', () => true)
  // Что main принимает во вложениях: любые файлы в лимитах `ATTACHMENT_LIMITS` (`validateAttachments`).
  handle('attachments:capabilities', (): AttachmentCapabilities => attachmentCapabilities())
  registerDesktopRulesStatsCommands<IpcMainInvokeEvent>(handle, {
    rules: ruleCommands, stats: statsCommands, activeProjectId: () => projects.active()?.id,
    clientId: event => win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
      ? `desktop:${event.sender.id}` : null
  })
}

async function initializeDesktop(): Promise<void> {
  app.setAppUserModelId('orca-board')
  if (process.platform === 'darwin') app.dock?.setIcon(appIconPath)
  protocol.handle(PREVIEW_SCHEME, (request) => handlePreviewRequest(request, previewTokens))
  // ДО ProjectManager и досок: их миграции переписывают файлы, а бэкап хранит состояние в формате старой версии.
  rememberUpdate(backupOnVersionChange(app.getPath('userData'), app.getVersion()))
  // До первого запуска агентов: system prompt прошлых запусков на Windows (`win32Launch`) больше никто не читает.
  pruneLaunchTempFiles()
  projects = new ProjectManager(app.getPath('userData'))
  const authorize = (context: ClientCommandContext) => Boolean(!quitting && win && !win.isDestroyed()
    && context.clientId === `desktop:${win.webContents.id}` && context.actor.kind === 'operator' && context.actor.id === 'local-user')
  runtimeServices = createRuntimeServices<AppSettings, AppSettingsPatch>({ projects,
    dataDir: app.getPath('userData'), socketPath: SOCKET_PATH, ownerId: requiredEffectJournal().ownerId, version: app.getVersion(),
    resources: executionResources, processes: gitProcesses, journal: requiredEffectJournal(),
    workers: { startWorker, startCoordinator, returnToWork, startAssistant, workerPath }, sessions: sessionRegistry,
    discovery: { agentInfos }, authorize, writerLeases: sessionWriterLeases,
    askWaiting, stuckMs: STUCK_MS,
    messages: { execution: { error: (key, params) => new OrcaError(key, params) },
      workflow: { error: (key, params) => new OrcaError(key, params), text: mt,
        displayError: error => error instanceof OrcaError ? mt(error.key, error.params) : error instanceof Error ? error.message : String(error) },
      selection: { error: (key, params) => new OrcaError(key, params) }, error: key => new OrcaError(key) },
    profile: { settingsKeys: ['keepInBackground', 'updates'], workflowAssistant: createWorkflowAssistantServices({ messages: { Error: OrcaError } }) },
    sessionEnv: projectId => ({ ...(app.isPackaged ? { ORCA_NODE: process.execPath } : {}), ORCA_SOCKET: SOCKET_PATH,
      ...(projectId ? { ORCA_PROJECT: projectId } : {}), PATH: workerPath() })
  })
  ;({ sessionCommands, profileCommands, projectConfigCommands, recoveryCommands, projectGitCommands, runCommands, agentCommands,
    boardCommands, globalTaskCommands, globalTaskRemoval, coordinatorCommands, coordinatorOperations, workerCommands, workerOperations,
    reviewCommands, humanRequestCommands, reviewOperations } = runtimeServices)
  assistantCommands = createAssistantCommands({ authorize, session: assistantSession,
    buildWorkflowContext: raw => buildWorkflowAssistantContext(projects, raw) })
  ruleCommands = createRuleCommands({ project: id => projects.get(id), authorize, rules: ruleServices })
  statsCommands = createStatsCommands({ project: id => statsProject(projects, id), authorize,
    isCurrent: project => isStatsProjectCurrent(projects, project), stats: statsServices,
    messages: { Error: OrcaError }, deps: project => statsProjectDeps(projects, project, { isAlive }),
    workflow: (project, taskId) => runnableWorkflow(projects.resolveRun(project.id, project.store.getTask(taskId)?.runId).workflow)
  })
  fileCommands = createFileCommands({
    project: id => registeredProject(projects, id), authorize,
    isCurrent: project => isRegisteredProjectCurrent(projects, project),
    files: projectFileServices, docs: docServices, view: docViewServices, showcase: showcaseServices,
    tokens: previewTokens, snapshots: showcaseSnapshots, branch: project => currentBranch(project.root),
    native: {
      open: async path => { const error = await shell.openPath(path); if (error) throw new Error(error) },
      reveal: path => { shell.showItemInFolder(path) }
    }
  })
  syncMainAppearance()
  setMainLocale(projects.settings().language)
  refreshApplicationMenu()
  projects.markRun(app.getVersion())
  if (process.env.ORCA_REPO) {
    try {
      await projects.add(process.env.ORCA_REPO)
    } catch (e) {
      console.error((e as Error).message)
    }
  }
  projects.onChange((projectId, store) => {
    if (win && !win.isDestroyed()) win.webContents.send('board:changed', { projectId, snapshot: store.snapshot() })
    // Любой путь в done (review accept, task move, tasks:move из UI) проходит через commit store — ловим здесь.
    // Закрытие и «Сделано» глобальной задачи — тоже любой путь (runs finish, перенос, выход координатора).
    refreshTray()
  })
  projects.onEvents(notify)
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
        void cleanupDesktop().then(async () => { await desktopRuntime?.stop(); app.quit() }).catch(error => console.error(error))
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
  startSocketServer(SOCKET_PATH, createLegacySocketDeps(runtimeServices, ruleServices, snapshotDispatchShowcase, () => {
    setMainLocale(projects.settings().language); refreshApplicationMenu(); refreshTray(); updater.settingsChanged()
  }))
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
  desktopRuntime = await startProfileRuntime({
    dataDir: app.getPath('userData'),
    start: async context => {
      if (quitting) return
      context.deferCleanup(cleanupDesktop)
      try {
        assertProfileSchemas(context.dataDir)
        initializeEffectJournal(context.dataDir, context.owner.instanceId)
        await initializeDesktop()
        desktopInitialized = true
      } catch (error) {
        // Даже частично созданные native resources закрываются до освобождения profile guard.
        await cleanupDesktop()
        failDesktopStartup(error)
        throw error
      }
    }
  })
  // Native resources закрываются раньше lease; окна и системный updater остаются Desktop.
}).catch(failDesktopStartup)

// Cmd+Q, «Выйти» из меню приложения, app.quit() — всё идёт через подтверждение.
app.on('before-quit', (e) => {
  if (quitting) return
  if (!projects) {
    quitting = true
    return
  }
  e.preventDefault()
  void requestQuit().catch(error => console.error(error))
})

app.on('window-all-closed', () => {
  // Фоновый режим: окно закрыто, приложение, PTY и уведомления живут; вернуться — Dock или трей.
  if (projects?.settings().keepInBackground ?? true) return
  void quitNow().catch(error => console.error(error))
})
