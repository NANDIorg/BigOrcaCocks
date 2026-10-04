import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { assertStoreFormat } from '@orca-board/core'
import { assertDialogDocument } from './dialog-validation.ts'
import { PROJECTS_FILE_VERSION } from './task-types-migration.ts'

/** Только version checks до backup: старые/corrupt boards сохраняют прежнюю quarantine после backup. */
export function assertProfileSchemas(dataDir: string): void {
  const read = (file: string): Record<string, unknown> | undefined => {
    if (!existsSync(file)) return undefined
    if (lstatSync(file).isSymbolicLink()) throw new Error('Файл схемы профиля не должен быть ссылкой')
    let raw: unknown; try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined }
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined
  }
  const projects = read(join(dataDir, 'projects.json'))
  if (typeof projects?.version === 'number' && projects.version > PROJECTS_FILE_VERSION) throw new Error('Схема projects.json новее этого runtime')
  const boards = join(dataDir, 'boards')
  if (existsSync(boards)) for (const name of readdirSync(boards)) {
    if (!name.endsWith('.json')) continue
    const board = read(join(boards, name))
    try { assertStoreFormat(board?.formatVersion) } catch (cause) { throw new Error('Схема доски новее этого runtime', { cause }) }
  }
  const dialogs = join(dataDir, 'dialogs.json')
  if (existsSync(dialogs)) {
    const raw = read(dialogs)
    try { assertDialogDocument(raw) } catch (cause) { throw new Error('Неподдерживаемая или повреждённая схема диалогов', { cause }) }
  }
}
