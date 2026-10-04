import { randomUUID } from 'node:crypto'
import type { WriterLease } from '@orca-board/contracts'
import { CommandError } from './project-commands.ts'

export interface SessionWriterLeaseOptions {
  isAlive(ptyId: string): boolean
  now?: () => number
  ttlMs?: number
  unknownSession?(ptyId: string): Error
}
/** Lease управляет вводом, а не жизнью процесса; dropClient не обращается к kill. */
export function createSessionWriterLeases(options: SessionWriterLeaseOptions) {
  const leases = new Map<string, WriterLease>()
  const ttl = options.ttlMs ?? 30_000
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 60_000) throw new RangeError('Writer TTL должен быть целым числом 1..60000 ms')
  let clock = 0
  const time = () => { clock = Math.max(clock, (options.now ?? Date.now)()); return clock }
  const known = (id: string) => {
    if (options.isAlive(id)) return
    leases.delete(id)
    throw options.unknownSession?.(id) ?? new Error('Терминал не найден')
  }
  const conflict = () => { throw new CommandError('command.conflict') }
  function prune(): void {
    const at = time()
    for (const [id, lease] of leases) if (lease.expiresAt <= at || !options.isAlive(id)) leases.delete(id)
  }
  function current(ptyId: string): WriterLease | null {
    known(ptyId); prune()
    const lease = leases.get(ptyId); return lease ? { ...lease } : null
  }
  function requireWriter(ptyId: string, clientId: string, leaseId: string): WriterLease {
    const lease = current(ptyId)
    if (!lease || lease.clientId !== clientId || lease.id !== leaseId) return conflict()
    return lease
  }
  function renew(ptyId: string, clientId: string, leaseId: string): WriterLease {
    const lease = { ...requireWriter(ptyId, clientId, leaseId), expiresAt: time() + ttl }
    leases.set(ptyId, lease); return { ...lease }
  }
  function claim(ptyId: string, clientId: string): WriterLease {
    const previous = current(ptyId)
    if (previous) { if (previous.clientId !== clientId) return conflict(); return renew(ptyId, clientId, previous.id) }
    const lease = { id: randomUUID(), ptyId, clientId, expiresAt: time() + ttl }
    leases.set(ptyId, lease); return { ...lease }
  }
  function release(ptyId: string, clientId: string, leaseId: string): void {
    requireWriter(ptyId, clientId, leaseId); leases.delete(ptyId)
  }
  function dropClient(clientId: string): void { for (const [id, lease] of leases) if (lease.clientId === clientId) leases.delete(id); prune() }
  return { claim, require: requireWriter, renew, release, current, prune, dropClient, dropSession: (id: string): void => { leases.delete(id) } }
}
export type SessionWriterLeases = ReturnType<typeof createSessionWriterLeases>
