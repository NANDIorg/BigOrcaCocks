/**
 * Клавиши экрана глобальной задачи (`GlobalTaskView`): Esc — назад к общей доске, G — переход между лентой
 * «Ждут вас» и доской, Alt+1…4 (и 1…4 вне доски) — вкладки экрана. Решение «наша ли это клавиша» — здесь, чистой функцией: один обработчик на экран, а не
 * по своему в ленте и на доске. Клавиши доски (стрелки, Enter, M, S) — отдельно, в `boardNav.ts`.
 */

/** Элемент события — ровно то, что нужно проверке; настоящий `HTMLElement` подходит. */
export interface HotkeyTarget {
  tagName: string
  isContentEditable?: boolean
  /** Есть у `HTMLElement`: поле ввода бывает и предком (contenteditable), и самим элементом. */
  closest?(selector: string): unknown
}

export interface HotkeyEvent {
  key: string
  /** Физическая клавиша: G работает и в русской раскладке. */
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  defaultPrevented: boolean
  /** У настоящего `KeyboardEvent` это `EventTarget`: не элемент (окно, документ) вводом не считается. */
  target: HotkeyTarget | EventTarget | null
}

const TYPING_SELECTOR = 'input, textarea, select, [contenteditable]'
const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/** Идёт ли ввод: поле, выпадающий список или редактируемый блок (в том числе вложенный в него элемент). */
export function isTypingTarget(target: HotkeyTarget | EventTarget | null): boolean {
  if (!target || !('tagName' in target)) return false
  const el = target
  if (TYPING_TAGS.has(el.tagName.toUpperCase()) || el.isContentEditable === true) return true
  return !!el.closest?.(TYPING_SELECTOR)
}

/** Что сделать по клавише экрана: `back` — к общей доске, `feed` — лента ↔ доска. */
export type ScreenKey = 'back' | 'feed'

/**
 * Клавиша экрана или `undefined`, если её не трогаем: уже обработана кем-то ближе (`defaultPrevented` — меню,
 * подробности ленты, поле ввода со своим Esc), нажат модификатор, идёт ввод или поверх открыта модалка (она
 * ловит клавиши сама).
 */
export function screenKey(e: HotkeyEvent, modalOpen: boolean): ScreenKey | undefined {
  if (e.defaultPrevented || modalOpen || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return undefined
  if (e.key === 'Escape') return e.shiftKey ? undefined : 'back'
  if (e.code === 'KeyG' && !e.shiftKey) return 'feed'
  return undefined
}

/** Где цифры — не про вкладки: доска и лента (свои клавиши) и меню «Переместить в…» (цифра = номер колонки). */
const DIGIT_OWNERS = '.board-wrap, .attn, [role="menu"]'

/** Число вкладок экрана, на которые есть цифра (1–4). */
export const TAB_HOTKEYS = 4

/**
 * Номер вкладки (с 0) по клавише или `undefined`. Alt+1…4 работает везде, кроме полей ввода и модалок; голые 1…4 —
 * только когда фокус не на доске, не в ленте и не в меню «Переместить в…»: там цифры принадлежат им (M → 1–9).
 * Цифру берём по физической клавише (`code`): с Alt на macOS `key` — другой символ, а в русской раскладке цифры те же.
 */
export function tabKey(e: HotkeyEvent, modalOpen: boolean): number | undefined {
  if (e.defaultPrevented || modalOpen || e.ctrlKey || e.metaKey || e.shiftKey || isTypingTarget(e.target)) return undefined
  const m = /^Digit([1-9])$/.exec(e.code)
  if (!m) return undefined
  const index = Number(m[1]) - 1
  if (index >= TAB_HOTKEYS) return undefined
  if (e.altKey) return index
  const owned = e.target !== null && 'tagName' in e.target && !!e.target.closest?.(DIGIT_OWNERS)
  return owned ? undefined : index
}
