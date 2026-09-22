import { contextBridge, ipcRenderer } from 'electron'
import type { OrcaApi } from '../shared/ipc'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: OrcaApi = {
  app: {
    info: () => ipcRenderer.invoke('app:info')
  },
  board: {
    get: () => ipcRenderer.invoke('board:get'),
    onChange: (cb) => on('board:changed', cb)
  },
  tasks: {
    create: (input) => ipcRenderer.invoke('tasks:create', input),
    move: (id, status) => ipcRenderer.invoke('tasks:move', id, status),
    remove: (id) => ipcRenderer.invoke('tasks:remove', id)
  },
  questions: {
    answer: (id, answer) => ipcRenderer.invoke('questions:answer', id, answer)
  },
  pty: {
    spawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
    write: (id, data) => ipcRenderer.send('pty:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id) => ipcRenderer.send('pty:kill', id),
    onData: (id, cb) => on(`pty:data:${id}`, cb),
    onExit: (id, cb) => on(`pty:exit:${id}`, cb)
  },
  worker: {
    start: (taskId, cols, rows) => ipcRenderer.invoke('worker:start', taskId, cols, rows),
    onOpened: (cb) => on('worker:opened', cb)
  }
}

contextBridge.exposeInMainWorld('orca', api)
