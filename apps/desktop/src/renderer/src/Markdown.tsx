import type React from 'react'
import { useMemo } from 'react'
import { marked, Marked } from 'marked'
import DOMPurify from 'dompurify'
import { assignHeadingIds, DOC_ID_PREFIX, findDocHeading, type DocHeading } from './docToc'
import './docs-markdown.css'

/** Сейчас санитизируется документ, а не чат: только в документе `#якорь` становится переходом. */
let sanitizingDoc = false

// Ссылки из ответа агента: http(s) открываются во внешнем браузере (target=_blank → setWindowOpenHandler
// в main → shell.openExternal). Остальные схемы и относительные пути не кликабельны: openExternal
// с file:// или кастомным протоколом запустил бы что угодно, а переход внутри окна увёл бы приложение.
// Относительная ссылка на .md остаётся в data-doc-href: просмотрщик «Документы» открывает её у себя.
// В документе `#якорь` остаётся в data-doc-anchor: Markdown по клику прокручивает к заголовку.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName !== 'A') return
  const href = node.getAttribute('href') ?? ''
  if (/^https?:\/\//i.test(href)) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noreferrer')
  } else {
    node.removeAttribute('href')
    if (sanitizingDoc && /^#./.test(href)) node.setAttribute('data-doc-anchor', href)
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && /\.md(?:[?#]|$)/i.test(href)) node.setAttribute('data-doc-href', href)
  }
})

/** Markdown → безопасный HTML (GFM: таблицы, списки задач, переносы строк как в чате). */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { gfm: true, breaks: true, async: false })
  return DOMPurify.sanitize(html)
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
        `<button type="button" class="doc-copy">Копировать</button></div>` +
        `<pre><code${cls}>${escapeHtml(text.replace(/\n$/, ''))}</code></pre></div>\n`
      )
    }
  }
})

/** Markdown-документ → безопасный HTML для окна «Документы». Id заголовков совпадают с buildDocToc. */
export function renderDocMarkdown(text: string): string {
  const tokens = docMarked.lexer(text)
  assignHeadingIds(tokens)
  const html = docMarked.parser(tokens).replace(/<table>/g, '<div class="doc-table"><table>').replace(/<\/table>/g, '</table></div>')
  sanitizingDoc = true
  try {
    return DOMPurify.sanitize(html)
  } finally {
    sanitizingDoc = false
  }
}

/** Клики внутри документа: переход по `#якорю` и копирование блока кода. */
function onDocClick(e: React.MouseEvent<HTMLDivElement>): void {
  const target = e.target as Element
  const anchor = target.closest('[data-doc-anchor]')
  if (anchor) {
    e.preventDefault()
    const heading = findDocHeading(e.currentTarget, anchor.getAttribute('data-doc-anchor') ?? '')
    heading?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    return
  }
  const copy = target.closest('.doc-copy')
  if (copy) {
    const code = copy.closest('.doc-code')?.querySelector('code')?.textContent ?? ''
    void navigator.clipboard.writeText(code).then(() => {
      copy.textContent = 'Скопировано'
      setTimeout(() => (copy.textContent = 'Копировать'), 1500)
    })
  }
}

/**
 * Отрендеренный markdown. По умолчанию — ответ агента в чате; `variant="doc"` — документ
 * в окне «Документы» (типографика из docs-markdown.css, оглавление — buildDocToc из docToc.ts).
 */
export function Markdown({ text, className, variant = 'chat' }: { text: string; className?: string; variant?: 'chat' | 'doc' }): React.JSX.Element {
  const html = useMemo(() => (variant === 'doc' ? renderDocMarkdown(text) : renderMarkdown(text)), [text, variant])
  if (variant === 'doc') {
    return <div className={`doc-md${className ? ` ${className}` : ''}`} onClick={onDocClick} dangerouslySetInnerHTML={{ __html: html }} />
  }
  return <div className={`markdown${className ? ` ${className}` : ''}`} dangerouslySetInnerHTML={{ __html: html }} />
}
