// Какие файлы показа человеку (Dispatch.showcase, docs/workflow.md → «Показ человеку») можно открыть из
// приложения. Чистый модуль: белый список проверяет main (IPC showcase:*), а renderer по нему решает, что
// превьюить, — без electron и node.

/** Как renderer показывает файл: `image` — превью по байтам (blob), `markdown` — текстом, `open` — только кнопкой. */
export type ShowcasePreview = 'image' | 'markdown' | 'open'

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
  '.svg': { mime: 'image/svg+xml', preview: 'image' },
  '.md': { mime: 'text/markdown', preview: 'markdown' },
  '.html': { mime: 'text/html', preview: 'open' },
  '.htm': { mime: 'text/html', preview: 'open' },
  '.pdf': { mime: 'application/pdf', preview: 'open' }
}

/** Больше не читаем в renderer (превью): макеты и скриншоты, не видео. Открыть кнопкой можно и больше. */
export const SHOWCASE_READ_MAX_BYTES = 10 * 1024 * 1024

/** Тип файла показа по расширению пути; не из белого списка — undefined. */
export function showcaseFileType(path: string): ShowcaseFileType | undefined {
  const m = /\.[^./\\]+$/.exec(path)
  return m ? SHOWCASE_FILE_TYPES[m[0].toLowerCase()] : undefined
}
