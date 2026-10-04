import type { OperatorCommands, OperatorArgs, OperatorResult, OperatorCall, OperatorMetadata, OperatorProduct, ObserverCursor, ObserverEvent } from '@orca-board/contracts'
import type { AttachmentInput } from '@orca-board/core'
import type { OperatorTransport, ClientSelection } from './transport.ts'

export class OrcaClientError extends Error {
  readonly code: string
  readonly details?: Record<string, unknown>
  constructor(code: string, details?: Record<string, unknown>) { super(code); this.name = 'OrcaClientError'; this.code = code; this.details = details }
}
export interface CallOptions { projectId?: string; revision?: number }
export interface ClientState { phase: 'disconnected' | 'connecting' | 'connected' | 'closed'; selection: ClientSelection; language: 'ru' | 'en'; metadata?: OperatorMetadata; snapshot?: unknown; cursor?: ObserverCursor }
export interface OrcaClientOptions { transport: OperatorTransport; product: OperatorProduct; language?: 'ru' | 'en'; requiredCapabilities?: string[]; pollMs?: number; sleep?(ms: number): Promise<void>; requestId?(): string }

/** Transport не создаёт owner. Reconnect повторяет identity, selection и observer cursor. */
export function createOrcaClient(options: OrcaClientOptions) {
  const transport = options.transport; let state: ClientState = { phase: 'disconnected', selection: {}, language: options.language ?? 'ru' }
  let generation = 0; let connection = 0; let connecting: Promise<void> | undefined; let timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<(state: ClientState) => void>(); const observers = new Set<(event: ObserverEvent) => void>()
  const writerQueues = new Map<string, Promise<void>>(); const writerSequences = new Map<string, number>()
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const emit = () => { for (const listener of listeners) listener(structuredClone(state)) }
  const guard = () => { if (state.phase === 'closed') throw new OrcaClientError('client.closed') }
  const schedule = () => {
    if (timer || state.phase === 'closed' || options.pollMs === 0) return
    timer = setTimeout(() => { void poll().finally(schedule) }, options.pollMs ?? 500)
  }
  const refresh = async (epoch: number) => {
    const snapshot = await transport.snapshot()
    if (epoch !== generation || state.phase === 'closed') return
    state = { ...state, snapshot: snapshot.snapshot, cursor: snapshot.cursor }; emit()
  }
  const connect = (): Promise<void> => {
    guard(); if (connecting) return connecting
    if (state.phase === 'connected') return Promise.resolve()
    const epoch = generation; const visit = ++connection
    state = { ...state, phase: 'connecting' }; emit()
    connecting = (async () => {
      const metadata = await transport.hello({ protocolMajor: 1, schemaVersion: 1, product: options.product, requiredCapabilities: options.requiredCapabilities })
      if (metadata.protocolMajor !== 1 || metadata.schemaVersion !== 1) throw new OrcaClientError('protocol.incompatible')
      if (options.requiredCapabilities?.some(capability => !metadata.capabilities.includes(capability))) throw new OrcaClientError('protocol.capabilityMissing')
      await transport.select(state.selection)
      if (state.cursor && state.metadata?.runtimeRevision === metadata.runtimeRevision && transport.subscribe) await transport.subscribe(state.cursor)
      else await refresh(epoch)
      if (epoch !== generation || visit !== connection) return
      state = { ...state, metadata, phase: 'connected' }; emit()
      if (!timer) schedule()
    })().catch(error => { if (visit === connection && state.phase !== 'closed') { state = { ...state, phase: 'disconnected' }; emit() } throw error })
      .finally(() => { connecting = undefined })
    return connecting
  }
  async function poll(): Promise<void> {
    timer = undefined; if (state.phase === 'closed') return
    try {
      if (state.phase !== 'connected') { await connect(); return }
      const epoch = generation; const visit = connection; const deliveries = await transport.events()
      if (epoch !== generation || visit !== connection) return
      for (const delivery of deliveries) {
        if (delivery.type === 'snapshotRequired' || state.cursor && delivery.event.cursor.epoch !== state.cursor.epoch) { await refresh(epoch); break }
        const event = delivery.event
        if (state.cursor && event.cursor.sequence <= state.cursor.sequence) continue
        state = { ...state, cursor: event.cursor }; for (const observer of observers) observer(structuredClone(event))
      }
    } catch { if (state.phase !== 'closed') { state = { ...state, phase: 'disconnected' }; emit() } }
  }
  const send = async (request: OperatorCall) => {
    for (let attempt = 0; ; attempt++) {
      guard(); if (state.phase !== 'connected') await connect()
      try { return await transport.call(request) }
      catch (error) {
        if (error instanceof OrcaClientError || attempt >= 2) throw error
        state = { ...state, phase: 'disconnected' }; emit(); await sleep(Math.min(2000, 100 * 2 ** attempt)); await connect()
      }
    }
  }
  async function materialize(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) return Promise.all(value.map(materialize))
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>
      if (object.data instanceof Uint8Array && typeof object.name === 'string') {
        if (!transport.upload) throw new OrcaClientError('protocol.capabilityMissing')
        return transport.upload(object as unknown as AttachmentInput)
      }
      return Object.fromEntries(await Promise.all(Object.entries(object).filter(([, item]) => item !== undefined).map(async ([key, item]) => [key, await materialize(item)])))
    }
    return value
  }
  const execute = async (request: OperatorCall): Promise<unknown> => {
    const epoch = generation; const result = await send(structuredClone(request))
    if (epoch !== generation || state.phase === 'closed') throw new OrcaClientError('client.staleResponse')
    if (result.id !== request.id) throw new OrcaClientError('protocol.invalidReply')
    if (!result.ok) throw new OrcaClientError(result.error.code, result.error.details)
    return result.result
  }
  return {
    get state() { return structuredClone(state) }, connect,
    async refresh() { guard(); if (state.phase !== 'connected') await connect(); await refresh(generation) },
    subscribe(listener: (state: ClientState) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    observe(listener: (event: ObserverEvent) => void) { observers.add(listener); return () => { observers.delete(listener) } },
    setLanguage(language: 'ru' | 'en') { guard(); state = { ...state, language }; emit() },
    async select(selection: ClientSelection) {
      guard(); generation++; state = { ...state, selection: structuredClone(selection), cursor: undefined, snapshot: undefined }; emit()
      await connecting; guard(); await transport.select(selection); await refresh(generation)
    },
    async prepare<G extends keyof OperatorCommands, M extends keyof OperatorCommands[G] & string>(group: G, method: M, args: OperatorArgs<OperatorCommands[G][M]>, callOptions: CallOptions = {}): Promise<OperatorCall> {
      guard(); if (state.phase !== 'connected') await connect()
      if (!state.metadata?.capabilities.includes(`method:${group}.${method}`)) throw new OrcaClientError('protocol.capabilityMissing')
      return { id: options.requestId?.() ?? globalThis.crypto.randomUUID(), issuedAt: Date.now(), method: `${group}.${method}`, args: await materialize(args) as unknown[], ...callOptions }
    },
    execute,
    async call<G extends keyof OperatorCommands, M extends keyof OperatorCommands[G] & string>(group: G, method: M, args: OperatorArgs<OperatorCommands[G][M]>, callOptions: CallOptions = {}): Promise<OperatorResult<OperatorCommands[G][M]>> {
      return await execute(await this.prepare(group, method, args, callOptions)) as OperatorResult<OperatorCommands[G][M]>
    },
    async binary(query: Record<string, string>) { guard(); if (!transport.binary) throw new OrcaClientError('protocol.capabilityMissing'); return transport.binary(query) },
    writer(packet: { ptyId: string; leaseId: string; data?: string; cols?: number; rows?: number }): Promise<void> {
      guard(); if (!transport.writer) return Promise.reject(new OrcaClientError('protocol.capabilityMissing'))
      if (!writerQueues.has(packet.leaseId) && writerQueues.size >= 32) return Promise.reject(new OrcaClientError('protocol.capacity'))
      const pending = (writerQueues.get(packet.leaseId) ?? Promise.resolve()).then(async () => {
        const sequence = (writerSequences.get(packet.leaseId) ?? 0) + 1; const request = { ...packet, sequence }
        try { await transport.writer!(request) } catch { guard(); await transport.writer!(request) }
        writerSequences.set(packet.leaseId, sequence)
      })
      writerQueues.set(packet.leaseId, pending); void pending.finally(() => { if (writerQueues.get(packet.leaseId) === pending) writerQueues.delete(packet.leaseId) }).catch(() => {})
      return pending
    },
    async close() {
      if (state.phase === 'closed') return
      generation++; connection++; state = { ...state, phase: 'closed' }; if (timer) clearTimeout(timer); timer = undefined; emit()
      await transport.close(); listeners.clear(); observers.clear(); writerSequences.clear()
    }
  }
}
export type OrcaClient = ReturnType<typeof createOrcaClient>
