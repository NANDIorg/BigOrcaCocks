import type React from 'react'
import { useMemo } from 'react'
import { codeText, gutterText, lineCount } from './docView'
import { useT } from './i18n'
import { highlightSyntax, syntaxLanguageOf, type SyntaxNode } from './syntaxHighlight'
import './syntax-highlight.css'

interface Props {
  text: string
  /** Имя файла — для подписи области скринридеру. */
  name: string
  /** Путь нужен для грамматики; имя остаётся подписью области. */
  path: string
  /** `<code>` с текстом — корень для ⌘F (`findInDoc`): номера строк в поиск не попадают. */
  codeRef?: React.Ref<HTMLElement>
  /** Прокручиваемая область — для `scrollToRange` и запоминания прокрутки в истории. */
  scrollRef?: React.Ref<HTMLDivElement>
  onScroll?(e: React.UIEvent<HTMLDivElement>): void
}

/**
 * Код и конфиги: моноширинно, без переноса, колонка номеров строк липнет слева. Подсветка — безопасные span и текст
 * React: файл проекта — недоверенные данные, а ⌘F ищет по всем текстовым узлам DOM.
 * Номера — отдельный `<pre aria-hidden>`: не выделяются и не копируются вместе с кодом.
 */
export function CodeView({ text, name, path, codeRef, scrollRef, onScroll }: Props): React.JSX.Element {
  const t = useT()
  const shown = useMemo(() => codeText(text), [text])
  const lines = useMemo(() => lineCount(shown), [shown])
  const gutter = useMemo(() => gutterText(lines), [lines])
  const highlighted = useMemo(() => syntaxChildren(highlightSyntax(shown, syntaxLanguageOf(path))), [shown, path])
  return (
    <div
      className="docs-code"
      ref={scrollRef}
      onScroll={onScroll}
      tabIndex={0}
      role="region"
      aria-label={t('config.docs.view.codeAria', { name, count: lines })}
    >
      <div className="docs-code-in">
        <pre className="gutter" aria-hidden="true">{gutter}</pre>
        <pre className="src"><code className="syntax-highlight" ref={codeRef}>{highlighted}</code></pre>
      </div>
    </div>
  )
}

function syntaxChildren(nodes: SyntaxNode[]): React.ReactNode[] {
  return nodes.map((node, index) => typeof node === 'string'
    ? node
    : <span key={index} className={node.className}>{syntaxChildren(node.children)}</span>)
}
