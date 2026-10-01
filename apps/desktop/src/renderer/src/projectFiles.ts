import type { OrcaApi, ProjectFilesErrorCode } from '../../shared/ipc'
import type { FileError } from './fileTree'
import { ipcErrorCode, ipcErrorMessage } from './ipcError'
import { t } from './i18n'

/** Как staleAppMessage() в docLinks.ts: renderer обновился по HMR, а main/preload — ещё нет. */
export function filesStaleMessage(): string {
  return t('config.files.staleApp')
}

/** `window.orca.files` или понятная ошибка вместо «Cannot read properties of undefined». */
export function filesApi(api: Partial<OrcaApi> | undefined): OrcaApi['files'] {
  if (!api?.files) throw new Error(filesStaleMessage())
  return api.files
}

/** Preload новый, а main старый — invoke падает с «No handler registered for 'files:…'». */
export function isStaleFilesError(message: string): boolean {
  return /No handler registered for 'files:/.test(message)
}

/** Что известно о месте ошибки: папка запроса и корень проекта — для текстов с путём. */
export interface FilesErrorContext {
  path: string
  root: string
}

/**
 * Тексты ожидаемых отказов. `files.readFailed` — здесь только запасной: у main в тексте причина (доступ, ввод-вывод),
 * её показываем как есть.
 */
const MESSAGES: Record<ProjectFilesErrorCode, (ctx: FilesErrorContext) => string> = {
  'files.badPath': (ctx) => t('config.files.err.badPath', { path: ctx.path }),
  'files.outside': (ctx) => t('config.files.err.outside', { path: ctx.path }),
  'files.hidden': (ctx) => t('config.files.err.hidden', { path: ctx.path }),
  'files.notFound': (ctx) => t('config.files.err.notFound', { path: ctx.path }),
  'files.notDir': (ctx) => t('config.files.err.notDir', { path: ctx.path }),
  'files.notFile': (ctx) => t('config.files.err.notFile', { path: ctx.path }),
  'files.rootMissing': (ctx) => t('config.files.err.rootMissing', { path: ctx.root }),
  'files.readFailed': (ctx) => t('config.files.err.readFailed', { path: ctx.path })
}

const isKnownCode = (code: string | undefined): code is ProjectFilesErrorCode => code !== undefined && code in MESSAGES

/**
 * Отказ `files:*` для показа: сначала старый main/preload, затем текст по коду `OrcaError` (не по тексту main — он
 * переведён), иначе — сообщение main как есть.
 */
export function filesError(e: unknown, ctx: FilesErrorContext): FileError {
  const raw = ipcErrorMessage(e)
  if (isStaleFilesError(raw) || raw === filesStaleMessage()) return { message: filesStaleMessage(), stale: true }
  const code = ipcErrorCode(e)
  if (code === 'files.readFailed') return { code, message: raw.trim() || MESSAGES[code](ctx) }
  if (isKnownCode(code)) return { code, message: MESSAGES[code](ctx) }
  return { code, message: raw.trim() || t('config.files.err.readFailed', { path: ctx.path }) }
}

export function filesErrorMessage(e: unknown, ctx: FilesErrorContext): string {
  return filesError(e, ctx).message
}
