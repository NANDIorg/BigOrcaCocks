import { motionScrollBehavior } from './appearance'
import type React from 'react'
import { useMemo } from 'react'
import { marked, Marked } from 'marked'
import DOMPurify from 'dompurify'
import { assignHeadingIds, DOC_ID_PREFIX, findDocHeading, type DocHeading } from './docToc'
import { t, useLocale } from './i18n'
import { docKindOf } from '../../shared/docs-view'
import { resolveMarkdownLink, showcaseImageSrc, type MarkdownAssets } from './markdownAssets'
import './docs-markdown.css'

/** Сейчас санитизируется документ, а не чат: только в документе `#якорь` становится переходом. */
let sanitizingDoc = false
/** Сейчас санитизируется файл показа: его картинки — из снимка, относительные ссылки — на соседние файлы показа. */
let sanitizingAssets: MarkdownAssets | undefined

// Ссылки из ответа агента: http(s) открываются во внешнем браузере (target=_blank → setWindowOpenHandler
// в main → shell.openExternal). Остальные схемы и относительные пути не кликабельны: openExternal
// с file:// или кастомным протоколом запустил бы что угодно, а переход внутри окна увёл бы приложение.
// Относительная ссылка на .md остаётся в data-doc-href: просмотрщик «Документы» открывает её у себя.
// В документе `#якорь` остаётся в data-doc-anchor: Markdown по клику прокручивает к заголовку.
// В файле показа и в «Документах» (`assets`) относительная ссылка на другой файл остаётся в data-showcase-href
// (путь от корня показа или источника), её `#якорь` — в data-showcase-hash: просмотрщик открывает файл у себя.
// В «Документах» (`links: 'project'`) у ссылки ещё data-file-kind: значок «документ» или «файл» перед текстом.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'IMG' && sanitizingAssets) {
    showcaseImage(node, sanitizingAssets)
    return
  }
  if (node.tagName !== 'A') return
  const href = node.getAttribute('href') ?? ''
  if (/^https?:\/\//i.test(href)) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noreferrer')
  } else {
    node.removeAttribute('href')
    const target = sanitizingAssets ? resolveMarkdownLink(sanitizingAssets, href) : undefined
    if (target) {
      node.setAttribute('data-showcase-href', target.path)
      if (target.hash) node.setAttribute('data-showcase-hash', target.hash)
      if (sanitizingAssets?.links === 'project') node.setAttribute('data-file-kind', docKindOf(target.path).kind === 'markdown' ? 'doc' : 'file')
    } else if (sanitizingDoc && /^#./.test(href)) node.setAttribute('data-doc-anchor', href)
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && /\.md(?:[?#]|$)/i.test(href)) node.setAttribute('data-doc-href', href)
  }
})

/**
 * Картинка файла показа: относительная — из его снимка (`showcaseImageSrc`), остальные (внешние `https://`, `data:`) —
 * вместо картинки подпись с её `alt`: грузить их нельзя, а пустая рамка «битой» картинки непонятна.
 */
function showcaseImage(node: Element, assets: MarkdownAssets): void {
  const src = showcaseImageSrc(node.getAttribute('src') ?? '', assets)
  if (src) {
    node.setAttribute('src', src)
    node.removeAttribute('srcset')
    return
  }
  const alt = node.getAttribute('alt')?.trim()
  const note = node.ownerDocument.createElement('span')
  note.className = 'md-img-off'
  note.textContent = alt ? t('board.markdown.imageOffAlt', { alt }) : t('board.markdown.imageOff')
  node.replaceWith(note)
}

/** Санитизация с флагами хука: документ и/или файл показа. */
function sanitize(html: string, doc: boolean, assets: MarkdownAssets | undefined): string {
  sanitizingDoc = doc
  sanitizingAssets = assets
  try {
    return DOMPurify.sanitize(html)
  } finally {
    sanitizingDoc = false
    sanitizingAssets = undefined
  }
}

/** Markdown → безопасный HTML (GFM: таблицы, списки задач, переносы строк как в чате). `assets` — файл показа. */
export function renderMarkdown(text: string, assets?: MarkdownAssets): string {
  const html = marked.parse(text, { gfm: true, breaks: true, async: false })
  return sanitize(html, false, assets)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

// Документ: жёсткие переносы строк в исходнике не рвут абзац (breaks: false), у h2/h3 — id и якорь,
// у блока кода — шапка с языком и «Копировать», таблица в обёртке с рамкой и своей прокруткой.
const docMarked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    heading(token) {
      const inner = this.parser.parseInline(token.tokens)
      const id = (token as DocHeading).docId
      if (!id) return `<h${token.depth}>${inner}</h${token.depth}>\n`
      const slug = escapeHtml(id.slice(DOC_ID_PREFIX.length))
      return `<h${token.depth} id="${escapeHtml(id)}"><a class="doc-anchor" href="#${slug}" aria-hidden="true">#</a>${inner}</h${token.depth}>\n`
    },
    code({ text, lang }) {
      const language = (lang ?? '').match(/^\S*/)?.[0] ?? ''
      const cls = language ? ` class="language-${escapeHtml(language)}"` : ''
      return (
        `<div class="doc-code"><div class="doc-code-head"><span>${escapeHtml(language)}</span>` +
        `<button type="button" class="doc-copy">${escapeHtml(t('board.markdown.copy'))}</button></div>` +
        `<pre><code${cls}>${escapeHtml(text.replace(/\n$/, ''))}</code></pre></div>\n`
      )
    }
  }
})

/** Markdown-документ → безопасный HTML для окна «Документы» и просмотрщика показа. Id заголовков совпадают с buildDocToc. */
export function renderDocMarkdown(text: string, assets?: MarkdownAssets): string {
  const tokens = docMarked.lexer(text)
  assignHeadingIds(tokens)
  const html = docMarked.parser(tokens).replace(/<table>/g, '<div class="doc-table"><table>').replace(/<\/table>/g, '</table></div>')
  return sanitize(html, true, assets)
}

type ShowcaseLinkHandler = (path: string, hash?: string) => void

/** Клик по ссылке на файл показа или проекта (`data-showcase-href`, якорь — `data-showcase-hash`): true — обработан. */
function onShowcaseLinkClick(e: React.MouseEvent<HTMLDivElement>, onShowcaseLink: ShowcaseLinkHandler | undefined): boolean {
  const link = (e.target as Element).closest('[data-showcase-href]')
  if (!link || !onShowcaseLink) return false
  e.preventDefault()
  onShowcaseLink(link.getAttribute('data-showcase-href') ?? '', link.getAttribute('data-showcase-hash') ?? undefined)
  return true
}

/** Клики внутри документа: переход по `#якорю` и копирование блока кода. */
function onDocClick(e: React.MouseEvent<HTMLDivElement>): void {
  const target = e.target as Element
  const anchor = target.closest('[data-doc-anchor]')
  if (anchor) {
    e.preventDefault()
    const heading = findDocHeading(e.currentTarget, anchor.getAttribute('data-doc-anchor') ?? '')
    heading?.scrollIntoView({ behavior: motionScrollBehavior(), block: 'start' })
    return
  }
  const copy = target.closest('.doc-copy')
  if (copy) {
    const code = copy.closest('.doc-code')?.querySelector('code')?.textContent ?? ''
    void navigator.clipboard.writeText(code).then(() => {
      copy.textContent = t('board.markdown.copied')
      setTimeout(() => (copy.textContent = t('board.markdown.copy')), 1500)
    })
  }
}

interface MarkdownProps {
  text: string
  className?: string
  variant?: 'chat' | 'doc'
  /**
   * Файл показа (ShowcaseBlock, ShowcaseViewer) или файл в «Документах» (`links: 'project'`): относительные картинки —
   * из снимка или корня источника, внешние и `data:` убираются (`markdownAssets.ts`), относительные ссылки на другие
   * файлы — `onShowcaseLink` с путём от корня и `#якорем`, если он есть.
   */
  assets?: MarkdownAssets
  onShowcaseLink?: ShowcaseLinkHandler
}

/**
 * Отрендеренный markdown. По умолчанию — ответ агента в чате; `variant="doc"` — документ
 * в окне «Документы» (типографика из docs-markdown.css, оглавление — buildDocToc из docToc.ts).
 */
export function Markdown({ text, className, variant = 'chat', assets, onShowcaseLink }: MarkdownProps): React.JSX.Element {
  // Язык — в зависимостях: подпись «Копировать» зашита в HTML документа.
  const locale = useLocale()
  const assetPath = assets?.path
  const assetBase = assets?.base
  const assetLinks = assets?.links
  const html = useMemo(() => {
    const a = assetPath !== undefined ? { path: assetPath, ...(assetBase ? { base: assetBase } : {}), ...(assetLinks ? { links: assetLinks } : {}) } : undefined
    return variant === 'doc' ? renderDocMarkdown(text, a) : renderMarkdown(text, a)
  }, [text, variant, locale, assetPath, assetBase, assetLinks])
  if (variant === 'doc') {
    return (
      <div
        className={`doc-md${className ? ` ${className}` : ''}`}
        onClick={(e) => { if (!onShowcaseLinkClick(e, onShowcaseLink)) onDocClick(e) }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }
  return (
    <div
      className={`markdown${className ? ` ${className}` : ''}`}
      onClick={onShowcaseLink ? (e) => void onShowcaseLinkClick(e, onShowcaseLink) : undefined}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
