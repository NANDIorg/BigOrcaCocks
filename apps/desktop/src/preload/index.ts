import { contextBridge, ipcRenderer } from 'electron'
import type { OrcaApi } from '../shared/ipc'

const api: OrcaApi = {
  app: {
    info: () => ipcRenderer.invoke('app:info')
  },
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    create: (input) => ipcRenderer.invoke('tasks:create', input),
    move: (id, status) => ipcRenderer.invoke('tasks:move', id, status),
    remove: (id) => ipcRenderer.invoke('tasks:remove', id),
    onChange: (cb) => {
      const handler = (_e: unknown, tasks: Parameters<typeof cb>[0]): void => cb(tasks)
      ipcRenderer.on('tasks:changed', handler)
      return () => ipcRenderer.removeListener('tasks:changed', handler)
    }
  },
  events: {
    list: () => ipcRenderer.invoke('events:list')
  },
  pty: {
    spawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
    write: (id, data) => ipcRenderer.send('pty:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id) => ipcRenderer.send('pty:kill', id),
    onData: (id, cb) => {
      const channel = `pty:data:${id}`
      const handler = (_e: unknown, data: string): void => cb(data)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
    onExit: (id, cb) => {
      const channel = `pty:exit:${id}`
      const handler = (_e: unknown, code: number): void => cb(code)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    }
  },
  worker: {
    start: (taskId, cols, rows) => ipcRenderer.invoke('worker:start', taskId, cols, rows)
  }
}

contextBridge.exposeInMainWorld('orca', api)
