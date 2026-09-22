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
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    add: () => ipcRenderer.invoke('projects:add'),
    remove: (id) => ipcRenderer.invoke('projects:remove', id),
    setActive: (id) => ipcRenderer.invoke('projects:setActive', id),
    setPermissionMode: (id, mode) => ipcRenderer.invoke('projects:setPermissionMode', id, mode),
    onFocus: (cb) => on('projects:focus', cb)
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
  },
  coordinator: {
    start: (objective, cols, rows) => ipcRenderer.invoke('coordinator:start', objective, cols, rows)
  },
  review: {
    info: (taskId) => ipcRenderer.invoke('review:info', taskId),
    accept: (taskId) => ipcRenderer.invoke('review:accept', taskId),
    reject: (taskId, feedback) => ipcRenderer.invoke('review:reject', taskId, feedback)
  }
}

contextBridge.exposeInMainWorld('orca', api)
