import { Lexer, walkTokens, type Token, type Tokens } from 'marked'

/** Пункт колонки «На странице»: заголовок h2/h3 документа и id его элемента в DOM. */
export interface DocTocItem {
  level: 2 | 3
  text: string
  id: string
}

/**
 * Префикс DOM-id заголовков. Без него DOMPurify вырезал бы id вроде «title» или «links»
 * (защита от DOM clobbering), а слаги из документа могли бы совпасть с id самого приложения.
 */
export const DOC_ID_PREFIX = 'doc-'

/** Заголовок с проставленным id — его видит renderer в режиме документа. */
export type DocHeading = Tokens.Heading & { docId?: string }

/** Слаг как у GitHub: строчные, без пунктуации, пробелы → дефисы. Кириллица сохраняется. */
export function slugify(text: string): string {
  return text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')
}

/** Id для внутренней ссылки `#…` из документа: `#Раздел` и `#%D1%80…` ведут к тому же заголовку. */
export function anchorId(fragment: string): string {
  let raw = fragment.replace(/^#/, '')
  try {
    raw = decodeURIComponent(raw)
  } catch {
    // битый percent-encoding — ищем как есть
  }
  return DOC_ID_PREFIX + raw.toLowerCase()
}

/**
 * Заголовок документа по якорю: `#Раздел`, `#%D1%80…` и `#раздел` из другого документа
 * находят один и тот же элемент. Второй вариант — якорь, записанный текстом заголовка («#Роли и колонки»).
 */
export function findDocHeading(root: ParentNode, fragment: string): Element | null {
  const id = anchorId(fragment)
  const bySlug = DOC_ID_PREFIX + slugify(id.slice(DOC_ID_PREFIX.length))
  return [...root.querySelectorAll('[id]')].find((el) => el.id === id || el.id === bySlug) ?? null
}

/** Текст заголовка без markdown-разметки: `**Важно** и \`код\`` → «Важно и код». */
function plainText(tokens: Token[]): string {
  return tokens
    .map((t) => {
      if (t.type === 'html') return ''
      if ('tokens' in t && t.tokens) return plainText(t.tokens)
      return 'text' in t ? String(t.text) : ''
    })
    .join('')
}

/**
 * Проставляет `docId` заголовкам h2/h3 (в порядке документа, повторы — `-1`, `-2`)
 * и возвращает оглавление. Токены потом рендерятся — id в DOM и в оглавлении совпадают.
 */
export function assignHeadingIds(tokens: Token[]): DocTocItem[] {
  const seen = new Map<string, number>()
  const toc: DocTocItem[] = []
  walkTokens(tokens, (t) => {
    if (t.type !== 'heading' || (t.depth !== 2 && t.depth !== 3)) return
    const heading = t as DocHeading
    const text = plainText(heading.tokens).trim()
    const base = slugify(text) || 'section'
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    heading.docId = DOC_ID_PREFIX + (n ? `${base}-${n}` : base)
    toc.push({ level: heading.depth as 2 | 3, text, id: heading.docId })
  })
  return toc
}

/** Оглавление markdown-документа: h2/h3 с теми же id, что у заголовков в `<Markdown variant="doc">`. */
export function buildDocToc(markdown: string): DocTocItem[] {
  return assignHeadingIds(Lexer.lex(markdown, { gfm: true }))
}
