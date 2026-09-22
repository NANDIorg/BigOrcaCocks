import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Persistence, StoreSnapshot } from '@orca-board/core'

/** JSON-файл в userData. SQLite подключим, когда появятся события в объёме. */
export function jsonPersistence(file: string): Persistence {
  return {
    load() {
      if (!existsSync(file)) return null
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as StoreSnapshot
      } catch {
        return null
      }
    },
    save(snapshot) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(snapshot, null, 2))
    }
  }
}
