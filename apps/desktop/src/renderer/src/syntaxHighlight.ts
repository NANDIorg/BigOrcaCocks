import { refractor } from 'refractor/all'
import { docKindOf } from '../../shared/docs-view'

/** Только текст и span: атрибуты и HTML из файла никогда не становятся разметкой React. */
export type SyntaxNode = string | { className: string; children: SyntaxNode[] }

// Эти конфиги не входят в Prism; остальные языки используют готовые грамматики Refractor.
refractor.register(Object.assign((prism: typeof refractor) => {
  prism.languages.dotenv = {
    comment: { pattern: /(^|\s)#.*/m, lookbehind: true },
    keyword: /^\s*export\b/m,
    property: /^\s*[\w.-]+(?=\s*=)/m,
    string: { pattern: /"(?:\\.|[^"\\])*"|'[^']*'/, greedy: true },
    variable: /\$\{[^}]+\}|\$\w+/,
    boolean: /\b(?:true|false)\b/,
    number: /\b\d+(?:\.\d+)?\b/,
    operator: /=/
  }
}, { displayName: 'dotenv' }))

refractor.register(Object.assign((prism: typeof refractor) => {
  prism.languages.gitignore = {
    comment: /^#.*/m,
    keyword: /^!/m,
    operator: /\*\*?|\?|\[[^\]\r\n]+\]/,
    punctuation: /\//
  }
}, { displayName: 'gitignore' }))

refractor.register(Object.assign((prism: typeof refractor) => {
  prism.languages.gitattributes = {
    comment: /^#.*/m,
    property: { pattern: /(^|\s)[-!]?[\w-]+(?==|\s|$)/m, lookbehind: true },
    string: /"(?:\\.|[^"\\])*"/,
    operator: /[=*?]/
  }
}, { displayName: 'gitattributes' }))

refractor.register(Object.assign((prism: typeof refractor) => {
  prism.languages.fish = prism.languages.extend('bash', {
    keyword: /\b(?:and|begin|break|case|continue|else|end|for|function|if|in|not|or|return|set|switch|while)\b/
  })
}, { displayName: 'fish' }))

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  html: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', svelte: 'markup', astro: 'markup',
  mdx: 'markdown', shell: 'bash', zsh: 'bash', 'shell-session': 'shell-session', console: 'shell-session',
  'c++': 'cpp', 'c#': 'csharp', 'f#': 'fsharp', 'objective-c': 'objectivec',
  'protocol buffers': 'protobuf', terraform: 'hcl', gradle: 'groovy', dockerfile: 'docker',
  tex: 'latex', restructuredtext: 'rest', ini: 'ini', env: 'dotenv', jsonc: 'json5', tsv: 'csv'
}
const PLAIN_LANGUAGES = new Set(['text', 'txt', 'plain', 'plaintext', 'none'])
const MAX_HIGHLIGHT_LENGTH = 100_000
const MAX_HIGHLIGHT_NODES = 12_000

export interface SyntaxBudget { length: number; nodes: number }

/** Один бюджет на файл или весь Markdown-документ, а не отдельный кодовый блок. */
export function createSyntaxBudget(): SyntaxBudget {
  return { length: MAX_HIGHLIGHT_LENGTH, nodes: MAX_HIGHLIGHT_NODES }
}

function syntaxLanguage(language: string | undefined): string | undefined {
  const label = language?.trim().toLowerCase()
  const name = label && Object.hasOwn(LANGUAGE_ALIASES, label) ? label : label?.split(/\s+/, 1)[0]
  if (!name || PLAIN_LANGUAGES.has(name)) return undefined
  const resolved = Object.hasOwn(LANGUAGE_ALIASES, name) ? LANGUAGE_ALIASES[name] : name
  return refractor.registered(resolved) ? resolved : undefined
}

/** Общая классификация даёт названия языков; JSX и некоторые конфиги требуют более точной грамматики. */
export function syntaxLanguageOf(path: string): string | undefined {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).toLowerCase()
  if (name.endsWith('.tsx')) return 'tsx'
  if (name.endsWith('.jsx')) return 'jsx'
  if (/\.json[5c]$/.test(name)) return 'json5'
  if (name.endsWith('.fish')) return 'fish'
  if (name === 'cargo.lock' || name === 'poetry.lock' || name === 'uv.lock') return 'toml'
  return syntaxLanguage(docKindOf(path).language)
}

/**
 * Исходный текст сохраняется: выделение, копирование и поиск видят прежние строки.
 * Большие/минифицированные файлы и слишком подробное дерево остаются текстом, чтобы не подвесить renderer.
 */
export function highlightSyntax(text: string, language: string | undefined, budget = createSyntaxBudget()): SyntaxNode[] {
  const resolved = syntaxLanguage(language)
  if (!resolved || text.length > budget.length || budget.nodes <= 0 || /[^\r\n]{2001}/.test(text)) return [text]
  budget.length -= text.length
  try {
    let count = 0
    type Node = ReturnType<typeof refractor.highlight>['children'][number]
    const convert = (nodes: Node[]): SyntaxNode[] => nodes.map(node => {
      if (++count > budget.nodes) {
        budget.nodes = 0
        throw new Error('syntax node limit')
      }
      if (node.type === 'text') return node.value
      if (node.type !== 'element') return ''
      const classes = node.properties.className
      const className = Array.isArray(classes) ? classes.filter(value => typeof value === 'string' && /^[\w-]+$/.test(value)).join(' ') : ''
      return { className, children: convert(node.children) }
    })
    const nodes = convert(refractor.highlight(text, resolved).children)
    budget.nodes -= count
    return nodes
  } catch {
    // Ошибка грамматики не должна мешать человеку прочитать файл.
    return [text]
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
}

/** Только для Markdown.tsx: результат проходит через существующий DOMPurify вместе с документом. */
export function syntaxHtml(text: string, language: string | undefined, budget?: SyntaxBudget): string {
  const serialize = (nodes: SyntaxNode[]): string => nodes.map(node => typeof node === 'string'
    ? escapeHtml(node)
    : `<span class="${escapeHtml(node.className)}">${serialize(node.children)}</span>`).join('')
  return serialize(highlightSyntax(text, language, budget))
}
