import { app, BrowserWindow, ipcMain, shell, dialog, Notification } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { STATUS_TITLES, type TaskStore, type OrcaEvent } from '@orca-board/core'
import { spawnPty, writePty, resizePty, killPty, killAll, silentFor, isAlive } from './pty'
import { startWorker, startCoordinator, cliBinDir } from './worker'
import { getReview, acceptReview } from './review'
import { startSocketServer } from './socket'
import { ProjectManager } from './projects'
import type { PtySpawnOptions } from '../shared/ipc'

// Имя пакета скоупное (@orca-board/desktop) — задаём userData явно, чтобы путь был предсказуем.
app.setName('orca-board')
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

function ctx(projectId: string): { socketPath: string; projectId: string } {
  return { socketPath: SOCKET_PATH, projectId }
}

function resolveProject(projectId?: string): { id: string; root: string; store: TaskStore } {
  const p = projectId ? projects.get(projectId) : projects.active()
  if (!p) throw new Error(projectId ? `project not found: ${projectId}` : 'нет проектов: добавьте репозиторий')
  return { id: p.id, root: p.root, store: projects.store(p.id) }
}

function runWorker(taskId: string, projectId?: string, cols?: number, rows?: number): ReturnType<typeof startWorker> {
  if (!win) throw new Error('no window')
  const p = resolveProject(projectId)
  const res = startWorker(win, p.store, p.root, ctx(p.id), taskId, cols, rows)
  const task = p.store.getTask(taskId)
  win.webContents.send('worker:opened', { ptyId: res.ptyId, taskId, projectId: p.id, label: task?.title ?? taskId, role: 'worker' })
  return res
}

function runCoordinator(objective: string, projectId?: string, cols?: number, rows?: number): string {
  if (!win) throw new Error('no window')
  const p = resolveProject(projectId)
  const ptyId = startCoordinator(win, p.root, ctx(p.id), objective, cols, rows)
  win.webContents.send('worker:opened', { ptyId, projectId: p.id, label: 'координатор', role: 'coordinator' })
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
    const n = new Notification({ title, body: body.slice(0, 200), subtitle: task ? STATUS_TITLES[task.status] : undefined })
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
  ipcMain.handle('projects:add', async () => {
    if (!win) throw new Error('no window')
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Выберите git-репозиторий' })
    if (res.canceled || !res.filePaths[0]) return null
    return projects.add(res.filePaths[0])
  })

  ipcMain.handle('board:get', () =>
    projects.active() ? projects.activeStore().snapshot() : { tasks: [], dispatches: [], events: [], questions: [] }
  )
  ipcMain.handle('tasks:create', (_e, input) => projects.activeStore().createTask(input))
  ipcMain.handle('tasks:move', (_e, id: string, status) => projects.activeStore().moveTask(id, status))
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
          ORCA_SOCKET: SOCKET_PATH,
          ...(p ? { ORCA_PROJECT: p.id } : {}),
          PATH: `${cliBinDir()}:${process.env.PATH ?? ''}`,
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
        startCoordinator: (objective) => runCoordinator(objective, p.id)
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
