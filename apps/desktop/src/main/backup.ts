// Бэкап состояния при смене версии приложения (docs/architecture.md → «Хранение»). Логика без Electron: версию и
// каталог userData передаёт вызывающий код, поэтому она тестируется напрямую (`backup.test.ts`).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './persistence'

/** Сколько бэкапов хранится: старше удаляются при создании нового. */
export const BACKUPS_KEEP = 3

/** Имя каталога бэкапа файла без `lastRunVersion` (запись до появления поля): предыдущую версию не узнать. */
export const UNKNOWN_VERSION = 'unknown'

const PROJECTS_FILE = 'projects.json'

export interface VersionBackupResult {
  /** Версия, с которой запускались в прошлый раз; undefined — первый запуск (файлов ещё нет). */
  previous?: string
  /** Каталог созданного бэкапа; нет — версия не изменилась или копировать нечего. */
  backupDir?: string
  /** Перешли на более новую версию: только тогда «приложение обновилось» (откат назад обновлением не считается). */
  updated: boolean
}

/** Сравнение версий вида 1.2.3[-pre]: по числовым частям слева направо; нечисловое считается нулём. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] => v.split('-')[0].split('.').map((x) => Number.parseInt(x, 10) || 0)
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/** Версия из имени каталога: путь-разделители и прочее опасное заменяются, чтобы «версия» не вышла за backups/. */
function dirName(version: string): string {
  return version.replace(/[^0-9A-Za-z._+-]/g, '_') || UNKNOWN_VERSION
}

/** `lastRunVersion` из projects.json «как есть», без миграций и без переименования битого файла (этим займётся ProjectManager). */
export function readLastRunVersion(userData: string): string | undefined {
  const file = join(userData, PROJECTS_FILE)
  if (!existsSync(file)) return undefined
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const v = typeof raw === 'object' && raw !== null ? (raw as { lastRunVersion?: unknown }).lastRunVersion : undefined
    return typeof v === 'string' && v !== '' ? v : undefined
  } catch {
    return undefined
  }
}

/** Копия projects.json и boards/*.json в `backups/<version>/`. Возвращает каталог или undefined, если копировать нечего. */
export function copyStateTo(userData: string, version: string): string | undefined {
  const files: Array<[string, string]> = []
  const projects = join(userData, PROJECTS_FILE)
  if (existsSync(projects)) files.push([projects, PROJECTS_FILE])
  const boards = join(userData, 'boards')
  if (existsSync(boards)) {
    for (const f of readdirSync(boards)) if (f.endsWith('.json')) files.push([join(boards, f), join('boards', f)])
  }
  if (files.length === 0) return undefined
  const dir = join(userData, 'backups', dirName(version))
  // Повторный бэкап той же версии (откат и новое обновление) заменяет старый целиком, а не смешивается с ним.
  rmSync(dir, { recursive: true, force: true })
  for (const [src, rel] of files) {
    const dst = join(dir, rel)
    mkdirSync(join(dst, '..'), { recursive: true })
    copyFileSync(src, dst)
  }
  return dir
}

/** Оставляет `keep` самых свежих каталогов в backups/ (по времени изменения, при равенстве — по имени). */
export function pruneBackups(userData: string, keep: number = BACKUPS_KEEP): string[] {
  const root = join(userData, 'backups')
  if (!existsSync(root)) return []
  const dirs = readdirSync(root)
    .map((name) => ({ name, mtime: statSync(join(root, name)).mtimeMs }))
    .filter((d) => statSync(join(root, d.name)).isDirectory())
    .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1))
  const removed = dirs.slice(keep).map((d) => d.name)
  for (const name of removed) rmSync(join(root, name), { recursive: true, force: true })
  return removed
}

/**
 * Проставляет `lastRunVersion` в существующем projects.json (атомарно). Так версия запоминается сразу после бэкапа,
 * а не после загрузки ProjectManager: упади приложение между ними — при следующем запуске бэкап делался бы заново
 * уже с мигрированными файлами и затёр бы исходные. Нет файла или он битый — ничего не делаем.
 */
function stampLastRunVersion(userData: string, version: string): void {
  const file = join(userData, PROJECTS_FILE)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return // Битый файл не трогаем и не переименовываем: это дело ProjectManager (предупреждение и .corrupt-<ts>).
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
  writeFileAtomic(file, JSON.stringify({ ...raw, lastRunVersion: version }, null, 2))
}

/**
 * Вызывать в начале запуска, ДО загрузки ProjectManager и досок: их миграции переписывают файлы, а бэкап должен
 * сохранить состояние в формате старой версии. Версия та же — ничего не делает.
 */
export function backupOnVersionChange(userData: string, currentVersion: string): VersionBackupResult {
  const hasState = existsSync(join(userData, PROJECTS_FILE))
  if (!hasState) return { updated: false }
  const last = readLastRunVersion(userData)
  if (last === currentVersion) return { previous: last, updated: false }
  const backupDir = copyStateTo(userData, last ?? UNKNOWN_VERSION)
  pruneBackups(userData)
  stampLastRunVersion(userData, currentVersion)
  // Без записи о прошлой версии сравнивать нечего: «обновились с неизвестной» — тост не про это, бэкап всё равно сделан.
  return { previous: last, backupDir, updated: last !== undefined && compareVersions(last, currentVersion) < 0 }
}

let justUpdatedFrom: string | null = null

/** Запоминает итог `backupOnVersionChange` для `getJustUpdatedFrom`. */
export function rememberUpdate(result: VersionBackupResult): void {
  justUpdatedFrom = result.updated && result.previous !== undefined ? result.previous : null
}

/** «Приложение только что обновилось с X»: версия, с которой пришли в этом запуске, или null. Новая — `app.getVersion()`. */
export function getJustUpdatedFrom(): string | null {
  return justUpdatedFrom
}
