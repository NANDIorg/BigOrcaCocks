import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join, basename } from 'node:path'
import { TaskStore } from '@orca-board/core'
import { jsonPersistence } from './persistence'
import { spawnPty, writePty, resizePty, killPty, killAll } from './pty'
import { startWorker } from './worker'
import type { PtySpawnOptions } from '../shared/ipc'

let win: BrowserWindow | null = null
let store: TaskStore

// Пока репозиторий — папка, из которой запущено приложение. Позже — выбор в UI.
const REPO_ROOT = process.env.ORCA_REPO ?? process.cwd()

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'orca-board',
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

function registerIpc(): void {
  ipcMain.handle('app:info', () => ({ repoRoot: REPO_ROOT, repoName: basename(REPO_ROOT) }))
  ipcMain.handle('tasks:list', () => store.listTasks())
  ipcMain.handle('tasks:create', (_e, input) => store.createTask(input))
  ipcMain.handle('tasks:move', (_e, id: string, status) => store.moveTask(id, status))
  ipcMain.handle('tasks:remove', (_e, id: string) => store.deleteTask(id))
  ipcMain.handle('events:list', () => store.listEvents())

  ipcMain.handle('pty:spawn', (_e, opts: PtySpawnOptions) => {
    if (!win) throw new Error('no window')
    return spawnPty(win, opts, (id, code) => store.ptyExited(id, code))
  })
  ipcMain.on('pty:write', (_e, id: string, data: string) => writePty(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => resizePty(id, cols, rows))
  ipcMain.on('pty:kill', (_e, id: string) => killPty(id))

  ipcMain.handle('worker:start', (_e, taskId: string, cols: number, rows: number) => {
    if (!win) throw new Error('no window')
    return startWorker(win, store, REPO_ROOT, taskId, cols, rows)
  })
}

app.whenReady().then(() => {
  store = new TaskStore(jsonPersistence(join(app.getPath('userData'), 'board.json')))
  store.subscribe(() => {
    if (win && !win.isDestroyed()) win.webContents.send('tasks:changed', store.listTasks())
  })
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  killAll()
  app.quit()
})
