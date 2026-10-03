import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { dialogHistory } from '@orca-board/contracts'
import type { DialogHistorySnapshot, DialogRecord } from '@orca-board/contracts'
import { writeFileAtomic } from './persistence.ts'
import { assertDialogDocument, assertDialogRecord, DialogRepositoryError } from './dialog-validation.ts'
import type { DialogDocument } from './dialog-validation.ts'

export { DialogRepositoryError } from './dialog-validation.ts'

/** Имя файла по соглашению Desktop; repository всё равно получает явный absolute path. */
export const DIALOGS_FILE = 'dialogs.json'

export interface DialogRepository {
  list(projectId?: string): DialogRecord[]
  get(id: string): DialogRecord | undefined
  history(id: string): DialogHistorySnapshot | undefined
  save(record: DialogRecord, expectedRevision: number | null): void
  remove(id: string, expectedRevision: number): void
}

function parse(text: string): unknown {
  try { return JSON.parse(text) }
  catch { throw new DialogRepositoryError('dialog.invalid', 'История диалогов содержит повреждённый JSON') }
}
function read(file: string): DialogDocument {
  let text: string
  try { text = readFileSync(file, 'utf8') }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { schemaVersion: 1, dialogs: [] }
    throw error
  }
  const document = parse(text)
  assertDialogDocument(document)
  return document
}
function clone(record: DialogRecord): DialogRecord {
  let text: string | undefined
  try { text = JSON.stringify(record) }
  catch { throw new DialogRepositoryError('dialog.invalid', 'Диалог должен быть JSON-совместимым') }
  if (text === undefined) throw new DialogRepositoryError('dialog.invalid', 'Диалог должен быть JSON-совместимым')
  // toJSON и прочие преобразования не могут обойти проверку реально записываемого DTO.
  const value = parse(text)
  assertDialogRecord(value)
  return value
}
function conflict(): never { throw new DialogRepositoryError('dialog.conflict', 'Ревизия диалога изменилась или запись уже отсутствует') }
function revision(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 }

/**
 * Один owner profile задаёт host до мутаций. CAS защищает от устаревшего caller,
 * но не заменяет межпроцессный lock. Factory/чтение не создают файлы и не запускают CLI.
 */
export function createDialogRepository(file: string): DialogRepository {
  if (typeof file !== 'string' || !isAbsolute(file)) throw new DialogRepositoryError('dialog.invalid', 'Требуется абсолютный путь файла истории диалогов')
  const get = (id: string): DialogRecord | undefined => read(file).dialogs.find(record => record.id === id)
  return {
    list: projectId => read(file).dialogs.filter(record => projectId === undefined || record.projectId === projectId),
    get,
    history: id => { const record = get(id); return record ? dialogHistory(record) : undefined },
    save(record, expectedRevision) {
      const document = read(file)
      const incoming = clone(record)
      const index = document.dialogs.findIndex(saved => saved.id === incoming.id)
      if (expectedRevision === null) {
        if (index !== -1 || document.retiredDialogIds?.includes(incoming.id) || incoming.revision !== 0) conflict()
        document.dialogs.push(incoming)
      } else {
        if (!revision(expectedRevision) || index === -1 || document.dialogs[index].revision !== expectedRevision || incoming.revision !== expectedRevision + 1) conflict()
        document.dialogs[index] = incoming
      }
      writeFileAtomic(file, JSON.stringify(document, null, 2))
    },
    remove(id, expectedRevision) {
      const document = read(file)
      const index = document.dialogs.findIndex(record => record.id === id)
      if (!revision(expectedRevision) || index === -1 || document.dialogs[index].revision !== expectedRevision) conflict()
      document.dialogs.splice(index, 1)
      // Revision0 нельзя снова выдать тому же id: stale caller принял бы новый
      // lifecycle за прежний. Tombstone пишется атомарно вместе с удалением.
      document.retiredDialogIds = [...(document.retiredDialogIds ?? []), id]
      writeFileAtomic(file, JSON.stringify(document, null, 2))
    }
  }
}
