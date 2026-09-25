import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Persistence, StoreSnapshot } from '@orca-board/core'

/**
 * Предупреждение о состоянии на диске, которое человек должен увидеть (показывает renderer, когда появится канал):
 * файл не прочитался и был отложен в сторону, а не молча заменён пустым.
 */
export interface StateWarning {
  kind: 'corrupt'
  /** Файл, который не прочитался. */
  file: string
  /** Куда он переименован (`<файл>.corrupt-<ts>`); нет — переименовать не удалось. */
  movedTo?: string
  message: string
}

/**
 * Запись через временный файл: `writeFileSync` прямо в целевой файл при падении посреди записи оставляет
 * обрезанный JSON, а `renameSync` в пределах одного каталога атомарен — на диске всегда либо старый файл, либо новый.
 */
export function writeFileAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  try {
    writeFileSync(tmp, text)
    renameSync(tmp, file)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/**
 * Нечитаемый файл — в `<файл>.corrupt-<ts>`: следующая запись не затрёт то, что ещё можно разобрать руками.
 * Возвращает новый путь или undefined, если переименовать не вышло.
 */
export function quarantineCorrupt(file: string, now: number = Date.now()): string | undefined {
  const target = `${file}.corrupt-${now}`
  try {
    renameSync(file, target)
    return target
  } catch {
    return undefined
  }
}

export type JsonReadResult<T> =
  | { status: 'missing' }
  | { status: 'ok'; value: T; text: string }
  | { status: 'corrupt'; warning: StateWarning }

/** Читает JSON-файл. Битый не превращается в «пусто» молча: он отодвигается в `.corrupt-<ts>` и возвращается предупреждение. */
export function readJsonFile<T>(file: string, what: string): JsonReadResult<T> {
  if (!existsSync(file)) return { status: 'missing' }
  let reason: string
  try {
    const text = readFileSync(file, 'utf8')
    return { status: 'ok', value: JSON.parse(text) as T, text }
  } catch (e) {
    reason = (e as Error).message
  }
  const movedTo = quarantineCorrupt(file)
  const where = movedTo ? `сохранён как ${movedTo}` : 'переименовать не удалось'
  return { status: 'corrupt', warning: { kind: 'corrupt', file, movedTo, message: `${what}: файл ${file} повреждён (${reason}) — ${where}, начато с пустого состояния` } }
}

/** JSON-файл в userData. SQLite подключим, когда появятся события в объёме. */
export function jsonPersistence(file: string, onWarning?: (w: StateWarning) => void): Persistence {
  return {
    load() {
      const r = readJsonFile<Partial<StoreSnapshot>>(file, 'доска')
      if (r.status === 'corrupt') {
        onWarning?.(r.warning)
        return null
      }
      // JSON.parse('null') / число / массив — тоже не снапшот: без проверки store принял бы их за пустую доску и затёр.
      if (r.status === 'ok' && (typeof r.value !== 'object' || r.value === null || Array.isArray(r.value))) {
        const movedTo = quarantineCorrupt(file)
        onWarning?.({ kind: 'corrupt', file, movedTo, message: `доска: файл ${file} не содержит объект${movedTo ? ` — сохранён как ${movedTo}` : ''}, начато с пустого состояния` })
        return null
      }
      return r.status === 'ok' ? r.value : null
    },
    save(snapshot) {
      writeFileAtomic(file, JSON.stringify(snapshot, null, 2))
    }
  }
}
