import type { VersionBackupResult } from '@orca-board/runtime'

export {
  BACKUPS_KEEP, UNKNOWN_VERSION, compareVersions, readLastRunVersion, copyStateTo,
  pruneBackups, backupOnVersionChange, type VersionBackupResult
} from '@orca-board/runtime'

// Тост об обновлении — состояние Desktop, общий runtime его не хранит.
let justUpdatedFrom: string | null = null

/** Запоминает итог `backupOnVersionChange` для `getJustUpdatedFrom`. */
export function rememberUpdate(result: VersionBackupResult): void {
  justUpdatedFrom = result.updated && result.previous !== undefined ? result.previous : null
}

/** «Приложение только что обновилось с X»: версия, с которой пришли в этом запуске, или null. Новая — `app.getVersion()`. */
export function getJustUpdatedFrom(): string | null {
  return justUpdatedFrom
}
