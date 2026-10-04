import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), details > summary:first-of-type, [tabindex]:not([tabindex="-1"])'
const inertOwners = new WeakMap<HTMLElement, { count: number; previous: boolean }>()

function isolate(element: HTMLElement): () => void {
  const state = inertOwners.get(element) ?? { count: 0, previous: element.inert }
  state.count++
  inertOwners.set(element, state)
  element.inert = true
  return () => {
    state.count--
    if (state.count === 0) {
      element.inert = state.previous
      inertOwners.delete(element)
    }
  }
}

/** Изолирует активную модалку; при вложенном диалоге отдаёт ему фокус и восстанавливает фон. */
export function useModalFocus(ref: RefObject<HTMLElement | null>, suspended = false, fallbackSelector?: string): void {
  const lastFocused = useRef<HTMLElement | null>(null)
  // Сохраняем инициатора до commit: дочерний autoFocus уже сдвинет фокус к моменту useEffect.
  const previousFocused = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  useEffect(() => {
    return () => {
      // React сначала снимает inert и удаляет диалог, затем возвращаем фокус инициатору.
      queueMicrotask(() => {
        const previous = previousFocused.current
        const target = previous?.isConnected && previous !== document.body ? previous : fallbackSelector ? document.querySelector<HTMLElement>(fallbackSelector) : null
        target?.focus({ preventScroll: true })
      })
    }
  }, [fallbackSelector])

  useEffect(() => {
    const modal = ref.current
    if (!modal || suspended) return
    const release: Array<() => void> = []
    let child: HTMLElement = modal
    while (child.parentElement && child.parentElement !== document.documentElement) {
      for (const sibling of child.parentElement.children) {
        if (!(sibling instanceof HTMLElement) || sibling === child || /^(SCRIPT|STYLE|LINK)$/.test(sibling.tagName)) continue
        release.push(isolate(sibling))
      }
      child = child.parentElement
    }
    const controls = (): HTMLElement[] => Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter(element => element.getClientRects().length > 0 && !element.closest('[inert]'))
    const remembered = lastFocused.current
    const initial = remembered?.isConnected && modal.contains(remembered) && !remembered.matches(':disabled')
      ? remembered : modal.querySelector<HTMLElement>('[data-modal-autofocus]') ?? controls()[0] ?? modal
    initial.focus({ preventScroll: true })
    const onFocus = (event: FocusEvent): void => {
      if (event.target instanceof HTMLElement && modal.contains(event.target)) lastFocused.current = event.target
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const list = controls()
      const index = list.indexOf(document.activeElement as HTMLElement)
      if (!list.length || index < 0 || (event.shiftKey ? index === 0 : index === list.length - 1)) {
        event.preventDefault()
        ;(event.shiftKey ? list.at(-1) : list[0])?.focus({ preventScroll: true })
      }
    }
    document.addEventListener('keydown', onKey, true)
    modal.addEventListener('focusin', onFocus)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      modal.removeEventListener('focusin', onFocus)
      for (const restore of release) restore()
    }
  }, [ref, suspended])
}
