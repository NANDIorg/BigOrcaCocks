// Картинки и ссылки markdown из показа человеку и из «Документов» (Markdown.tsx с `assets`): `![](shots/a.png)`
// в `docs/README.md` показывается из того же снимка или корня, что и сам файл, по протоколу `orca-preview://<токен>/…`
// (IPC `showcase:previewUrl` / `docs:previewUrl` отдаёт `base`). Здесь — только решения по строке адреса, без DOM и IPC.

/** Контекст показа для markdown: где лежит файл и корень его снимка в протоколе. */
export interface MarkdownAssets {
  /** Путь markdown-файла от корня показа (`docs/README.md`): от его папки разрешаются относительные адреса. */
  path: string
  /**
   * `orca-preview://<токен>/` из `showcase:previewUrl`. Нет (старый main, ошибка, ещё грузится) — относительные
   * картинки не показываются: приложение не грузит их со своего адреса.
   */
  base?: string
  /**
   * `project` — файл в «Документах»: относительные ссылки ведут на любой файл источника, включая точечные (`.env`,
   * `.github/…`) — они в дереве как обычные; закрыт только `.git`. Без поля — показ: скрытое недоступно, как и в
   * протоколе. Картинки в обоих режимах — без скрытого: `orca-preview://` его не отдаёт.
   */
  links?: 'project'
}

/** Цель относительной ссылки markdown: путь от корня показа или источника и `#якорь` (декодирован). */
export interface MarkdownLink {
  path: string
  hash?: string
}

/** Схема в начале адреса: `https:`, `data:`, `javascript:`, `C:` (диск Windows) — всё это не относительный путь. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * Путь файла показа, на который указывает относительный адрес `ref` из markdown `docPath`, — или undefined, если адрес
 * не относительный (схема, `/…`, `//хост`), выходит `..` за корень показа, ведёт в скрытое (`.env`, `.git/…`) или
 * кривой. `?запрос` и `#якорь` отбрасываются, `%20` и кириллица декодируются: протокол кодирует сегменты сам.
 */
export function resolveShowcaseRef(docPath: string, ref: string): string | undefined {
  return resolveRef(docPath, ref, false)
}

/** `hidden` — пускать точечные сегменты (кроме `.git` в любом регистре: на macOS и Windows регистр не различается). */
function resolveRef(docPath: string, ref: string, hidden: boolean): string | undefined {
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
    if ((seg.startsWith('.') && (!hidden || seg.toLowerCase() === '.git')) || /[\\/:\0]/.test(seg)) return undefined
    out.push(seg)
  }
  return out.length ? out.join('/') : undefined
}

/**
 * Куда ведёт относительная ссылка markdown: путь (`resolveShowcaseRef`, в режиме `project` — и на точечные файлы) и
 * `#якорь`, чтобы просмотрщик открыл файл и прокрутил к разделу. Только якорь (`#раздел`) — undefined: это переход
 * внутри документа, его обрабатывает сам Markdown.
 */
export function resolveMarkdownLink(assets: MarkdownAssets, href: string): MarkdownLink | undefined {
  const ref = href.trim()
  if (ref.startsWith('#')) return undefined
  const path = resolveRef(assets.path, ref, assets.links === 'project')
  if (!path) return undefined
  const hash = linkHash(ref)
  return hash ? { path, hash } : { path }
}

/** «a.md#Раздел» → «Раздел»; пустой или битый якорь — undefined. */
function linkHash(ref: string): string | undefined {
  const i = ref.indexOf('#')
  if (i < 0) return undefined
  try {
    return decodeURIComponent(ref.slice(i + 1)) || undefined
  } catch {
    return undefined
  }
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

/**
 * Описание показа (`DispatchShowcase.text`, `--show-file`) — как markdown-файл в корне показа: пути картинок в нём —
 * от корня репозитория. Имя в корне, а не `''`: `resolveShowcaseRef` берёт папку файла.
 */
export const SHOWCASE_TEXT_PATH = 'showcase.md'

/**
 * Контекст картинок описания показа по ответу `showcase:previewBase`: есть `orca-preview://` — картинки из снимка
 * запуска; `null` (ни снимка, ни worktree), старый main/preload, ошибка или кривой адрес — без `base`, относительные
 * картинки заменяются подписью, как внешние.
 */
export function showcaseTextAssets(base: unknown): MarkdownAssets {
  return typeof base === 'string' && base.startsWith('orca-preview://') && base.endsWith('/')
    ? { path: SHOWCASE_TEXT_PATH, base }
    : { path: SHOWCASE_TEXT_PATH }
}

/**
 * В тексте есть картинка (`![…](…)`, `![…][id]` или `<img`): только тогда описанию нужна база снимка — без картинок
 * IPC не зовём и текст показываем сразу.
 */
export function hasMarkdownImages(text: string): boolean {
  return /!\[[^\]]*\]|<img\b/i.test(text)
}
