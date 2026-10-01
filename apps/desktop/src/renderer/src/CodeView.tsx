import type React from 'react'
import { useMemo } from 'react'
import { codeText, gutterText, lineCount } from './docView'
import { useT } from './i18n'

interface Props {
  text: string
  /** Имя файла — для подписи области скринридеру. */
  name: string
  /** `<code>` с текстом — корень для ⌘F (`findInDoc`): номера строк в поиск не попадают. */
  codeRef?: React.Ref<HTMLElement>
  /** Прокручиваемая область — для `scrollToRange` и запоминания прокрутки в истории. */
  scrollRef?: React.Ref<HTMLDivElement>
  onScroll?(e: React.UIEvent<HTMLDivElement>): void
}

/**
 * Код и конфиги: моноширинно, без переноса, колонка номеров строк липнет слева. Текст — один текстовый узел React
 * (не innerHTML): файл проекта — недоверенные данные, а ⌘F ищет по DOM. Подсветки синтаксиса нет (решение по T6).
 * Номера — отдельный `<pre aria-hidden>`: не выделяются и не копируются вместе с кодом.
 */
export function CodeView({ text, name, codeRef, scrollRef, onScroll }: Props): React.JSX.Element {
  const t = useT()
  const shown = useMemo(() => codeText(text), [text])
  const lines = useMemo(() => lineCount(shown), [shown])
  const gutter = useMemo(() => gutterText(lines), [lines])
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
        <pre className="src"><code ref={codeRef}>{shown}</code></pre>
      </div>
    </div>
  )
}
