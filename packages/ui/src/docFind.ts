import { findAll } from './docTree'

/**
 * Поиск в тексте открытого документа по отрендеренному DOM: совпадения — DOM Range,
 * подсветка — CSS Custom Highlight API (разметку Markdown не трогаем).
 */

interface TextIndex {
  text: string
  nodes: Text[]
  starts: number[]
}

function indexText(root: Element): TextIndex {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ''
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text)
    starts.push(text.length)
    text += n.nodeValue ?? ''
  }
  return { text, nodes, starts }
}

/** Узел и смещение для позиции в общем тексте; `end` — конец отрезка (граница уходит в левый узел). */
function locate(idx: TextIndex, pos: number, end: boolean): [Text, number] {
  let lo = 0
  let hi = idx.nodes.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (end ? idx.starts[mid] < pos : idx.starts[mid] <= pos) lo = mid
    else hi = mid - 1
  }
  return [idx.nodes[lo], pos - idx.starts[lo]]
}

export interface TextMatch {
  range: Range
  before: string
  match: string
  after: string
  /** Текст ближайшего заголовка h1–h3 перед совпадением. */
  section: string
}

const BEFORE = 16
const AFTER = 48

export function findInDoc(root: Element | null, query: string): TextMatch[] {
  const q = query.trim()
  if (!root || !q) return []
  const idx = indexText(root)
  const headings = [...root.querySelectorAll('h1, h2, h3')]
  return findAll(idx.text, q).map((at) => {
    const range = document.createRange()
    const [sn, so] = locate(idx, at, false)
    const [en, eo] = locate(idx, at + q.length, true)
    range.setStart(sn, so)
    range.setEnd(en, eo)
    let section = ''
    for (const h of headings) {
      if (h.compareDocumentPosition(sn) & Node.DOCUMENT_POSITION_FOLLOWING) section = headingText(h)
      else break
    }
    const flat = (s: string): string => s.replace(/\s+/g, ' ')
    return {
      range,
      before: (at > BEFORE ? '…' : '') + flat(idx.text.slice(Math.max(0, at - BEFORE), at)).trimStart(),
      match: idx.text.slice(at, at + q.length),
      after: flat(idx.text.slice(at + q.length, at + q.length + AFTER)).trimEnd() + '…',
      section
    }
  })
}

/** Текст заголовка без значка-якоря «#». */
export function headingText(h: Element): string {
  return (h.textContent ?? '').replace(/^#\s*|\s*#$/g, '').trim()
}

const HL_ALL = 'docs-find'
const HL_CUR = 'docs-find-cur'

/** Подсветить совпадения (текущее — отдельно). Без поддержки Highlight API — молча ничего. */
export function paintMatches(ranges: Range[], current: number): void {
  if (typeof Highlight === 'undefined' || !CSS.highlights) return
  CSS.highlights.set(HL_ALL, new Highlight(...ranges))
  if (ranges[current]) CSS.highlights.set(HL_CUR, new Highlight(ranges[current]))
  else CSS.highlights.delete(HL_CUR)
}

export function clearMatches(): void {
  if (typeof Highlight === 'undefined' || !CSS.highlights) return
  CSS.highlights.delete(HL_ALL)
  CSS.highlights.delete(HL_CUR)
}

/** Прокрутить контейнер так, чтобы отрезок оказался на трети высоты. */
export function scrollToRange(container: HTMLElement, range: Range): void {
  const r = range.getBoundingClientRect()
  const c = container.getBoundingClientRect()
  if (r.top >= c.top + 40 && r.bottom <= c.bottom - 40) return
  container.scrollTop += r.top - c.top - c.height / 3
}
