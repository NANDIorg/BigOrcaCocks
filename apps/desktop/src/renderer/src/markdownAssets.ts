// Картинки и ссылки markdown из показа человеку (Markdown.tsx с `assets`): `![](shots/a.png)` в `docs/README.md`
// показывается из того же снимка, что и сам файл, по протоколу `orca-preview://<токен>/…` (IPC showcase:previewUrl
// отдаёт `base` — корень снимка). Здесь — только решения по строке адреса, без DOM и IPC.

/** Контекст показа для markdown: где лежит файл и корень его снимка в протоколе. */
export interface MarkdownAssets {
  /** Путь markdown-файла от корня показа (`docs/README.md`): от его папки разрешаются относительные адреса. */
  path: string
  /**
   * `orca-preview://<токен>/` из `showcase:previewUrl`. Нет (старый main, ошибка, ещё грузится) — относительные
   * картинки не показываются: приложение не грузит их со своего адреса.
   */
  base?: string
}

/** Схема в начале адреса: `https:`, `data:`, `javascript:`, `C:` (диск Windows) — всё это не относительный путь. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * Путь файла показа, на который указывает относительный адрес `ref` из markdown `docPath`, — или undefined, если адрес
 * не относительный (схема, `/…`, `//хост`), выходит `..` за корень показа, ведёт в скрытое (`.env`, `.git/…`) или
 * кривой. `?запрос` и `#якорь` отбрасываются, `%20` и кириллица декодируются: протокол кодирует сегменты сам.
 */
export function resolveShowcaseRef(docPath: string, ref: string): string | undefined {
  const raw = ref.trim().replace(/[?#].*$/, '')
  if (!raw || SCHEME.test(raw) || raw.startsWith('/') || /[\\\0]/.test(raw)) return undefined
  const out = docPath.split('/').filter(Boolean).slice(0, -1)
  for (const part of raw.split('/')) {
    let seg: string
    try {
      seg = decodeURIComponent(part)
    } catch {
      return undefined
    }
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return undefined
      out.pop()
      continue
    }
    // Скрытое протокол всё равно не отдаст; разделители и NUL после декодирования — подмена пути.
    if (seg.startsWith('.') || /[\\/:\0]/.test(seg)) return undefined
    out.push(seg)
  }
  return out.length ? out.join('/') : undefined
}

/**
 * Адрес картинки markdown показа: относительная — `orca-preview://<токен>/<путь>` из того же снимка; всё остальное —
 * undefined (картинку убрать). Внешние `http(s)` не грузятся (CSP закрыт, а запрос выдал бы, что человек открыл показ),
 * `data:`/`blob:` CSP renderer'а для markdown не пускает, чужой `orca-preview://` — адрес не из этого показа.
 */
export function showcaseImageSrc(src: string, assets: MarkdownAssets): string | undefined {
  if (!assets.base) return undefined
  const path = resolveShowcaseRef(assets.path, src)
  return path ? assets.base + path.split('/').map(encodeURIComponent).join('/') : undefined
}
