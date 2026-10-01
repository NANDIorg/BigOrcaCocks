// Какие файлы показа человеку (Dispatch.showcase, docs/workflow.md → «Показ человеку») можно открыть из
// приложения. Чистый модуль: белый список проверяет main (IPC showcase:*), а renderer по нему решает, что
// превьюить, — без electron и node.

import type { DispatchShowcase } from '@orca-board/core'

/**
 * Как renderer показывает файл: `image` — превью по байтам (blob), `markdown` — текстом, `html` — страницей в
 * изолированном фрейме по протоколу `orca-preview://` (IPC `showcase:previewUrl`, байты через `showcase:read` не
 * отдаются), `open` — только кнопкой.
 */
export type ShowcasePreview = 'image' | 'markdown' | 'html' | 'open'

export interface ShowcaseFileType {
  mime: string
  preview: ShowcasePreview
}

/**
 * Разрешённые расширения (нижний регистр, с точкой). Остальное не читается и не открывается: IPC открывает файл
 * приложением системы по умолчанию, и `.sh` или `.app` из ветки агента запускать нельзя. SVG — как картинка:
 * в `<img>` скрипты из него не выполняются.
 */
export const SHOWCASE_FILE_TYPES: Readonly<Record<string, ShowcaseFileType>> = {
  '.png': { mime: 'image/png', preview: 'image' },
  '.jpg': { mime: 'image/jpeg', preview: 'image' },
  '.jpeg': { mime: 'image/jpeg', preview: 'image' },
  '.webp': { mime: 'image/webp', preview: 'image' },
  '.gif': { mime: 'image/gif', preview: 'image' },
  '.avif': { mime: 'image/avif', preview: 'image' },
  '.svg': { mime: 'image/svg+xml', preview: 'image' },
  '.md': { mime: 'text/markdown', preview: 'markdown' },
  '.markdown': { mime: 'text/markdown', preview: 'markdown' },
  '.html': { mime: 'text/html', preview: 'html' },
  '.htm': { mime: 'text/html', preview: 'html' },
  // PDF в sandbox-фрейме Chromium не показывает — пока только «Открыть» приложением системы.
  '.pdf': { mime: 'application/pdf', preview: 'open' }
}

/**
 * Ассеты страниц показа: не точки входа (списком не показываются, не открываются кнопкой), а то, что HTML из
 * снимка грузит сам — стили, скрипты, шрифты, медиа. Отдаются только протоколом `orca-preview://` внутри снимка
 * и исполняются только в изолированном фрейме. Всё, чего нет ни здесь, ни в `SHOWCASE_FILE_TYPES`
 * (исполняемое, архивы, офисные файлы), в снимок не копируется и не отдаётся.
 */
export const SHOWCASE_ASSET_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav'
}

/**
 * HTML и SVG из вложения открылись бы приложением системы (обычно браузером) со скриптами: SVG может содержать
 * `<script>`, как HTML, — в `<img>` превью он безопасен, а «Открыть» его уже не изолирует. Такие только показываем в папке.
 */
const ATTACHMENT_NOT_OPENABLE = new Set(['.html', '.htm', '.svg'])

/**
 * Можно ли открыть вложение глобальной задачи приложением системы («Открыть»): расширение (без точки, любой регистр)
 * из белого списка показа без HTML и SVG. Запускать произвольный файл (`.sh`, `.app`) нельзя — остальным только
 * «Показать в папке». Один список для main (`globalTasks:openAttachment`) и renderer (кнопка в карточке файла).
 */
export function attachmentOpenable(ext: string): boolean {
  if (!/^[a-z0-9]{1,10}$/i.test(ext)) return false
  const key = `.${ext.toLowerCase()}`
  return Object.hasOwn(SHOWCASE_FILE_TYPES, key) && !ATTACHMENT_NOT_OPENABLE.has(key)
}

/** Больше не читаем в renderer (превью): макеты и скриншоты, не видео. Открыть кнопкой можно и больше. */
export const SHOWCASE_READ_MAX_BYTES = 10 * 1024 * 1024

/** Расширение пути в нижнем регистре с точкой; нет расширения — undefined. */
function extOf(path: string): string | undefined {
  return /\.[^./\\]+$/.exec(path)?.[0].toLowerCase()
}

/** Тип файла показа по расширению пути; не из белого списка — undefined. */
export function showcaseFileType(path: string): ShowcaseFileType | undefined {
  const ext = extOf(path)
  return ext ? SHOWCASE_FILE_TYPES[ext] : undefined
}

/** Точка входа показа (`SHOWCASE_FILE_TYPES`): её человек видит списком. */
export function isEntryType(path: string): boolean {
  return showcaseFileType(path) !== undefined
}

/** Ассет страницы (`SHOWCASE_ASSET_TYPES`): попадает в снимок и отдаётся протоколом, но списком не показывается. */
export function isAssetType(path: string): boolean {
  const ext = extOf(path)
  return ext !== undefined && Object.hasOwn(SHOWCASE_ASSET_TYPES, ext)
}

/** MIME файла, который протокол показа может отдать (точка входа или ассет); остальное — undefined. */
export function showcaseServedMime(path: string): string | undefined {
  const ext = extOf(path)
  if (!ext) return undefined
  return SHOWCASE_FILE_TYPES[ext]?.mime ?? (Object.hasOwn(SHOWCASE_ASSET_TYPES, ext) ? SHOWCASE_ASSET_TYPES[ext] : undefined)
}

/**
 * Показ в body approval (`requestHuman`, main/workflow.ts): описание воркера и список файлов текстом. Превью
 * и кнопки «Открыть» рисует renderer по `showcaseDispatchId`; этот текст — для старого renderer и для
 * `orca-board request get`. Новый renderer вычитает его из body (`bodyWithoutShowcase`, renderer/src/showcase.ts),
 * чтобы не показывать дважды, — поэтому функция общая, а не копия.
 */
export function showcaseMarkdown(showcase: DispatchShowcase): string {
  const files = showcase.files.length ? ['**Файлы показа** (в worktree задачи):', ...showcase.files.map((f) => `- \`${f}\``)].join('\n') : undefined
  return ['## Показ', showcase.text?.trim(), files].filter(Boolean).join('\n\n')
}
