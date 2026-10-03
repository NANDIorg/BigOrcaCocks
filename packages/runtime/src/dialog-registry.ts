import type { AssistantSettings } from '@orca-board/core'
import { dialogHistory } from '@orca-board/contracts'
import type { ConversationUpdate, DialogRecord, InteractionAnswer } from '@orca-board/contracts'
import type { AssistantConversation } from './assistant-conversation-types.ts'
import type { DialogRepository } from './dialog-repository.ts'

export interface DialogSnapshot {
  dialog: DialogRecord
  readOnly?: true
  requiresNewConversation?: true
  storageFailed?: true
}
export interface DialogRegistryUpdate {
  id: string
  revision: number
  update: ConversationUpdate
  readOnly?: true
  requiresNewConversation?: true
  snapshot?: DialogSnapshot
}
export interface DialogRegistryDependencies {
  repository?: DialogRepository
  create(settings: AssistantSettings, onUpdate: (update: ConversationUpdate) => void): AssistantConversation
  errors: { unknown(): Error; emptyText(): Error; readOnly(): Error; storage(error: unknown): Error; load?(error: unknown): Error }
  onError?(error: Error): void
}
interface Entry {
  record: DialogRecord
  driver?: AssistantConversation
  fault?: Error
  observers: Set<(event: DialogRegistryUpdate) => void>
}
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
/** Состав коллекции задаёт driver; metadata оставшихся элементов сохраняется по id. */
function metadata(previous: unknown, current: unknown): unknown {
  if (Array.isArray(current)) return current.map((value, index) => {
    const before = Array.isArray(previous) ? (object(value) && typeof value.id === 'string'
      ? previous.find(item => object(item) && item.id === value.id) : previous[index]) : undefined
    return metadata(before, value)
  })
  if (!object(current)) return current
  const result: Record<string, unknown> = object(previous) ? { ...previous } : {}
  for (const [key, value] of Object.entries(current)) result[key] = metadata(result[key], value)
  return result
}

/** Один owner host; подписки принадлежат клиентам, процессы — реестру. */
export class DialogRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly deps: DialogRegistryDependencies
  constructor(deps: DialogRegistryDependencies) { this.deps = deps }
  private read<T>(operation: () => T): T {
    try { return operation() }
    catch (error) { throw this.deps.errors.load?.(error) ?? error }
  }

  list(projectId?: string): DialogRecord[] {
    const records = new Map(this.read(() => this.deps.repository?.list(projectId) ?? []).map(record => [record.id, record]))
    for (const [id, entry] of this.entries) if (projectId === undefined || entry.record.projectId === projectId) records.set(id, copy(entry.record))
    return [...records.values()]
  }
  latest(projectId?: string): DialogRecord | undefined {
    return this.list(projectId).filter(record => record.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))[0]
  }

  create(settings: AssistantSettings, projectId?: string): string {
    // Полная проверка файла ДО запуска CLI; битый/future файл не подменяем новым.
    const records = this.list()
    const at = records.reduce((latest, record) => Math.max(latest, record.updatedAt + 1), Date.now())
    let entry: Entry | undefined
    const driver = this.deps.create(settings, update => { if (entry?.driver) this.changed(entry, update) })
    try {
      const record: DialogRecord = { id: driver.id, ...(projectId === undefined ? {} : { projectId }), createdAt: at, updatedAt: at, revision: 0, conversation: copy(driver.snapshot()) }
      if (this.entries.has(record.id)) throw this.deps.errors.storage(new Error('Повторный id диалога'))
      this.deps.repository?.save(record, null)
      entry = { record, driver, observers: new Set() }
      this.entries.set(record.id, entry)
      return record.id
    } catch (error) {
      driver.dispose()
      throw this.deps.errors.storage(error)
    }
  }

  snapshot(id: string): DialogSnapshot {
    const entry = this.entries.get(id)
    if (entry) return entry.driver ? { dialog: copy(entry.record) } : { ...dialogHistory(entry.record), ...(entry.fault ? { storageFailed: true } as const : {}) }
    const record = this.read(() => this.deps.repository?.get(id))
    if (!record) throw this.deps.errors.unknown()
    return dialogHistory(record)
  }
  subscribe(id: string, observer: (event: DialogRegistryUpdate) => void): () => void {
    this.snapshot(id)
    let entry = this.entries.get(id)
    if (!entry) {
      entry = { record: this.snapshot(id).dialog, observers: new Set() }
      this.entries.set(id, entry)
    }
    entry.observers.add(observer)
    return () => { entry.observers.delete(observer) }
  }
  private require(id: string): Entry & { driver: AssistantConversation } {
    const entry = this.entries.get(id)
    if (entry?.fault) throw entry.fault
    if (!entry?.driver) { this.snapshot(id); throw this.deps.errors.readOnly() }
    return entry as Entry & { driver: AssistantConversation }
  }
  send(id: string, text: unknown, context?: string): Promise<void> {
    const entry = this.require(id)
    if (typeof text !== 'string' || !text.trim()) throw this.deps.errors.emptyText()
    return this.perform(entry, () => entry.driver.send(text, context))
  }
  interrupt(id: string): Promise<void> {
    const entry = this.require(id)
    return this.perform(entry, () => entry.driver.interrupt())
  }
  respond(id: string, requestId: string, answer: InteractionAnswer): Promise<void> {
    const entry = this.require(id)
    return this.perform(entry, () => entry.driver.respond(requestId, answer))
  }
  private async perform(entry: Entry, operation: () => Promise<void>): Promise<void> {
    try { await operation() }
    catch (error) { throw entry.fault ?? error }
    if (entry.fault) throw entry.fault
  }

  private publish(entry: Entry, update: ConversationUpdate): void {
    const event: DialogRegistryUpdate = { id: entry.record.id, revision: entry.record.revision, update,
      ...(!entry.driver ? { readOnly: true, requiresNewConversation: true, snapshot: this.snapshot(entry.record.id) } as const : {}) }
    for (const observer of [...entry.observers]) {
      try { observer(copy(event)) }
      catch (error) { this.deps.onError?.(error instanceof Error ? error : new Error(String(error))) }
    }
  }
  private save(entry: Entry, record: DialogRecord): void {
    const previous = this.deps.repository?.get(record.id)
    // Читаем полный persisted DTO: unknown metadata не теряется при новом snapshot driver.
    const conversation = metadata(previous?.conversation, record.conversation) as DialogRecord['conversation']
    conversation.error = record.conversation.error
    conversation.providerBinding = record.conversation.providerBinding
    const next: DialogRecord = { ...previous, ...record, conversation,
      revision: entry.record.revision + 1, updatedAt: Math.max(Date.now(), entry.record.updatedAt + 1) }
    this.deps.repository?.save(next, entry.record.revision)
    entry.record = copy(next)
  }
  private changed(entry: Entry, update: ConversationUpdate): void {
    if (!entry.driver) return
    const record = { ...entry.record, conversation: copy(entry.driver.snapshot()) }
    try { this.save(entry, record) }
    catch (error) { this.fail(entry, record, error); return }
    this.publish(entry, update)
  }
  private fail(entry: Entry, record: DialogRecord, error: unknown): void {
    const fault = this.deps.errors.storage(error)
    const driver = entry.driver
    entry.driver = undefined
    entry.fault = fault
    entry.record = dialogHistory({ ...record, revision: entry.record.revision + 1 }).dialog
    entry.record.conversation.status = 'error'
    entry.record.conversation.error = fault.message
    driver?.dispose()
    this.publish(entry, { type: 'state', status: 'error', error: fault.message })
    this.deps.onError?.(fault)
  }
  stop(id: string): void {
    const entry = this.entries.get(id)
    if (!entry?.driver) { this.snapshot(id); return }
    const driver = entry.driver
    const record = dialogHistory({ ...entry.record, conversation: copy(driver.snapshot()) }).dialog
    entry.driver = undefined
    driver.dispose()
    try { this.save(entry, record) }
    catch (error) { this.fail(entry, record, error); return }
    this.publish(entry, { type: 'state', status: entry.record.conversation.status, error: entry.record.conversation.error })
  }
  dispose(): void {
    for (const [id, entry] of this.entries) if (entry.driver) this.stop(id)
  }
}
