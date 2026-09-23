import { contextBridge, ipcRenderer } from 'electron'
import type { OrcaApi } from '../shared/ipc'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: OrcaApi = {
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    getSettings: () => ipcRenderer.invoke('app:getSettings'),
    setSettings: (patch) => ipcRenderer.invoke('app:setSettings', patch),
    testNotification: () => ipcRenderer.invoke('app:testNotification')
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    inProgressCounts: () => ipcRenderer.invoke('projects:inProgressCounts'),
    add: (typeId, path) => ipcRenderer.invoke('projects:add', typeId, path),
    detectTaskType: (path) => ipcRenderer.invoke('projects:detectTaskType', path),
    setTaskTypes: (id, input) => ipcRenderer.invoke('projects:setTaskTypes', id, input),
    remove: (id) => ipcRenderer.invoke('projects:remove', id),
    setActive: (id) => ipcRenderer.invoke('projects:setActive', id),
    setEnabledAgents: (id, agents) => ipcRenderer.invoke('projects:setEnabledAgents', id, agents),
    setColumns: (id, columns) => ipcRenderer.invoke('projects:setColumns', id, columns),
    onFocus: (cb) => on('projects:focus', cb)
  },
  taskTypes: {
    list: () => ipcRenderer.invoke('taskTypes:list'),
    save: (input) => ipcRenderer.invoke('taskTypes:save', input),
    delete: (id) => ipcRenderer.invoke('taskTypes:delete', id),
    duplicate: (id) => ipcRenderer.invoke('taskTypes:duplicate', id),
    setDefault: (id) => ipcRenderer.invoke('taskTypes:setDefault', id)
  },
  agents: {
    list: (refresh) => ipcRenderer.invoke('agents:list', refresh)
  },
  prompts: {
    builtin: () => ipcRenderer.invoke('prompts:builtin')
  },
  board: {
    get: () => ipcRenderer.invoke('board:get'),
    onChange: (cb) => on('board:changed', cb)
  },
  runs: {
    list: () => ipcRenderer.invoke('runs:list'),
    close: (id) => ipcRenderer.invoke('runs:close', id)
  },
  globalTasks: {
    list: () => ipcRenderer.invoke('globalTasks:list'),
    get: (id) => ipcRenderer.invoke('globalTasks:get', id),
    create: (input) => ipcRenderer.invoke('globalTasks:create', input),
    update: (id, patch) => ipcRenderer.invoke('globalTasks:update', id, patch),
    move: (id, status) => ipcRenderer.invoke('globalTasks:move', id, status),
    remove: (id, opts) => ipcRenderer.invoke('globalTasks:remove', id, opts),
    tasks: (id) => ipcRenderer.invoke('globalTasks:tasks', id),
    createTask: (id, input) => ipcRenderer.invoke('globalTasks:createTask', id, input),
    startCoordinator: (id, cols, rows, images) => ipcRenderer.invoke('globalTasks:startCoordinator', id, cols, rows, images),
    accept: (id) => ipcRenderer.invoke('globalTasks:accept', id),
    returnToWork: (id, text, cols, rows) => ipcRenderer.invoke('globalTasks:returnToWork', id, text, cols, rows)
  },
  tasks: {
    create: (input) => ipcRenderer.invoke('tasks:create', input),
    move: (id, status) => ipcRenderer.invoke('tasks:move', id, status),
    update: (id, patch) => ipcRenderer.invoke('tasks:update', id, patch),
    remove: (id) => ipcRenderer.invoke('tasks:remove', id)
  },
  questions: {
    answer: (id, answer) => ipcRenderer.invoke('questions:answer', id, answer)
  },
  requests: {
    list: (opts) => ipcRenderer.invoke('requests:list', opts),
    resolve: (id, resolution) => ipcRenderer.invoke('requests:resolve', id, resolution),
    onFocus: (cb) => on('requests:focus', cb)
  },
  pty: {
    spawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
    write: (id, data) => ipcRenderer.send('pty:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id) => ipcRenderer.send('pty:kill', id),
    onData: (id, cb) => on(`pty:data:${id}`, cb),
    onExit: (id, cb) => on(`pty:exit:${id}`, cb)
  },
  terminals: {
    list: () => ipcRenderer.invoke('terminals:list'),
    onChanged: (cb) => on('terminals:changed', cb)
  },
  worker: {
    start: (taskId, cols, rows) => ipcRenderer.invoke('worker:start', taskId, cols, rows)
  },
  coordinator: {
    start: (objective, cols, rows, images) => ipcRenderer.invoke('coordinator:start', objective, cols, rows, images)
  },
  assistant: {
    open: (cols, rows) => ipcRenderer.invoke('assistant:open', cols, rows),
    reset: (cols, rows) => ipcRenderer.invoke('assistant:reset', cols, rows)
  },
  docs: {
    list: () => ipcRenderer.invoke('docs:list'),
    read: (source, path) => ipcRenderer.invoke('docs:read', source, path),
    open: (source, path) => ipcRenderer.invoke('docs:open', source, path),
    reveal: (source, path) => ipcRenderer.invoke('docs:reveal', source, path)
  },
  rules: {
    list: () => ipcRenderer.invoke('rules:list'),
    save: (name, text) => ipcRenderer.invoke('rules:save', name, text)
  },
  review: {
    info: (taskId) => ipcRenderer.invoke('review:info', taskId),
    accept: (taskId, decision) => ipcRenderer.invoke('review:accept', taskId, decision),
    reject: (taskId, feedback) => ipcRenderer.invoke('review:reject', taskId, feedback)
  }
}

contextBridge.exposeInMainWorld('orca', api)
