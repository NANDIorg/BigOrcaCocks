import { stepMenu } from './boardNav'

interface Item { disabled?: boolean; children?: readonly Item[] }
type MenuKeyResult = { kind: 'select'; index: number } | { kind: 'pick' | 'back' | 'close' | 'none' }

/** Одна клавиатура для плоских контекстных меню и разделов меню приложения. */
export function popupMenuKey(items: readonly Item[], active: number, key: string, nested: boolean): MenuKeyResult {
  if (key === 'Escape') return { kind: nested ? 'back' : 'close' }
  if (key === 'Tab') return { kind: 'close' }
  if (key === 'ArrowLeft') return { kind: nested ? 'back' : 'none' }
  if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End') {
    const index = key === 'Home' ? stepMenu(items, -1, 1) : key === 'End' ? stepMenu(items, 0, -1)
      : stepMenu(items, active, key === 'ArrowDown' ? 1 : -1)
    return index >= 0 ? { kind: 'select', index } : { kind: 'none' }
  }
  const item = items[active]
  if (item && !item.disabled && (key === 'Enter' || key === ' ' || (key === 'ArrowRight' && item.children?.length))) return { kind: 'pick' }
  return { kind: 'none' }
}

interface ShortcutItem {
  id: string
  hint?: string
  disabled?: boolean
  children?: readonly ShortcutItem[]
}
interface ShortcutKey { key: string; code?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }

/** Латинская клавиша сохраняет раскладку (в том числе Y/Z); нелатинская использует физический код. */
function shortcutKey(event: ShortcutKey): string {
  const key = event.key.toLowerCase()
  if (/^[a-z0-9,+-]$/.test(key)) return key
  if (/^Key[A-Z]$/.test(event.code ?? '')) return event.code!.slice(3).toLowerCase()
  if (/^(Digit|Numpad)\d$/.test(event.code ?? '')) return event.code!.slice(-1)
  if (event.code === 'Comma') return ','
  if (event.code === 'Equal' || event.code === 'NumpadAdd') return '+'
  if (event.code === 'Minus' || event.code === 'NumpadSubtract') return '-'
  return key
}

/** Сочетания открытого меню выполняются после возврата выделения, а не по фокусу внутри popup. */
export function popupMenuShortcut(items: readonly ShortcutItem[], event: ShortcutKey): string | undefined {
  for (const item of items) {
    if (item.disabled) continue
    if (item.children) {
      const id = popupMenuShortcut(item.children, event)
      if (id) return id
      continue
    }
    if (!item.hint) continue
    const parts = item.hint.split('+')
    const key = item.hint.endsWith('++') ? '+' : parts.at(-1)?.toLowerCase()
    const shift = parts.includes('Shift')
    if (key === shortcutKey(event) && event.ctrlKey === parts.includes('Ctrl') && event.altKey === parts.includes('Alt')
      && !event.metaKey && (event.shiftKey === shift || (key === '+' && !shift))) return item.id
  }
  return undefined
}
