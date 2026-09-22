import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { TaskStore } from '@orca-board/core'
import { jsonPersistence } from './persistence'
import { spawnPty, writePty, resizePty, killPty, killAll } from './pty'
import { startWorker, cliBinDir } from './worker'
import { startSocketServer } from './socket'
import type { PtySpawnOptions } from '../shared/ipc'

let win: BrowserWindow | null = null
let store: TaskStore

// Пока репозиторий — папка, из которой запущено приложение. Позже — выбор в UI.
const REPO_ROOT = process.env.ORCA_REPO ?? process.cwd()
const SOCKET_PATH = process.env.ORCA_SOCKET ?? join(homedir(), '.orca-board', 'orca.sock')

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

function runWorker(taskId: string, cols?: number, rows?: number): ReturnType<typeof startWorker> {
  if (!win) throw new Error('no window')
  const res = startWorker(win, store, REPO_ROOT, { socketPath: SOCKET_PATH }, taskId, cols, rows)
  const task = store.getTask(taskId)
  win.webContents.send('worker:opened', { ptyId: res.ptyId, taskId, label: task?.title ?? taskId })
  return res
}

function registerIpc(): void {
  ipcMain.handle('app:info', () => ({ repoRoot: REPO_ROOT, repoName: basename(REPO_ROOT), socketPath: SOCKET_PATH }))
  ipcMain.handle('board:get', () => store.snapshot())
  ipcMain.handle('tasks:create', (_e, input) => store.createTask(input))
  ipcMain.handle('tasks:move', (_e, id: string, status) => store.moveTask(id, status))
  ipcMain.handle('tasks:remove', (_e, id: string) => store.deleteTask(id))
  ipcMain.handle('questions:answer', (_e, id: string, answer: string) => store.answer(id, answer))

  ipcMain.handle('pty:spawn', (_e, opts: PtySpawnOptions) => {
    if (!win) throw new Error('no window')
    return spawnPty(
      win,
      { ...opts, env: { ORCA_SOCKET: SOCKET_PATH, PATH: `${cliBinDir()}:${process.env.PATH ?? ''}`, ...(opts.env ?? {}) } },
      (id, code) => store.ptyExited(id, code)
    )
  })
  ipcMain.on('pty:write', (_e, id: string, data: string) => writePty(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => resizePty(id, cols, rows))
  ipcMain.on('pty:kill', (_e, id: string) => killPty(id))

  ipcMain.handle('worker:start', (_e, taskId: string, cols: number, rows: number) => runWorker(taskId, cols, rows))
}

app.whenReady().then(() => {
  store = new TaskStore(jsonPersistence(join(app.getPath('userData'), 'board.json')))
  store.subscribe(() => {
    if (win && !win.isDestroyed()) win.webContents.send('board:changed', store.snapshot())
  })
  registerIpc()
  startSocketServer(SOCKET_PATH, { store, startWorker: (taskId) => runWorker(taskId) })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  killAll()
  app.quit()
})
