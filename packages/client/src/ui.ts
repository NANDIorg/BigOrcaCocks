import { ATTACHMENT_LIMITS, type StoreSnapshot } from '@orca-board/core'
import { showcaseServedMime, type OperatorCommands, type OperatorArgs, type OperatorResult, type AssistantChatSnapshot, type DialogSnapshot, type RuntimeSettings, type Project, type TerminalInfo, type TerminalSnapshot, type WriterLease, type ObserverEvent } from '@orca-board/contracts'
import { OrcaClientError, type OrcaClient } from './client.ts'
import type { LegacyUiClient } from './platform.ts'
import type { AppSettings } from './desktop-settings.ts'

interface UiSnapshot { revision: number; projects: { projects: Project[] }; board: StoreSnapshot | null; terminals: TerminalSnapshot[] }
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function chat(snapshot: DialogSnapshot): AssistantChatSnapshot {
  return { ...snapshot.dialog.conversation, ptyId: snapshot.dialog.id, protocolVersion: 2, revision: snapshot.dialog.revision,
    transport: 'chat', readOnly: snapshot.readOnly, requiresNewConversation: snapshot.requiresNewConversation, storageFailed: snapshot.storageFailed }
}
/** Один compatibility adapter для общего UI. Бизнес-команды и права остаются у owner. */
export function createTypedUiClient(operator: OrcaClient, options: { onError(error: unknown): void; onLanguage?(language: 'ru' | 'en'): void }) {
  const boardListeners = new Set<Parameters<LegacyUiClient['board']['onChange']>[0]>()
  const profileListeners = new Set<() => void>(); const terminalListeners = new Set<(list: TerminalInfo[]) => void>()
  const savedListeners = new Set<Parameters<LegacyUiClient['workflowAssistant']['onSaved']>[0]>()
  const leases = new Map<string, WriterLease>(); const claiming = new Map<string, Promise<WriterLease>>()
  const writerListeners = new Map<string, Set<(writable: boolean) => void>>()
  const resyncListeners = new Map<string, Set<(tail: string) => void>>()
  const chatResync = new Set<() => void>()
  const terminalAssistants = new Map<string, 'amp' | 'shell'>()
  const writable = (id: string, value: boolean) => { for (const listener of writerListeners.get(id) ?? []) listener(value) }
  let assistantId: string | undefined; let refreshed: Promise<void> | undefined; let dirty = false; let disposed = false
  const snapshot = (): UiSnapshot => {
    const value = operator.state.snapshot
    if (!object(value) || typeof value.revision !== 'number') throw new OrcaClientError('protocol.invalidReply')
    return value as unknown as UiSnapshot
  }
  const projectId = () => { const id = operator.state.selection.projectId; if (!id) throw new OrcaClientError('command.projectNotFound'); return id }
  function settings(value: RuntimeSettings): AppSettings {
    return { ...value, language: operator.state.language, keepInBackground: true, updates: { autoCheck: false, autoDownload: false, installWhenIdle: false } }
  }
  async function call<G extends keyof OperatorCommands, M extends keyof OperatorCommands[G] & string>(group: G, method: M,
    args: OperatorArgs<OperatorCommands[G][M]>, mutation = false, project?: string): Promise<OperatorResult<OperatorCommands[G][M]>> {
    await operator.connect()
    // Revision берётся перед действием, а request identity сохраняется общим клиентом при retry.
    if (mutation) await operator.refresh()
    const revision = mutation && group === 'dialog' && method !== 'create' && method !== 'list'
      ? (await operator.call('dialog', 'snapshot', [String(args[0])])).dialog.revision : mutation ? snapshot().revision : undefined
    const result = await operator.call(group, method, args, { projectId: project, ...(mutation ? { revision } : {}) })
    if (mutation) await refresh()
    return result
  }
  async function refresh(): Promise<void> {
    dirty = true
    if (refreshed) return refreshed
    refreshed = (async () => {
      while (dirty && !disposed) {
        dirty = false; await operator.refresh()
        const value = snapshot(); const id = operator.state.selection.projectId
        if (id && value.board) for (const listener of boardListeners) listener({ projectId: id, snapshot: value.board })
        for (const listener of profileListeners) listener()
        for (const listener of terminalListeners) listener(value.terminals)
      }
    })().finally(() => { refreshed = undefined })
    return refreshed
  }
  const listen = <T>(set: Set<T>, listener: T) => { set.add(listener); return () => { set.delete(listener) } }
  const report = (job: Promise<unknown>) => { void job.catch(error => { if (!disposed) options.onError(error) }) }
  const observe = (topic: string, listener: (payload: Record<string, unknown>, event: ObserverEvent) => void) => operator.observe(event => {
    if (event.topic === topic && object(event.payload)) listener(event.payload, event)
  })
  const offEvents = operator.observe(event => { if (['board.changed', 'profile.changed'].includes(event.topic)) report(refresh()) })
  const offTerminals = observe('session.changed', payload => { if (Array.isArray(payload.terminals)) for (const listener of terminalListeners) listener(payload.terminals as TerminalInfo[]) })
  const offSaved = observe('workflow.saved', payload => { if (typeof payload.typeId === 'string' && typeof payload.title === 'string' && typeof payload.revision === 'string') for (const listener of savedListeners) listener({ typeId: payload.typeId, title: payload.title, revision: payload.revision }) })
  let lastRevision = -1; let lastProject: string | undefined; let lastEpoch: string | undefined
  const offReset = operator.onSnapshotReset(() => {
    const value = snapshot()
    for (const terminal of value.terminals) for (const listener of resyncListeners.get(terminal.ptyId) ?? []) listener(terminal.tail)
    for (const listener of terminalListeners) listener(value.terminals)
    if (value.board && operator.state.selection.projectId) for (const listener of boardListeners) listener({ projectId: operator.state.selection.projectId, snapshot: value.board })
    for (const listener of chatResync) listener()
  })
  const offState = operator.subscribe(state => {
    if (state.phase !== 'connected') { for (const [id, lease] of leases) { writable(id, false); operator.forgetWriter(lease.id) } leases.clear(); return }
    if (!state.snapshot) return
    const value = snapshot()
    if (lastRevision === value.revision && lastProject === state.selection.projectId && lastEpoch === state.cursor?.epoch) return
    lastRevision = value.revision; lastProject = state.selection.projectId; lastEpoch = state.cursor?.epoch
    if (value.board && state.selection.projectId) for (const listener of boardListeners) listener({ projectId: state.selection.projectId, snapshot: value.board })
    for (const listener of profileListeners) listener()
  })
  async function writer(id: string): Promise<WriterLease> {
    const current = leases.get(id)
    if (current && current.expiresAt > Date.now() + 5000) return current
    const pending = claiming.get(id); if (pending) return pending
    if (!current) throw new OrcaClientError('protocol.writerRequired')
    const job = call('session', 'renewWriter', [id, current.id])
      .then(lease => { leases.set(id, lease); return lease }).finally(() => claiming.delete(id))
    claiming.set(id, job); return job
  }
  const heartbeat = setInterval(() => { for (const [id, lease] of leases) report(call('session', 'renewWriter', [id, lease.id]).then(value => leases.set(id, value)).catch(error => { leases.delete(id); writable(id, false); throw error })) }, 10_000)
  async function openAssistant(cols: number, rows: number, reset = false) {
    if (!reset && assistantId) return { ptyId: assistantId }
    if (reset && assistantId) {
      const terminals = await call('session', 'list', [])
      if (terminals.some(item => item.ptyId === assistantId)) await call('session', 'kill', [assistantId], true)
      else await call('dialog', 'stop', [assistantId], true)
    }
    const value = await call('profile', 'settings', [])
    if (value.assistant.agent === 'amp' || value.assistant.agent === 'shell') {
      assistantId = await call('resources', 'assistantTerminal', [cols, rows], true)
      terminalAssistants.set(assistantId, value.assistant.agent)
      await operator.select({ projectId: operator.state.selection.projectId })
    }
    else {
      const previous = !reset ? (await call('dialog', 'list', [operator.state.selection.projectId])).at(-1) : undefined
      assistantId = previous?.id ?? await call('dialog', 'create', [{ projectId: operator.state.selection.projectId }], true)
      await operator.select({ ...operator.state.selection, dialogId: assistantId })
    }
    return { ptyId: assistantId }
  }
  const client: LegacyUiClient = {
    app: {
      environment: 'web',
      info: async () => { const value = await client.projects.list(); return { socketPath: '', ...value } },
      getSettings: async () => settings(await call('profile', 'settings', [])),
      setSettings: async patch => {
        const { language, updates: _updates, keepInBackground: _background, ...common } = patch
        if (language) { operator.setLanguage(language); options.onLanguage?.(language) }
        return settings(Object.keys(common).length ? await call('profile', 'setSettings', [common], true) : await call('profile', 'settings', []))
      },
      onChanged: cb => listen(profileListeners, cb)
    },
    onboarding: { getState: () => call('profile', 'onboardingState', []), complete: input => call('profile', 'completeOnboarding', [input], true) },
    projects: {
      list: async () => {
        const value = await call('profile', 'listProjects', [])
        const selected = operator.state.selection.projectId
        if (!selected && value.projects.length) await operator.select({ ...operator.state.selection, projectId: value.projects[0].id })
        return { ...value, active: value.projects.find(project => project.id === operator.state.selection.projectId) ?? null }
      },
      inProgressCounts: () => call('profile', 'inProgressCounts', []),
      branch: id => call('projectGit', 'branch', [], false, id), branches: id => call('projectGit', 'branches', [], false, id),
      gitFetch: id => call('projectGit', 'fetch', [], true, id), gitPull: id => call('projectGit', 'pull', [], true, id),
      checkoutBranch: (id, branch) => call('projectGit', 'checkout', [branch], true, id), createInitialCommit: (id, mode) => call('projectGit', 'initialCommit', [mode], true, id),
      setTaskTypes: (id, input) => call('projectConfig', 'setTaskTypes', [input], true, id),
      remove: id => call('profile', 'removeProject', [id], true),
      setActive: async id => { await operator.select({ projectId: id }); const value = await client.projects.list(); if (!value.active) throw new OrcaClientError('command.projectNotFound'); return value.active },
      setEnabledAgents: (id, agents) => call('projectConfig', 'setEnabledAgents', [agents], true, id), setColumns: (id, columns) => call('projectConfig', 'setColumns', [columns], true, id),
      createGroup: name => call('profile', 'createGroup', [name], true), renameGroup: (id, name) => call('profile', 'renameGroup', [id, name], true), removeGroup: id => call('profile', 'removeGroup', [id], true),
      setGroupCollapsed: (id, collapsed) => call('profile', 'setGroupCollapsed', [id, collapsed], true), setProjectGroup: (id, group) => call('projectConfig', 'setGroup', [group], true, id), reorderGroups: ids => call('profile', 'reorderGroups', [ids], true)
    },
    taskTypes: {
      list: () => call('profile', 'taskTypes', []), save: input => call('profile', 'saveTaskType', [input], true), patch: (id, patch) => call('profile', 'patchTaskType', [id, patch], true), rename: (id, title, description) => call('profile', 'renameTaskType', [id, title, description], true),
      delete: id => call('profile', 'deleteTaskType', [id], true), duplicate: id => call('profile', 'duplicateTaskType', [id], true), setDefault: id => call('profile', 'setDefaultTaskType', [id], true)
    },
    nodeTemplates: { list: () => call('profile', 'nodeTemplates', []), save: input => call('profile', 'saveNodeTemplate', [input], true), delete: id => call('profile', 'deleteNodeTemplate', [id], true) },
    agents: { list: refresh => call('agent', 'list', [operator.state.selection.projectId, refresh]) }, prompts: { builtin: () => call('resources', 'builtinPrompts', []) },
    board: { get: async () => {
      const value = await call('board', 'get', [], false, projectId())
      if (typeof value.formatVersion !== 'number') throw new OrcaClientError('protocol.invalidReply')
      return value as StoreSnapshot
    }, onChange: cb => listen(boardListeners, cb) },
    runs: { list: () => call('run', 'list', [], false, projectId()), close: id => call('run', 'close', [id], true, projectId()) },
    globalTasks: {
      list: () => call('globalTask', 'list', [], false, projectId()), get: id => call('globalTask', 'get', [id], false, projectId()), create: (input, images) => call('globalTask', 'create', [input, images], true, projectId()), update: (id, patch) => call('globalTask', 'update', [id, patch], true, projectId()),
      changeType: (id, type) => call('globalTask', 'changeType', [id, type], true, projectId()), addImages: (id, images) => call('globalTask', 'addImages', [id, images], true, projectId()), removeImage: (id, image) => call('globalTask', 'removeImage', [id, image], true, projectId()),
      image: async (id, imageId) => { const task = await client.globalTasks.get(id); return { mime: task.images?.find(image => image.id === imageId)?.mime ?? 'application/octet-stream', data: await operator.binary({ projectId: projectId(), kind: 'image', id, imageId }) } },
      move: (id, status) => call('globalTask', 'move', [id, status], true, projectId()), remove: (id, opts) => call('globalTask', 'remove', [id, opts], true, projectId()), tasks: id => call('globalTask', 'tasks', [id], false, projectId()), createTask: (id, input) => call('globalTask', 'createTask', [id, input], true, projectId()),
      startCoordinator: async (id, cols, rows, images) => (await call('coordinator', 'startCoordinator', [id, { cols, rows, images }], true, projectId())).ptyId,
      accept: (id, text) => call('coordinator', 'accept', [id, text], true, projectId()), returnToWork: async (id, text, cols, rows, images) => (await call('coordinator', 'returnToWork', [id, { text, cols, rows, images }], true, projectId())).ptyId
    },
    tasks: { create: input => call('board', 'createTask', [input], true, projectId()), move: (id, status) => call('board', 'moveTask', [id, status], true, projectId()), update: (id, patch) => call('board', 'updateTask', [id, patch], true, projectId()), remove: id => call('board', 'removeTask', [id], true, projectId()) },
    questions: { answer: async (id, answer) => { await call('humanRequest', 'answer', [id, answer], true, projectId()) } },
    requests: { list: opts => call('humanRequest', 'list', [opts], false, projectId()), resolve: (id, resolution, images) => call('humanRequest', 'resolve', [id, resolution, images], true, projectId()) },
    pty: {
      claimWriter: async id => { const lease = await call('session', 'claimWriter', [id], true); leases.set(id, lease); writable(id, true) },
      releaseWriter: async id => { const lease = leases.get(id); leases.delete(id); writable(id, false); if (lease) { operator.forgetWriter(lease.id); await call('session', 'releaseWriter', [id, lease.id], true) } },
      onWriterState: (id, cb) => { let listeners = writerListeners.get(id); if (!listeners) { listeners = new Set(); writerListeners.set(id, listeners) } listeners.add(cb); cb(leases.has(id)); return () => { listeners!.delete(cb); if (!listeners!.size) { writerListeners.delete(id); report(client.pty.releaseWriter!(id)) } } },
      onResync: (id, cb) => { let listeners = resyncListeners.get(id); if (!listeners) { listeners = new Set(); resyncListeners.set(id, listeners) } listeners.add(cb); return () => { listeners!.delete(cb); if (!listeners!.size) resyncListeners.delete(id) } },
      spawn: opts => call('session', 'spawn', [opts], true), kill: id => report(call('session', 'kill', [id], true)),
      write: (id, data) => report(writer(id).then(lease => operator.writer({ ptyId: id, leaseId: lease.id, data }))), resize: (id, cols, rows) => { if (leases.has(id)) report(writer(id).then(lease => operator.writer({ ptyId: id, leaseId: lease.id, cols, rows }))) },
      onData: (id, cb) => observe('session.data', value => { if (value.ptyId === id && typeof value.data === 'string') cb(value.data) }),
      onExit: (id, cb) => observe('session.exit', value => { if (value.ptyId === id && typeof value.exitCode === 'number') { leases.delete(id); writable(id, false); cb(value.exitCode) } })
    },
    terminals: { list: () => call('session', 'list', []), onChanged: cb => listen(terminalListeners, cb) },
    worker: { start: (id, cols, rows) => call('worker', 'start', [id, { cols, rows }], true, projectId()) }, coordinator: { start: async (objective, cols, rows, images) => (await call('coordinator', 'start', [{ objective, cols, rows, images }], true, projectId())).ptyId },
    assistant: { open: (cols, rows) => openAssistant(cols, rows), reset: (cols, rows) => openAssistant(cols, rows, true) },
    assistantChat: {
      available: async id => !terminalAssistants.has(id), getMessages: async id => terminalAssistants.has(id)
        ? { ptyId: id, protocolVersion: 2, revision: 0, transport: 'terminal', agent: terminalAssistants.get(id), messages: [], status: 'done', interactions: [] }
        : chat(await call('dialog', 'snapshot', [id])),
      send: (id, text) => call('dialog', 'send', [id, text], true), sendWithWorkflow: async (id, text, context) => { const value = await call('profile', 'workflowContext', [context]); await call('dialog', 'send', [id, text, value], true) },
      interrupt: id => call('dialog', 'interrupt', [id], true), respond: (id, request, answer) => call('dialog', 'respond', [id, request, answer], true),
      onMessage: (id, cb) => { let reading = false; let again = false; let active = true
        const update = () => {
          again = true; if (reading || !active || disposed) return; reading = true
          report((async () => { while (again && active && !disposed) { again = false; const value = await client.assistantChat.getMessages(id); if (active && !disposed) cb({ ptyId: id, revision: value.revision, status: value.status, snapshot: value, readOnly: value.readOnly, requiresNewConversation: value.requiresNewConversation }) } })().finally(() => { reading = false }))
        }
        chatResync.add(update)
        const off = observe('dialog.changed', value => { if (value.id === id) update() })
        return () => { active = false; chatResync.delete(update); off() }
      }
    },
    workflowAssistant: { save: async (id, baseline, workflow) => { await call('profile', 'saveWorkflowDraft', [id, baseline, workflow], true) }, onSaved: cb => listen(savedListeners, cb) },
    docs: { list: () => call('files', 'listDocs', [], false, projectId()), read: (source, path) => call('files', 'readDoc', [source, path], false, projectId()), view: (source, path, opts) => call('files', 'viewDoc', [source, path, opts], false, projectId()), bytes: async (source, path) => ({ mime: (await call('files', 'viewDoc', [source, path], false, projectId())).mime ?? 'application/octet-stream', bytes: await operator.binary({ projectId: projectId(), kind: 'doc', source, path }) }), previewUrl: (source, path) => call('files', 'docPreview', [source, path], false, projectId()) },
    showcase: { read: async (id, path, dispatchId) => ({ mime: showcaseServedMime(path) ?? 'application/octet-stream', bytes: await operator.binary({ projectId: projectId(), kind: 'showcase', id, path, ...(dispatchId ? { dispatchId } : {}) }) }), previewUrl: (id, path, opts) => call('files', 'showcasePreview', [id, path, opts], false, projectId()), previewBase: id => call('files', 'showcaseBase', [id], false, projectId()) },
    files: { list: (id, dir) => call('files', 'listDir', [dir], false, id) }, rules: { list: () => call('rules', 'list', [], false, projectId()), save: (name, text) => call('rules', 'save', [name, text], true, projectId()) },
    stats: { project: (id, range) => call('stats', 'project', [range], false, id), task: (id, task) => call('stats', 'task', [task], false, id), global: (id, run) => call('stats', 'global', [run], false, id) },
    review: { info: id => call('review', 'info', [id], false, projectId()), accept: async (id, text) => { await call('review', 'accept', [id, text], true, projectId()) }, reject: async (id, text, images) => { await call('review', 'reject', [id, text, images], true, projectId()) } },
    attachments: { ping: async () => true, capabilities: async () => ({ files: true, limits: ATTACHMENT_LIMITS }) },
    recovery: { list: id => call('recovery', 'list', [id]), inspect: id => call('recovery', 'inspect', [id]), resolve: (id, revision, resolution) => call('recovery', 'resolve', [id, revision, resolution], true) }
  }
  return { client, call, refresh, async dispose() { disposed = true; clearInterval(heartbeat); offEvents(); offTerminals(); offSaved(); offReset(); offState(); await operator.close() } }
}
