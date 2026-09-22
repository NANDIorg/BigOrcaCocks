import type { DocFile, DocGroup } from '../../shared/ipc'

/** Чистые функции окна «Документы»: дерево папок из путей, поиск по пути, время и подписи. */

export interface DirNode {
  kind: 'dir'
  /** Имя папки; схлопнутая цепочка из одной папки — через `/` («apps/desktop/src»). */
  name: string
  /** Полный путь папки от корня источника — ключ свёрнутости. */
  path: string
  children: TreeNode[]
  /** Файлов во всём поддереве. */
  count: number
}

export interface FileNode {
  kind: 'file'
  name: string
  file: DocFile
}

export type TreeNode = DirNode | FileNode

const byName = (a: string, b: string): number => a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' })

/**
 * Дерево из плоского списка путей: папки сверху, затем файлы, оба по имени.
 * Папка, в которой только одна подпапка и нет файлов, схлопывается с ней в один узел.
 */
export function buildTree(files: DocFile[]): TreeNode[] {
  interface Raw { dirs: Map<string, Raw>; files: DocFile[] }
  const root: Raw = { dirs: new Map(), files: [] }
  for (const f of files) {
    const parts = f.path.split('/')
    let cur = root
    for (const seg of parts.slice(0, -1)) {
      let next = cur.dirs.get(seg)
      if (!next) cur.dirs.set(seg, (next = { dirs: new Map(), files: [] }))
      cur = next
    }
    cur.files.push(f)
  }
  const convert = (raw: Raw, prefix: string): TreeNode[] => {
    const dirs: DirNode[] = [...raw.dirs.entries()]
      .sort(([a], [b]) => byName(a, b))
      .map(([name, sub]) => {
        let label = name
        let path = prefix + name
        let node = sub
        while (node.files.length === 0 && node.dirs.size === 1) {
          const [childName, child] = [...node.dirs.entries()][0]
          label += '/' + childName
          path += '/' + childName
          node = child
        }
        const children = convert(node, path + '/')
        const count = children.reduce((n, c) => n + (c.kind === 'dir' ? c.count : 1), 0)
        return { kind: 'dir', name: label, path, children, count }
      })
    const fileNodes: FileNode[] = raw.files
      .map((f) => ({ kind: 'file' as const, name: f.path.slice(f.path.lastIndexOf('/') + 1), file: f }))
      .sort((a, b) => byName(a.name, b.name))
    return [...dirs, ...fileNodes]
  }
  return convert(root, '')
}

/** Папки-предки файла: «a/b/c.md» → ['a', 'a/b']. Среди них и ключи схлопнутых узлов. */
export function dirAncestors(path: string): string[] {
  const parts = path.split('/').slice(0, -1)
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'))
}

/** Длинная схлопнутая цепочка в дереве: «apps/desktop/src/renderer/logos» → «apps/desktop/…/logos». */
export function chainLabel(name: string): string {
  const parts = name.split('/')
  return parts.length > 3 ? `${parts[0]}/${parts[1]}/…/${parts[parts.length - 1]}` : name
}

export type Range = [start: number, end: number]

export interface PathMatch {
  /** Больше — лучше: совпадение в имени файла > в пути > по буквам вразбивку. */
  score: number
  /** Подсвечиваемые отрезки в полном пути, отсортированы и не пересекаются. */
  ranges: Range[]
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: Range[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

/** Буквы слова по порядку (не подряд), предпочитая имя файла. null — не нашлось. */
function subsequence(lower: string, word: string, from: number): Range[] | null {
  const out: Range[] = []
  let i = from
  for (const ch of word) {
    const at = lower.indexOf(ch, i)
    if (at < 0) return null
    const last = out[out.length - 1]
    if (last && last[1] === at) last[1] = at + 1
    else out.push([at, at + 1])
    i = at + 1
  }
  return out
}

/**
 * Поиск файла по пути без учёта регистра. Пробелы делят запрос на слова — нужны все.
 * Слово ищется подстрокой в имени файла, затем в пути, затем по буквам вразбивку (fuzzy).
 */
export function matchPath(path: string, query: string): PathMatch | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return null
  const lower = path.toLowerCase()
  const nameStart = path.lastIndexOf('/') + 1
  let score = 0
  const ranges: Range[] = []
  for (const w of words) {
    const inName = lower.indexOf(w, nameStart)
    if (inName >= 0) {
      score += inName === nameStart ? 4 : 3
      ranges.push([inName, inName + w.length])
      continue
    }
    const inPath = lower.indexOf(w)
    if (inPath >= 0) {
      score += 2
      ranges.push([inPath, inPath + w.length])
      continue
    }
    const fuzzy = subsequence(lower, w, nameStart) ?? subsequence(lower, w, 0)
    if (!fuzzy) return null
    // Чем меньше разрывов, тем ближе к подстроке.
    score += 1 / fuzzy.length
    ranges.push(...fuzzy)
  }
  return { score, ranges: mergeRanges(ranges) }
}

export interface Segment {
  text: string
  hit: boolean
}

/** Кусок `text` (начинается с позиции `offset` полного пути) на отрезки с подсветкой по `ranges`. */
export function highlight(text: string, ranges: Range[], offset = 0): Segment[] {
  const out: Segment[] = []
  let pos = 0
  for (const [s, e] of ranges) {
    const start = Math.max(0, s - offset)
    const end = Math.min(text.length, e - offset)
    if (end <= start || start >= text.length) continue
    if (start > pos) out.push({ text: text.slice(pos, start), hit: false })
    out.push({ text: text.slice(start, end), hit: true })
    pos = end
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false })
  return out
}

/** Все вхождения `query` в `text` без учёта регистра (не пересекаются). */
export function findAll(text: string, query: string): number[] {
  const q = query.toLowerCase()
  if (!q) return []
  const lower = text.toLowerCase()
  const out: number[] = []
  for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + q.length)) out.push(i)
  return out
}

const pad = (n: number): string => String(n).padStart(2, '0')
const dayStart = (ms: number): number => new Date(ms).setHours(0, 0, 0, 0)
const hhmm = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`

function dayLabel(ms: number, now: number): string | null {
  const days = Math.round((dayStart(now) - dayStart(ms)) / 86_400_000)
  return days === 0 ? 'сегодня' : days === 1 ? 'вчера' : null
}

function date(d: Date, now: number): string {
  const dm = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`
  return d.getFullYear() === new Date(now).getFullYear() ? dm : `${dm}.${String(d.getFullYear()).slice(2)}`
}

/** Коротко для дерева: сегодня — «14:32», вчера — «вчера», раньше — «18.09» (другой год — «18.09.25»). */
export function shortTime(ms: number, now: number): string {
  const d = new Date(ms)
  const day = dayLabel(ms, now)
  return day === 'сегодня' ? hhmm(d) : day ?? date(d, now)
}

/** Подробно: «сегодня в 14:32», «вчера в 19:05», «18.09 в 10:00». */
export function longTime(ms: number, now: number): string {
  const d = new Date(ms)
  return `${dayLabel(ms, now) ?? date(d, now)} в ${hhmm(d)}`
}

/** 1 файл, 2 файла, 5 файлов. */
export function plural(n: number, [one, few, many]: [string, string, string]): string {
  const m10 = n % 10
  const m100 = n % 100
  const word = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many
  return `${n} ${word}`
}

/** Время чтения, минуты (≈200 слов в минуту, не меньше 1). Блоки кода считаются как текст. */
export function readingMinutes(text: string): number {
  const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
  return Math.max(1, Math.round(words / 200))
}

/** Первый абзац текста документа для карточки: без frontmatter, заголовков, кода, таблиц и разметки. */
export function excerpt(md: string, max = 160): string {
  const lines = md.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n')
  const para: string[] = []
  let fence = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/^(```|~~~)/.test(line)) {
      fence = !fence
      if (para.length) break
      continue
    }
    if (fence) continue
    const skip = line === '' || /^(#|\||<|!\[|[-*_]{3,}$)/.test(line)
    if (skip) {
      if (para.length) break
      continue
    }
    para.push(line.replace(/^(>\s*|[-*+]\s+|\d+\.\s+)/, ''))
  }
  const text = para
    .join(' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/** Другие группы, где есть файл с тем же путём: «этот файл также изменён в задаче …». */
export function alsoIn(groups: DocGroup[], source: string, path: string): DocGroup[] {
  return groups.filter((g) => g.source !== source && g.files.some((f) => f.path === path))
}

/** Открытый (или открываемый) документ: источник (`project` или id задачи) и путь в нём. */
export interface DocRef {
  source: string
  path: string
}

/** Колонка доски, где сейчас задача-источник: цвет точки и название статуса. */
export interface TaskMark {
  color: string
  status: string
}

export const sameDoc = (a: DocRef | null | undefined, b: DocRef): boolean => a?.source === b.source && a.path === b.path
