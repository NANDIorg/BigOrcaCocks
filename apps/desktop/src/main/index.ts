import { app, BrowserWindow, ipcMain, shell, dialog, Notification } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { defaultSocketPath, validateImageAttachments, coordinatorsToClose, getAgent, DEFAULT_IMAGE_OBJECTIVE, type ImageAttachment, type TaskStore, type OrcaEvent, type AgentKind, type AgentInfo, type Role, type BoardColumn, type RequestResolution } from '@orca-board/core'
import { spawnPty, writePty, resizePty, killPty, killAll, silentFor, lastActivityAt, isAlive, setPtyWindow, terminalSnapshots } from './pty'
import { startWorker, startCoordinator, workerPath, type WorkerEnvContext } from './worker'
import { getReview, acceptReview, resolveHumanRequest } from './review'
import { listDocGroups, readDoc, resolveDocPath, PROJECT_SOURCE, type DocTask } from './docs'
import { currentBranch } from './git'
import { startSocketServer, askWaiting, answerQuestion, syncWorkerLiveness } from './socket'
import { ProjectManager, type PermissionMode, type ProjectDefaults } from './projects'
import { agentInfos, assertAgentUsable, pickRole } from './agents'
import { BUILTIN_PROMPTS } from './prompts'
import { createTray, refreshTray } from './tray'
import type { AppSettingsPatch, RequestListOptions, RequestFocus, GlobalTaskInput, GlobalTaskPatch, PtySpawnOptions, SubtaskInput, TaskPatch } from '../shared/ipc'
import { shouldNotify } from '../shared/notifications'
import { describeEvent, answerNudge } from './notify'

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

let win: BrowserWindow | null = null
let projects: ProjectManager
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
      message: `${n} ${tasksWord(n)} в работе, агенты будут остановлены. Выйти?`,
      buttons: ['Выйти', 'Отмена'],
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

function tasksWord(n: number): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return 'задача'
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'задачи'
  return 'задач'
}

function ctx(projectId: string): WorkerEnvContext {
  return {
    socketPath: SOCKET_PATH,
    projectId,
    permissionMode: projects.get(projectId)?.permissionMode ?? 'auto',
    roles: projects.roles(projectId)
  }
}

/** Агенты с учётом настроек проекта; refresh — пересканировать PATH. */
function projectAgents(projectId: string, refresh = false): AgentInfo[] {
  return agentInfos(projects.get(projectId)?.enabledAgents, refresh)
}

function resolveProject(projectId?: string): { id: string; root: string; store: TaskStore } {
  const p = projectId ? projects.get(projectId) : projects.active()
  if (!p) throw new Error(projectId ? `project not found: ${projectId}` : 'нет проектов: добавьте репозиторий')
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

function runWorker(taskId: string, projectId?: string, cols?: number, rows?: number): ReturnType<typeof startWorker> {
  const p = resolveProject(projectId)
  // Роль могли удалить, а её агента — выключить в проекте после создания задачи.
  const task0 = p.store.getTask(taskId)
  if (task0) {
    if (p.store.columnKind(task0.status) === 'in_progress') throw new Error(`task already in progress: ${taskId}`)
    const role = projects.roles(p.id).find((r) => r.id === task0.roleId)
    if (!role) throw new Error(`роль ${task0.roleId} не найдена в проекте`)
    assertAgentUsable(projectAgents(p.id), role.agent)
    // Перезапуск: старый терминал задачи (если ещё жив) закрываем до запуска нового.
    closeTaskWorkers(p.store, taskId)
  }
  return startWorker(p.store, p.root, ctx(p.id), taskId, cols, rows)
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
  runId?: string
): string {
  const p = resolveProject(projectId)
  return startCoordinator(p.store, p.root, ctx(p.id), objective, cols, rows, images, runId).ptyId
}

/**
 * Удаление глобальной задачи (IPC и сокет): при живом координаторе — ошибка; store отвергает подзадачи
 * с живым dispatch и удаление с подзадачами без cascade. Оставшиеся терминалы подзадач (после `done`
 * dispatch закрыт, а PTY жив) закрываются после удаления.
 */
function removeGlobalTask(store: TaskStore, runId: string, cascade: boolean): { deleted: string; tasks: string[] } {
  const run = store.getRun(runId)
  if (run?.coordinatorPtyId && isAlive(run.coordinatorPtyId)) {
    throw new Error('координатор этой глобальной задачи ещё работает — сначала закрой его терминал')
  }
  const ptyIds = store.snapshot().dispatches.filter((d) => store.getTask(d.taskId)?.runId === runId && isAlive(d.ptyId)).map((d) => d.ptyId)
  const result = store.deleteGlobalTask(runId, { cascade })
  ptyIds.forEach((id) => killPty(id))
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
 */
function watchFinishedCoordinators(): void {
  setInterval(() => {
    for (const [, store] of projects.loadedStores()) {
      const snap = store.snapshot()
      const due = coordinatorsToClose({
        ...snap,
        isDone: (status) => store.columnKind(status) === 'done',
        lingers: (agent) => (agent ? getAgent(agent)?.lingersAfterAnswer === true : false),
        lastActivityAt,
        now: Date.now()
      })
      for (const { ptyId } of due) killPty(ptyId)
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
    const n = new Notification({ title: content.title, body: content.body, subtitle: column?.title, silent: !settings.sound })
    n.on('click', () => focusProject(projectId, content.requestId))
    n.show()
  }
}

/** Решение запроса к человеку (IPC и сокет): accept — с git-частью, clarify/restart — сразу старт воркера. */
function resolveRequest(projectId: string | undefined, id: string, resolution: RequestResolution): ReturnType<typeof resolveHumanRequest> {
  const p = resolveProject(projectId)
  const request = p.store.getRequest(id)
  if (request) syncWorkerLiveness(p.store, request.taskId)
  return resolveHumanRequest(p.store, p.root, id, resolution, (taskId) => runWorker(taskId, p.id))
}

/** Тестовое уведомление из настроек: показывается всегда, звук и превью — по настройкам. */
function testNotification(): void {
  if (!Notification.isSupported()) throw new Error('системные уведомления не поддерживаются')
  const s = projects.settings().notifications
  const body = s.showPreview ? 'Вопрос: так уведомления и будут выглядеть' : 'Вопрос'
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
  if (!task) throw new Error(`задача не в работе или без worktree: ${String(source)}`)
  return task.worktree
}

function registerIpc(): void {
  ipcMain.handle('app:getSettings', () => projects.settings())
  ipcMain.handle('app:setSettings', (_e, patch: AppSettingsPatch) => projects.setSettings(patch ?? {}))
  ipcMain.handle('app:testNotification', () => testNotification())
  ipcMain.handle('app:info', () => ({ socketPath: SOCKET_PATH, active: projects.active(), projects: projects.list() }))
  ipcMain.handle('projects:list', () => ({ active: projects.active(), projects: projects.list() }))
  ipcMain.handle('projects:inProgressCounts', () => projects.inProgressCounts())
  ipcMain.handle('projects:setActive', (_e, id: string) => projects.setActive(id))
  ipcMain.handle('projects:remove', (_e, id: string) => projects.remove(id))
  ipcMain.handle('projects:setPermissionMode', (_e, id: string, mode: PermissionMode) => projects.setPermissionMode(id, mode))
  ipcMain.handle('projects:setEnabledAgents', (_e, id: string, agents: AgentKind[]) => projects.setEnabledAgents(id, agents))
  ipcMain.handle('projects:setRoles', (_e, id: string, roles: Role[]) => projects.setRoles(id, roles))
  ipcMain.handle('projects:setColumns', (_e, id: string, columns: BoardColumn[]) => projects.setColumns(id, columns))
  ipcMain.handle('projects:getDefaults', () => projects.defaults())
  ipcMain.handle('projects:setDefaults', (_e, patch: Partial<ProjectDefaults>) => projects.setDefaults(patch ?? {}))
  ipcMain.handle('projects:applyDefaults', (_e, id: string) => projects.applyDefaults(id))
  ipcMain.handle('prompts:builtin', () => BUILTIN_PROMPTS)
  ipcMain.handle('agents:list', (_e, refresh?: boolean) => agentInfos(projects.active()?.enabledAgents, Boolean(refresh)))
  ipcMain.handle('projects:add', async () => {
    if (!win) throw new Error('no window')
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Выберите git-репозиторий' })
    if (res.canceled || !res.filePaths[0]) return null
    return projects.add(res.filePaths[0])
  })

  ipcMain.handle('board:get', () =>
    projects.active() ? projects.activeStore().snapshot() : { tasks: [], dispatches: [], events: [], questions: [], runs: [] }
  )
  ipcMain.handle('runs:list', () => (projects.active() ? projects.activeStore().listRuns() : []))
  ipcMain.handle('runs:close', (_e, runId: string) => projects.activeStore().closeRun(runId))
  ipcMain.handle('tasks:create', (_e, input: { title: string; spec?: string; deps?: string[]; roleId?: string }) => {
    const p = resolveProject()
    const role = pickRole(projects.roles(p.id), projectAgents(p.id), input.roleId)
    return p.store.createTask({ ...input, roleId: role.id, agent: role.agent })
  })
  ipcMain.handle('tasks:move', (_e, id: string, status: string) => projects.activeStore().moveTask(id, status))
  ipcMain.handle('tasks:update', (_e, id: string, patch: TaskPatch) => projects.activeStore().editTask(id, patch ?? {}))
  ipcMain.handle('tasks:remove', (_e, id: string) => projects.activeStore().deleteTask(id))

  // Глобальные задачи активного проекта (docs/nested-kanban.md). Изменения — в board:changed.
  ipcMain.handle('globalTasks:list', () => (projects.active() ? projects.activeStore().listGlobalTasks() : []))
  ipcMain.handle('globalTasks:get', (_e, id: string) => projects.activeStore().getGlobalTask(id))
  ipcMain.handle('globalTasks:create', (_e, input: GlobalTaskInput) => projects.activeStore().createGlobalTask(input ?? {}))
  ipcMain.handle('globalTasks:update', (_e, id: string, patch: GlobalTaskPatch) => projects.activeStore().updateGlobalTask(id, patch ?? {}))
  ipcMain.handle('globalTasks:move', (_e, id: string, status: string) => projects.activeStore().moveGlobalTask(id, status))
  ipcMain.handle('globalTasks:remove', (_e, id: string, opts?: { cascade?: boolean }) =>
    removeGlobalTask(projects.activeStore(), id, opts?.cascade === true)
  )
  ipcMain.handle('globalTasks:tasks', (_e, id: string) => projects.activeStore().listSubtasks(id))
  ipcMain.handle('globalTasks:createTask', (_e, id: string, input: SubtaskInput) => {
    if (!input?.title?.trim()) throw new Error('название подзадачи не может быть пустым')
    const p = resolveProject()
    const role = pickRole(projects.roles(p.id), projectAgents(p.id), input.roleId)
    return p.store.createTask({ ...input, roleId: role.id, agent: role.agent, runId: id })
  })
  ipcMain.handle('globalTasks:startCoordinator', (_e, id: string, cols: number, rows: number, images?: unknown) =>
    runCoordinator('', undefined, cols, rows, validateImageAttachments(images), id)
  )
  ipcMain.handle('questions:answer', (_e, id: string, answer: string) => answerQuestion(projects.activeStore(), id, answer))
  ipcMain.handle('requests:list', (_e, opts?: RequestListOptions) => {
    if (!projects.active()) return []
    const store = projects.activeStore()
    return store.listRequests().filter((r) => (!opts?.runId || r.runId === opts.runId) && (!opts?.pending || r.status === 'pending'))
  })
  ipcMain.handle('requests:resolve', (_e, id: string, resolution: RequestResolution) => resolveRequest(undefined, id, resolution))

  ipcMain.handle('pty:spawn', (_e, { label, projectId, ...opts }: PtySpawnOptions) => {
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
  ipcMain.handle('terminals:list', () => terminalSnapshots())

  ipcMain.handle('worker:start', (_e, taskId: string, cols: number, rows: number) => runWorker(taskId, undefined, cols, rows))
  ipcMain.handle('coordinator:start', (_e, objective: unknown, cols: number, rows: number, images?: unknown) => {
    // Данные из renderer не доверенные: изображения проверяются по сигнатуре и лимитам.
    const valid = validateImageAttachments(images)
    const text = typeof objective === 'string' ? objective.trim() : ''
    if (!text && valid.length === 0) throw new Error('цель не задана')
    return runCoordinator(text || DEFAULT_IMAGE_OBJECTIVE, undefined, cols, rows, valid)
  })
  ipcMain.handle('docs:list', () => {
    if (!projects.active()) return []
    const p = resolveProject()
    return listDocGroups(p.root, currentBranch(p.root), docTasks(p.store))
  })
  ipcMain.handle('docs:read', (_e, source: unknown, path: unknown) => readDoc(docRoot(source), path))
  ipcMain.handle('docs:open', async (_e, source: unknown, path: unknown) => {
    const err = await shell.openPath(resolveDocPath(docRoot(source), path))
    if (err) throw new Error(err)
  })
  ipcMain.handle('docs:reveal', (_e, source: unknown, path: unknown) => shell.showItemInFolder(resolveDocPath(docRoot(source), path)))
  ipcMain.handle('review:info', (_e, taskId: string) => {
    const p = resolveProject()
    return getReview(p.store, p.root, taskId)
  })
  ipcMain.handle('review:accept', (_e, taskId: string, decision?: string) => {
    const p = resolveProject()
    return acceptReview(p.store, p.root, taskId, decision)
  })
  ipcMain.handle('review:reject', (_e, taskId: string, feedback: string) => projects.activeStore().rejectReview(taskId, feedback))
}

app.whenReady().then(() => {
  app.setAppUserModelId('orca-board')
  projects = new ProjectManager(app.getPath('userData'))
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
    refreshTray()
  })
  projects.onEvents(notify)
  projects.onEvents(deliverAnswers)
  registerIpc()
  startSocketServer(SOCKET_PATH, {
    resolve: (projectId) => {
      const p = resolveProject(projectId)
      return {
        store: p.store,
        startWorker: (taskId) => runWorker(taskId, p.id),
        stopWorker: (taskId) => stopTaskWorker(p.store, taskId),
        review: (taskId) => getReview(p.store, p.root, taskId),
        accept: (taskId, decision) => acceptReview(p.store, p.root, taskId, decision),
        resolveRequest: (id, resolution) => resolveRequest(p.id, id, resolution),
        startCoordinator: (objective, runId) => runCoordinator(objective, p.id, undefined, undefined, [], runId),
        deleteGlobalTask: (runId, cascade) => removeGlobalTask(p.store, runId, cascade),
        agents: () => projectAgents(p.id),
        roles: () => projects.roles(p.id),
        columns: () => projects.columns(p.id)
      }
    }
  })
  watchStuck()
  watchFinishedCoordinators()
  createTray({ open: () => showWindow(), quit: () => void requestQuit(), activeCount: activeDispatchCount })
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
