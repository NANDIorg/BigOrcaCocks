import type React from 'react'
import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

// Ссылки из ответа агента: http(s) открываются во внешнем браузере (target=_blank → setWindowOpenHandler
// в main → shell.openExternal). Остальные схемы и относительные пути не кликабельны: openExternal
// с file:// или кастомным протоколом запустил бы что угодно, а переход внутри окна увёл бы приложение.
// Относительная ссылка на .md остаётся в data-doc-href: просмотрщик «Документы» открывает её у себя.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName !== 'A') return
  const href = node.getAttribute('href') ?? ''
  if (/^https?:\/\//i.test(href)) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noreferrer')
  } else {
    node.removeAttribute('href')
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && /\.md(?:[?#]|$)/i.test(href)) node.setAttribute('data-doc-href', href)
  }
})

/** Markdown → безопасный HTML (GFM: таблицы, списки задач, переносы строк как в чате). */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { gfm: true, breaks: true, async: false })
  return DOMPurify.sanitize(html)
}

/** Отрендеренный markdown ответа агента. */
export function Markdown({ text, className }: { text: string; className?: string }): React.JSX.Element {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className={`markdown${className ? ` ${className}` : ''}`} dangerouslySetInnerHTML={{ __html: html }} />
}
