import { rmSync } from 'node:fs'
import { join } from 'node:path'

/** Идентификаторы проекта, прогона и вложения в путях — только такие символы (см. `newId`). */
const SAFE_ID = /^[A-Za-z0-9_-]+$/

/** Корень хранилища вложений: `<userData>/run-images`. */
export function runImagesRoot(userData: string): string {
  return join(userData, 'run-images')
}

export function safeArtifactId(id: string, what: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`${what}: недопустимый идентификатор «${id}»`)
  return id
}

/** Папка вложений задачи: `<root>/<projectId>/<runId>`. */
export function runImagesDir(root: string, projectId: string, runId: string): string {
  return join(root, safeArtifactId(projectId, 'проект'), safeArtifactId(runId, 'задача'))
}

/**
 * Удаляет все файлы задачи (`runId`) или всего проекта (без `runId`) — при удалении глобальной задачи и проекта.
 * Ошибку файловой системы не бросает: задача уже удалена, остаток на диске не должен ломать удаление.
 */
export function removeRunImagesDir(root: string, projectId: string, runId?: string): void {
  try {
    const dir = runId === undefined ? join(root, safeArtifactId(projectId, 'проект')) : runImagesDir(root, projectId, runId)
    rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    console.error(`[orca] не удалось удалить вложения ${runId ?? projectId}:`, (e as Error).message)
  }
}

/** Корень хранилища снимков: `<userData>/showcase`. */
export function showcaseSnapshotsRoot(userData: string): string {
  return join(userData, 'showcase')
}

/** Папка снимка запуска: `<root>/<projectId>/<runId>/<dispatchId>` (задача без прогона — `<root>/<projectId>/_tasks/…`). */
export function showcaseSnapshotDir(root: string, projectId: string, runId: string | undefined, dispatchId: string): string {
  return join(root, safeArtifactId(projectId, 'проект'), runId === undefined ? '_tasks' : safeArtifactId(runId, 'задача'), safeArtifactId(dispatchId, 'запуск'))
}

/**
 * Удаляет снимки глобальной задачи (`runId`) или всего проекта (без `runId`) — при удалении задачи и проекта, как
 * `removeRunImagesDir`. Ошибку файловой системы не бросает: задача уже удалена, остаток на диске не должен ломать удаление.
 */
export function removeShowcaseDir(root: string, projectId: string, runId?: string): void {
  try {
    const dir = runId === undefined ? join(root, safeArtifactId(projectId, 'проект')) : join(root, safeArtifactId(projectId, 'проект'), safeArtifactId(runId, 'задача'))
    rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    console.error(`[orca] не удалось удалить снимки показа ${runId ?? projectId}:`, (e as Error).message)
  }
}
