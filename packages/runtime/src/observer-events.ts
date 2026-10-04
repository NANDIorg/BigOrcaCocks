import type { ObserverCursor, ObserverDelivery, ObserverEvent, ObserverSnapshot } from '@orca-board/contracts'
import { protocolObject, protocolText } from './operator-handshake.ts'

export interface ObserverSubscription { take(): ObserverDelivery[]; close(): void }
export interface ObserverEventOptions {
  epoch: string
  maxEvents?: number
  maxBytes?: number
  maxAgeMs?: number
  queueEvents?: number
  queueBytes?: number
  now?: () => number
}
type Retained = { event: ObserverEvent; bytes: number }
type Subscriber = { queue: ObserverDelivery[]; bytes: number; reset: boolean; closed: boolean; filter?: (event: ObserverEvent) => boolean }
function limit(value: number, min = 1): number { if (!Number.isSafeInteger(value) || value < min) throw new RangeError('Некорректный лимит observer'); return value }

/** Поток не обращается к core check/consumedBy и не управляет процессами. Restart epoch требует нового snapshot. */
export function createObserverEvents(options: ObserverEventOptions) {
  const epoch = protocolText(options.epoch, 'epoch'); const now = options.now ?? Date.now
  const maxEvents = limit(options.maxEvents ?? 512); const maxBytes = limit(options.maxBytes ?? 2 * 1024 * 1024, 256)
  const maxAge = limit(options.maxAgeMs ?? 24 * 60 * 60 * 1000)
  const queueEvents = limit(options.queueEvents ?? 128); const queueBytes = limit(options.queueBytes ?? 1024 * 1024, 256)
  let sequence = 0; let floor = 0; let bytes = 0
  let delivering = false
  const pending: ObserverEvent[] = []
  const history: Retained[] = []; const subscribers = new Set<Subscriber>()
  const cursor = (): ObserverCursor => ({ epoch, sequence, at: now() })
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
  function prune(): void {
    while (history.length && (history.length > maxEvents || bytes > maxBytes || now() - history[0].event.cursor.at > maxAge)) {
      const first = history.shift()!; floor = first.event.cursor.sequence; bytes -= first.bytes
    }
  }
  function reset(sub: Subscriber): void {
    sub.reset = true; const message: ObserverDelivery = { type: 'snapshotRequired', cursor: cursor() }
    sub.queue = [message]; sub.bytes = size(message)
  }
  function offer(sub: Subscriber, event: ObserverEvent): void {
    if (sub.closed) return
    if (sub.reset) { reset(sub); return }
    try { if (sub.filter && !sub.filter(structuredClone(event))) return }
    catch { sub.closed = true; sub.queue = []; sub.bytes = 0; subscribers.delete(sub); return }
    const message: ObserverDelivery = { type: 'event', event }; const added = size(message)
    if (sub.queue.length >= queueEvents || sub.bytes + added > queueBytes) { reset(sub); return }
    sub.queue.push(message); sub.bytes += added
  }
  function valid(raw: unknown): raw is ObserverCursor {
    return protocolObject(raw) && raw.epoch === epoch && typeof raw.sequence === 'number' && Number.isSafeInteger(raw.sequence)
      && raw.sequence >= floor && raw.sequence <= sequence && typeof raw.at === 'number' && Number.isSafeInteger(raw.at)
      && raw.at <= now() && now() - raw.at <= maxAge
  }
  function subscribe(raw: unknown = cursor(), filter?: Subscriber['filter']): ObserverSubscription {
    prune(); const sub: Subscriber = { queue: [], bytes: 0, reset: false, closed: false, filter }
    subscribers.add(sub)
    if (!valid(raw)) reset(sub)
    else for (const item of history) if (item.event.cursor.sequence > raw.sequence) offer(sub, item.event)
    return {
      take() { const queue = structuredClone(sub.queue); sub.queue = []; sub.bytes = 0; return queue },
      close() { sub.closed = true; subscribers.delete(sub); sub.queue = []; sub.bytes = 0 }
    }
  }
  return {
    get cursor() { prune(); return cursor() },
    publish(topic: string, payload: unknown, projectId?: string): ObserverCursor {
      protocolText(topic, 'topic'); if (projectId !== undefined) protocolText(projectId, 'projectId', 8192)
      let event: ObserverEvent = { cursor: { epoch, sequence: sequence + 1, at: now() }, topic, ...(projectId === undefined ? {} : { projectId }), payload: null }
      try { event.payload = JSON.parse(JSON.stringify(payload ?? null)) } catch { event.truncated = true }
      if (size({ type: 'event', event }) > Math.min(maxBytes, queueBytes, 64 * 1024)) event = { ...event, payload: null, truncated: true }
      // Очень длинный путь не удерживает queue; client перечитает scoped snapshot.
      if (size({ type: 'event', event }) > Math.min(maxBytes, queueBytes)) event = { cursor: event.cursor, topic: 'invalidate', payload: null, truncated: true }
      sequence++; const retained = { event, bytes: size(event) }; history.push(retained); bytes += retained.bytes; prune()
      pending.push(event)
      if (!delivering) {
        delivering = true
        try {
          let delivered = 0
          while (pending.length && delivered++ < maxEvents) {
            const next = pending.shift()!
            for (const sub of [...subscribers]) offer(sub, next)
          }
          // Ошибочный host callback не может бесконечно генерировать события в одном owner tick.
          if (pending.length) { pending.length = 0; for (const sub of subscribers) reset(sub) }
        } finally { delivering = false }
      }
      return structuredClone(event.cursor)
    },
    subscribe,
    snapshot<T>(read: () => T, filter?: Subscriber['filter']): ObserverSnapshot<T> & { subscription: ObserverSubscription } {
      const barrier = cursor(); const subscription = subscribe(barrier, filter)
      try { return { snapshot: structuredClone(read()), cursor: barrier, subscription } }
      catch (error) { subscription.close(); throw error }
    },
    close() { for (const sub of subscribers) { sub.closed = true; sub.queue = []; sub.bytes = 0 }; subscribers.clear() }
  }
}
export type ObserverEvents = ReturnType<typeof createObserverEvents>
