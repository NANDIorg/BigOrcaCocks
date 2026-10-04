import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './persistence.ts'

import type { EffectPosition, NativeEffect, EffectResolution, EffectRecord } from '@orca-board/contracts'
export type { EffectPosition, NativeEffect, EffectResolution, EffectRecord } from '@orca-board/contracts'

export interface EffectJournal {
  readonly ownerId: string
  begin(position: EffectPosition, effect: NativeEffect): string
  nativeCompleted(id: string, outcome?: 'ok' | 'failed'): void
  applied(ids: readonly string[]): void
  pending(position?: EffectPosition): EffectRecord[]
  assertClear(position: EffectPosition): void
  resolve(id: string, revision: number, resolution: EffectResolution): EffectRecord
}

const textFields = ['projectId', 'taskId', 'runId', 'nodeId', 'laneId', 'dispatchId'] as const
const numberFields = ['visit', 'forkVisit', 'taskCreatedAt', 'runCreatedAt'] as const
const unresolved = (record: EffectRecord) => record.phase === 'intent' || record.phase === 'native-complete'
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
function invalid(): never { throw new Error('Неподдерживаемая или повреждённая схема журнала effects; восстановите профиль совместимой версией Orca.') }
function text(value: unknown): string { if (typeof value !== 'string' || !value.length || value.length > 8192) invalid(); return value }
function integer(value: unknown, min = 0): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) invalid(); return value }
function keys(value: Record<string, unknown>, allowed: readonly string[]): void { if (Object.keys(value).some(k => !allowed.includes(k))) invalid() }
function positionFrom(value: unknown): EffectPosition {
  if (!object(value)) invalid()
  keys(value, ['repoRoot', ...textFields, ...numberFields])
  const position: EffectPosition = { repoRoot: text(value.repoRoot) }
  for (const key of textFields) if (value[key] !== undefined) position[key] = text(value[key])
  for (const key of numberFields) if (value[key] !== undefined) position[key] = integer(value[key])
  return position
}
function effectFrom(value: unknown): NativeEffect {
  if (!object(value)) invalid()
  keys(value, ['kind', 'operation', 'cwd', 'resource'])
  if (value.kind !== 'git' && value.kind !== 'pty' && value.kind !== 'files') invalid()
  return { kind: value.kind, operation: text(value.operation), cwd: text(value.cwd), ...(value.resource === undefined ? {} : { resource: text(value.resource) }) }
}
function recordFrom(value: unknown): EffectRecord {
  if (!object(value)) invalid()
  keys(value, ['id', 'revision', 'ownerId', 'position', 'effect', 'phase', 'outcome', 'resolution', 'createdAt', 'updatedAt'])
  const { phase, outcome, resolution } = value
  if (phase !== 'intent' && phase !== 'native-complete' && phase !== 'applied' && phase !== 'resolved') invalid()
  if (outcome !== undefined && outcome !== 'ok' && outcome !== 'failed') invalid()
  if (resolution !== undefined && resolution !== 'retry' && resolution !== 'acknowledge' && resolution !== 'abandon') invalid()
  if ((phase === 'native-complete' || phase === 'applied') && outcome === undefined || phase === 'resolved' && resolution === undefined) invalid()
  return { id: text(value.id), revision: integer(value.revision, 1), ownerId: text(value.ownerId), position: positionFrom(value.position), effect: effectFrom(value.effect),
    phase, ...(outcome === undefined ? {} : { outcome }), ...(resolution === undefined ? {} : { resolution }), createdAt: integer(value.createdAt), updatedAt: integer(value.updatedAt) }
}

/** Позиция из прошлого owner не даёт полномочий новому visit/dispatch/экземпляру карточки. */
export function effectPositionMatches(record: EffectPosition, target: EffectPosition): boolean {
  if (record.repoRoot !== target.repoRoot || record.projectId !== undefined && target.projectId !== undefined && record.projectId !== target.projectId) return false
  if (record.taskId !== undefined && record.taskId !== target.taskId || record.runId !== undefined && record.runId !== target.runId) return false
  for (const key of numberFields) {
    if (key.endsWith('CreatedAt') && record[key] !== undefined && target[key] !== undefined && record[key] !== target[key]) return false
  }
  // Run resource неизвестен целиком: дочерняя задача не может разрешить его своей task-позицией.
  if (!record.taskId && record.runId && target.taskId) return true
  for (const key of ['nodeId', 'visit', 'laneId', 'forkVisit', 'dispatchId'] as const) if (record[key] !== undefined && record[key] !== target[key]) return false
  return true
}

/** Создаётся под profile lease; отсутствующий journal прежнего профиля не требует миграции или записи. */
export function createEffectJournal(options: { dataDir: string; ownerId: string; maxPending?: number; maxCompleted?: number }): EffectJournal {
  const ownerId = text(options.ownerId)
  const maxPending = integer(options.maxPending ?? 1024, 1); const maxCompleted = integer(options.maxCompleted ?? 256)
  const file = join(options.dataDir, 'effect-journal.json')
  let records: EffectRecord[] = []
  if (existsSync(file)) {
    if (statSync(file).size > 4 * 1024 * 1024) invalid()
    let value: unknown
    try { value = JSON.parse(readFileSync(file, 'utf8')) } catch { invalid() }
    if (!object(value) || value.version !== 1 || !Array.isArray(value.records)) invalid()
    keys(value, ['version', 'records'])
    records = value.records.map(recordFrom)
    if (new Set(records.map(r => r.id)).size !== records.length) invalid()
  }
  function save(next: EffectRecord[]): void {
    const completed = maxCompleted === 0 ? [] : next.filter(r => !unresolved(r)).slice(-maxCompleted)
    const keep = new Set(completed.map(r => r.id))
    const bounded = next.filter(r => unresolved(r) || keep.has(r.id))
    const text = JSON.stringify({ version: 1, records: bounded }, null, 2)
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Достигнут лимит размера журнала effects')
    writeFileAtomic(file, text)
    records = bounded
  }
  function find(id: string): EffectRecord {
    const record = records.find(r => r.id === id)
    if (!record) throw new Error('Запись журнала effects не найдена')
    return record
  }
  function change(id: string, update: (record: EffectRecord) => EffectRecord): void { save(records.map(r => r.id === id ? update(r) : r)) }
  const journal: EffectJournal = {
    ownerId,
    begin(rawPosition, rawEffect) {
      const position = positionFrom(rawPosition); const effect = effectFrom(rawEffect)
      journal.assertClear(position)
      if (records.filter(unresolved).length >= maxPending) throw new Error('Достигнут лимит незавершённых effects; сначала выполните сверку журнала')
      const now = Date.now(); const record: EffectRecord = { id: randomUUID(), revision: 1, ownerId, position, effect, phase: 'intent', createdAt: now, updatedAt: now }
      save([...records, record]); return record.id
    },
    nativeCompleted(id, outcome = 'ok') {
      const record = find(id)
      if (record.ownerId !== ownerId || record.phase !== 'intent') throw new Error('Native completion относится к чужому или завершённому effect')
      change(id, r => ({ ...r, phase: 'native-complete', outcome, revision: r.revision + 1, updatedAt: Date.now() }))
    },
    applied(ids) {
      if (!ids.length) return
      const selected = new Set(ids)
      for (const id of selected) { const record = find(id); if (record.ownerId !== ownerId || record.phase !== 'native-complete') throw new Error('Checkpoint относится к чужому или незавершённому effect') }
      save(records.map(r => selected.has(r.id) ? { ...r, phase: 'applied', revision: r.revision + 1, updatedAt: Date.now() } : r))
    },
    pending(position) { return structuredClone(records.filter(r => unresolved(r) && (!position || effectPositionMatches(r.position, position)))) },
    assertClear(position) {
      if (records.some(r => r.ownerId !== ownerId && unresolved(r) && effectPositionMatches(r.position, position))) {
        throw new Error('Результат предыдущей операции неопределён; повтор остановлен до сверки журнала восстановления')
      }
    },
    resolve(id, revision, resolution) {
      const record = find(id)
      if (record.revision !== revision) throw new Error('revision записи журнала изменилась; прочитайте её повторно')
      if (!unresolved(record)) throw new Error('Операция уже разрешена')
      if (record.ownerId === ownerId && record.phase === 'intent') throw new Error('Native операция текущего owner ещё выполняется')
      if (resolution !== 'retry' && resolution !== 'acknowledge' && resolution !== 'abandon') throw new Error('Некорректное решение восстановления')
      const updated: EffectRecord = { ...record, phase: 'resolved', resolution, revision: record.revision + 1, updatedAt: Date.now() }
      save(records.map(r => r.id === id ? updated : r)); return structuredClone(updated)
    }
  }
  return journal
}
