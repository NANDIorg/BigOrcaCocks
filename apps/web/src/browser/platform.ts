import type { PlatformAdapter, OrcaClient, createTypedUiClient } from '@orca-board/client'
import { createWebUpdates } from './updates.ts'

export function download(bytes: Uint8Array, name: string, mime = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }))
  const link = document.createElement('a'); link.href = url; link.download = name.split('/').at(-1) ?? 'download'
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
export function createWebPlatform(options: { adapter: ReturnType<typeof createTypedUiClient>; operator: OrcaClient; chooseDirectory(): Promise<string | null>; notify(): Promise<void>;
  request<T>(path: string, method?: string, value?: unknown): Promise<T>; onError(error: unknown): void }): PlatformAdapter & { dispose(): void } {
  const { adapter, operator } = options
  const updates = createWebUpdates(options)
  const noop = () => () => {}
  const project = () => { const id = operator.state.selection.projectId; if (!id) throw new Error('command.projectNotFound'); return id }
  async function doc(source: string, path: string) { download(await operator.binary({ projectId: project(), kind: 'download', source, path }), path) }
  async function showcase(id: string, path: string, dispatchId?: string) { download(await operator.binary({ projectId: project(), kind: 'showcase', id, path, ...(dispatchId ? { dispatchId } : {}) }), path) }
  async function attachment(id: string, imageId: string) { const task = await adapter.client.globalTasks.get(id); const meta = task.images?.find(image => image.id === imageId); download(await operator.binary({ projectId: project(), kind: 'attachment', id, imageId }), meta?.name ?? imageId, meta?.mime) }
  return {
    app: { windowChrome: 'system', testNotification: options.notify },
    updates: updates.api, dispose: updates.dispose,
    projects: {
      add: async (type, path) => { const root = path ?? await options.chooseDirectory(); return root ? adapter.call('profile', 'addProject', [root, type], true) : null },
      detectTaskType: async path => { const root = path ?? await options.chooseDirectory(); return root ? adapter.call('profile', 'detectTaskType', [root]) : null }, onFocus: noop
    },
    taskTypes: { export: async id => { const value = await adapter.call('profile', 'exportTaskType', [id]); download(new TextEncoder().encode(value.text), value.fileName, 'application/json'); return { path: value.fileName } } },
    docs: { open: doc, reveal: doc }, showcase: { open: showcase, reveal: showcase, onFrameEscape: noop },
    files: { reveal: async (id, path) => { download(await operator.binary({ projectId: id, kind: 'download', source: 'project', path }), path) } },
    globalTasks: { revealAttachment: attachment, openAttachment: attachment }, requests: { onFocus: noop }
  }
}
