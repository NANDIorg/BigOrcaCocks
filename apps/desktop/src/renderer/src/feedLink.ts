/**
 * Связка ленты «Ждут вас» и доски подзадач. Лента и доска — соседи на экране глобальной задачи, друг друга не
 * импортируют и общего родителя с колбэками не имеют (доска приходит в `GlobalTaskView` как `children`), поэтому
 * говорят через события окна. Отправить можно откуда угодно: нет получателя (ленты нет, доска не открыта) —
 * ничего не происходит.
 */

const EVENTS = {
  revealInFeed: 'orca:feed-reveal',
  revealOnBoard: 'orca:board-reveal',
  focusFeed: 'orca:feed-focus',
  focusBoard: 'orca:board-focus'
} as const

type LinkEvent = keyof typeof EVENTS

function send(name: LinkEvent, taskId?: string): void {
  window.dispatchEvent(new CustomEvent(EVENTS[name], { detail: { taskId } }))
}

function listen(name: LinkEvent, handler: (taskId: string | undefined) => void): () => void {
  const listener = (e: Event): void => handler((e as CustomEvent<{ taskId?: string }>).detail?.taskId)
  window.addEventListener(EVENTS[name], listener)
  return () => window.removeEventListener(EVENTS[name], listener)
}

/** «в ленте ↑» на карточке доски: прокрутить ленту к пункту задачи и подсветить его. */
export const revealInFeed = (taskId: string): void => send('revealInFeed', taskId)
export const onRevealInFeed = (handler: (taskId: string) => void): (() => void) =>
  listen('revealInFeed', (id) => id !== undefined && handler(id))

/** Имя задачи в карточке ленты: выделить карточку на доске и прокрутить к ней. */
export const revealOnBoard = (taskId: string): void => send('revealOnBoard', taskId)
export const onRevealOnBoard = (handler: (taskId: string) => void): (() => void) =>
  listen('revealOnBoard', (id) => id !== undefined && handler(id))

/** Клавиша G: фокус в ленту / обратно на доску. */
export const focusFeed = (): void => send('focusFeed')
export const onFocusFeed = (handler: () => void): (() => void) => listen('focusFeed', handler)
export const focusBoard = (): void => send('focusBoard')
export const onFocusBoard = (handler: () => void): (() => void) => listen('focusBoard', handler)

/** Плавная прокрутка к найденному — если человек не просил убрать анимацию. */
export function scrollBehavior(): ScrollBehavior {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}
