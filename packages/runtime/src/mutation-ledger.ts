import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { OperatorCall, OperatorError } from '@orca-board/contracts'
import { writeFileAtomic } from './persistence.ts'
import { protocolError, protocolObject, protocolText, OperatorProtocolError } from './operator-handshake.ts'

export interface MutationIdentity extends OperatorCall { clientId: string; actorId: string }
export type MutationResult = { status: 'applied'; result: unknown } | { status: 'rejected'; error: OperatorError } | { status: 'uncertain' }
interface RecordEntry { key: string; digest: string; ownerId: string; createdAt: number; updatedAt: number; result: MutationResult }
const byteLimit = 4 * 1024 * 1024
const uncertain: MutationResult = { status: 'uncertain' }
function schema(): never { throw new Error('Неподдерживаемая или повреждённая схема operator mutations') }
function number(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (protocolObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  protocolError('protocol.invalidInput', 'Аргументы должны быть JSON')
}
export function operatorError(error: unknown): OperatorError {
  // Тексты provider errors могут содержать credentials, prompt или stdout. На диске остаётся только код.
  if (error instanceof OperatorProtocolError) return { code: error.code }
  if (protocolObject(error) && typeof error.code === 'string' && error.code.startsWith('command.')) return { code: error.code }
  return { code: 'command.rejected' }
}

/** Intent сохраняется до callback, accepted result — после него; неизвестный outcome никогда не повторяется сам. */
export function createMutationLedger(options: { dataDir: string; ownerId: string; now?: () => number; ttlMs?: number; maxEntries?: number }) {
  const ownerId = protocolText(options.ownerId, 'ownerId'); const now = options.now ?? Date.now
  const ttl = options.ttlMs ?? 24 * 60 * 60 * 1000; const max = options.maxEntries ?? 1024
  if (!number(ttl) || ttl === 0 || !number(max) || max === 0) throw new RangeError('Некорректные лимиты mutations')
  const file = join(options.dataDir, 'operator-mutations.json'); let records: RecordEntry[] = []
  const active = new Map<string, { digest: string; promise: Promise<MutationResult> }>()
  if (existsSync(file)) {
    if (statSync(file).size > byteLimit) schema()
    let raw: unknown; try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { schema() }
    if (!protocolObject(raw) || raw.version !== 1 || !Array.isArray(raw.records) || Object.keys(raw).some(k => !['version', 'records'].includes(k))) schema()
    records = raw.records.map((record: unknown) => {
      if (!protocolObject(record) || Object.keys(record).some(k => !['key', 'digest', 'ownerId', 'createdAt', 'updatedAt', 'result'].includes(k))) schema()
      if (typeof record.key !== 'string' || typeof record.digest !== 'string' || !/^[a-f0-9]{64}$/.test(record.digest) || typeof record.ownerId !== 'string' || !number(record.createdAt) || !number(record.updatedAt) || !protocolObject(record.result)) schema()
      const result = record.result
      if (result.status === 'uncertain') { if (Object.keys(result).length !== 1) schema() }
      else if (result.status === 'applied') { if (!Object.hasOwn(result, 'result') || Object.keys(result).some(k => !['status', 'result'].includes(k))) schema() }
      else if (result.status === 'rejected') { if (!protocolObject(result.error) || typeof result.error.code !== 'string' || Object.keys(result.error).some(k => k !== 'code') || Object.keys(result).some(k => !['status', 'error'].includes(k))) schema() }
      else schema()
      return { key: record.key, digest: record.digest, ownerId: record.ownerId, createdAt: record.createdAt, updatedAt: record.updatedAt, result: result as MutationResult }
    })
    if (new Set(records.map(r => r.key)).size !== records.length) schema()
  }
  function save(next: RecordEntry[]): void {
    const text = JSON.stringify({ version: 1, records: next })
    if (Buffer.byteLength(text) > byteLimit) protocolError('protocol.capacity', 'Достигнут лимит размера mutations')
    writeFileAtomic(file, text); records = next
  }
  function execute(input: MutationIdentity, operation: () => unknown | Promise<unknown>): Promise<MutationResult> {
    return Promise.resolve().then(() => {
      protocolText(input.clientId, 'clientId'); protocolText(input.actorId, 'actorId'); protocolText(input.id, 'id'); protocolText(input.method, 'method')
      if (!number(input.issuedAt)) protocolError('protocol.invalidInput', 'Некорректный issuedAt')
      const payload = canonical({ method: input.method, args: input.args, issuedAt: input.issuedAt, projectId: input.projectId ?? null, revision: input.revision ?? null })
      if (Buffer.byteLength(payload) > 64 * 1024) protocolError('protocol.invalidInput', 'Команда превышает 64KiB')
      const key = JSON.stringify([input.actorId, input.clientId, input.id]); const digest = createHash('sha256').update(payload).digest('hex')
      const running = active.get(key); const previous = records.find(r => r.key === key)
      if (running && running.digest !== digest || previous && previous.digest !== digest) protocolError('protocol.requestConflict', 'Конфликт payload повторного запроса')
      if (running) return running.promise.then(structuredClone)
      if (previous) return structuredClone(previous.result)
      if (now() - input.issuedAt > ttl || input.issuedAt > now() + 60_000) protocolError('protocol.requestExpired', 'Срок безопасного повтора запроса истек')
      const retained = records.filter(r => r.result.status === 'uncertain' || now() - r.updatedAt <= ttl)
      if (retained.length >= max) protocolError('protocol.capacity', 'Достигнут лимит mutations; требуется восстановление')
      const record: RecordEntry = { key, digest, ownerId, createdAt: now(), updatedAt: now(), result: uncertain }
      save([...retained, record])
      // Публикация Promise предшествует callback, включая его reentrant запросы.
      const promise = Promise.resolve().then(async (): Promise<MutationResult> => {
        let result: MutationResult
        try {
          const value = await operation()
          result = { status: 'applied', result: JSON.parse(JSON.stringify(value ?? null)) }
        } catch (error) { result = { status: 'rejected', error: operatorError(error) } }
        try { save(records.map(r => r.key === key ? { ...r, updatedAt: now(), result } : r)) }
        catch { return structuredClone(uncertain) }
        return structuredClone(result)
      })
      active.set(key, { digest, promise }); void promise.finally(() => active.delete(key)).catch(() => {})
      return promise.then(structuredClone)
    })
  }
  return {
    execute,
    pending() { return records.filter(r => r.result.status === 'uncertain').map(r => ({ identity: JSON.parse(r.key) as [string, string, string], ownerId: r.ownerId, createdAt: r.createdAt })) },
    /** Оператор подтверждает отказ после сверки; метод не запускает повторный native effect. */
    abandon(actorId: string, clientId: string, id: string): void {
      const key = JSON.stringify([actorId, clientId, id]); const record = records.find(r => r.key === key)
      if (!record || record.result.status !== 'uncertain' || active.has(key)) protocolError('protocol.requestConflict', 'Запрос не найден или ещё выполняется')
      save(records.map(r => r.key === key ? { ...r, updatedAt: now(), result: { status: 'rejected', error: { code: 'protocol.recoveryAbandoned' } } } : r))
    }
  }
}
export type MutationLedger = ReturnType<typeof createMutationLedger>
