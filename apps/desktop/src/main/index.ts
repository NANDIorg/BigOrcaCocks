import { app, BrowserWindow, ipcMain, shell, dialog, Notification } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { type TaskStore, type OrcaEvent, type AgentKind, type AgentInfo, type Role, type BoardColumn } from '@orca-board/core'
import { spawnPty, writePty, resizePty, killPty, killAll, silentFor, isAlive } from './pty'
import { startWorker, startCoordinator, workerPath, type WorkerEnvContext } from './worker'
import { getReview, acceptReview } from './review'
import { startSocketServer } from './socket'
import { ProjectManager, type PermissionMode, type ProjectDefaults } from './projects'
import { agentInfos, assertAgentUsable, pickRole } from './agents'
import type { PtySpawnOptions, TaskPatch } from '../shared/ipc'

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

const SOCKET_PATH = process.env.ORCA_SOCKET ?? join(homedir(), '.orca-board', 'orca.sock')
const STUCK_MS = Number(process.env.ORCA_STUCK_MINUTES ?? 10) * 60_000

function createWindow(): void {
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
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
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
 * примет kill за падение), PTY убиваются, renderer получает worker:closed. PTY координатора
 * не привязан к dispatch и сюда не попадает.
 */
function closeTaskWorkers(projectId: string, store: TaskStore, taskId: string): void {
  const ptyIds = new Set<string>()
  for (const d of store.closeDispatches(taskId)) ptyIds.add(d.ptyId)
  // Старые dispatch'и уже закрыты (например, после `orca-board done`), но их PTY может жить до сих пор.
  for (const d of store.snapshot().dispatches) if (d.taskId === taskId && isAlive(d.ptyId)) ptyIds.add(d.ptyId)
  for (const ptyId of ptyIds) {
    if (isAlive(ptyId)) killPty(ptyId)
    if (win && !win.isDestroyed()) win.webContents.send('worker:closed', { ptyId, taskId, projectId })
  }
}

/**
 * Задача попала в колонку kind=done — её воркерам больше нечего делать. Смотрим не только
 * незакрытые dispatch'и, но и живые PTY уже закрытых: после `orca-board done` dispatch завершён,
 * а терминал агента ещё открыт до самого review accept.
 */
function closeDoneWorkers(projectId: string, store: TaskStore): void {
  const doneTasks = new Set<string>()
  for (const d of store.snapshot().dispatches) {
    if (d.endedAt && !isAlive(d.ptyId)) continue
    const task = store.getTask(d.taskId)
    if (task && store.columnKind(task.status) === 'done') doneTasks.add(task.id)
  }
  for (const taskId of doneTasks) closeTaskWorkers(projectId, store, taskId)
}

function runWorker(taskId: string, projectId?: string, cols?: number, rows?: number): ReturnType<typeof startWorker> {
  if (!win) throw new Error('no window')
  const p = resolveProject(projectId)
  // Роль могли удалить, а её агента — выключить в проекте после создания задачи.
  const task0 = p.store.getTask(taskId)
  if (task0) {
    if (p.store.columnKind(task0.status) === 'in_progress') throw new Error(`task already in progress: ${taskId}`)
    const role = projects.roles(p.id).find((r) => r.id === task0.roleId)
    if (!role) throw new Error(`роль ${task0.roleId} не найдена в проекте`)
    assertAgentUsable(projectAgents(p.id), role.agent)
    // Перезапуск: старый терминал задачи (если ещё жив) закрываем до запуска нового.
    closeTaskWorkers(p.id, p.store, taskId)
  }
  const res = startWorker(win, p.store, p.root, ctx(p.id), taskId, cols, rows)
  const task = p.store.getTask(taskId)
  win.webContents.send('worker:opened', { ptyId: res.ptyId, taskId, projectId: p.id, label: task?.title ?? taskId, role: 'worker' })
  return res
}

function runCoordinator(objective: string, projectId?: string, cols?: number, rows?: number): string {
  if (!win) throw new Error('no window')
  const p = resolveProject(projectId)
  const { ptyId, runId } = startCoordinator(win, p.store, p.root, ctx(p.id), objective, cols, rows)
  win.webContents.send('worker:opened', { ptyId, projectId: p.id, label: 'координатор', role: 'coordinator', runId })
  return ptyId
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

/** Системные уведомления на события, требующие человека. */
function notify(projectId: string, events: OrcaEvent[]): void {
  if (!Notification.isSupported()) return
  const project = projects.get(projectId)
  const store = projects.store(projectId)
  for (const e of events) {
    const task = e.taskId ? store.getTask(e.taskId) : undefined
    const title = task ? `${task.title} · ${project?.name ?? ''}` : project?.name ?? 'orca-board'
    let body: string | null = null
    if (e.type === 'question') body = `Вопрос: ${String(e.payload.question ?? '')}`
    if (e.type === 'escalation') body = `Эскалация: ${String(e.payload.reason ?? '')}`
    if (e.type === 'worker_done') body = `Готово к ревью${e.payload.summary ? `: ${String(e.payload.summary)}` : ''}`
    if (!body) continue
    const column = task ? projects.columns(projectId).find((c) => c.id === task.status) : undefined
    const n = new Notification({ title, body: body.slice(0, 200), subtitle: column?.title })
    n.on('click', () => {
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.focus()
      win.webContents.send('projects:focus', projectId)
    })
    n.show()
  }
}

function registerIpc(): void {
  ipcMain.handle('app:info', () => ({ socketPath: SOCKET_PATH, active: projects.active(), projects: projects.list() }))
  ipcMain.handle('projects:list', () => ({ active: projects.active(), projects: projects.list() }))
  ipcMain.handle('projects:setActive', (_e, id: string) => projects.setActive(id))
  ipcMain.handle('projects:remove', (_e, id: string) => projects.remove(id))
  ipcMain.handle('projects:setPermissionMode', (_e, id: string, mode: PermissionMode) => projects.setPermissionMode(id, mode))
  ipcMain.handle('projects:setEnabledAgents', (_e, id: string, agents: AgentKind[]) => projects.setEnabledAgents(id, agents))
  ipcMain.handle('projects:setRoles', (_e, id: string, roles: Role[]) => projects.setRoles(id, roles))
  ipcMain.handle('projects:setColumns', (_e, id: string, columns: BoardColumn[]) => projects.setColumns(id, columns))
  ipcMain.handle('projects:getDefaults', () => projects.defaults())
  ipcMain.handle('projects:setDefaults', (_e, patch: Partial<ProjectDefaults>) => projects.setDefaults(patch ?? {}))
  ipcMain.handle('projects:applyDefaults', (_e, id: string) => projects.applyDefaults(id))
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
  ipcMain.handle('questions:answer', (_e, id: string, answer: string) => projects.activeStore().answer(id, answer))

  ipcMain.handle('pty:spawn', (_e, opts: PtySpawnOptions) => {
    if (!win) throw new Error('no window')
    const p = projects.active()
    return spawnPty(
      win,
      {
        ...opts,
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

  ipcMain.handle('worker:start', (_e, taskId: string, cols: number, rows: number) => runWorker(taskId, undefined, cols, rows))
  ipcMain.handle('coordinator:start', (_e, objective: string, cols: number, rows: number) => runCoordinator(objective, undefined, cols, rows))
  ipcMain.handle('review:info', (_e, taskId: string) => {
    const p = resolveProject()
    return getReview(p.store, p.root, taskId)
  })
  ipcMain.handle('review:accept', (_e, taskId: string) => {
    const p = resolveProject()
    return acceptReview(p.store, p.root, taskId)
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
    closeDoneWorkers(projectId, store)
  })
  projects.onEvents(notify)
  registerIpc()
  startSocketServer(SOCKET_PATH, {
    resolve: (projectId) => {
      const p = resolveProject(projectId)
      return {
        store: p.store,
        startWorker: (taskId) => runWorker(taskId, p.id),
        review: (taskId) => getReview(p.store, p.root, taskId),
        accept: (taskId) => acceptReview(p.store, p.root, taskId),
        startCoordinator: (objective) => runCoordinator(objective, p.id),
        agents: () => projectAgents(p.id),
        roles: () => projects.roles(p.id),
        columns: () => projects.columns(p.id)
      }
    }
  })
  watchStuck()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  killAll()
  app.quit()
})
