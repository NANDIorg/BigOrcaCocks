import type React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { stepMenu } from './boardNav'

/** Пункт меню. `heading` — небольшой заголовок раздела над пунктом, `separatorBefore` — линия над ним. */
export interface PopupItem {
  id: string
  label: string
  /** Справа: «здесь» у текущего места. */
  hint?: string
  disabled?: boolean
  danger?: boolean
  heading?: string
  separatorBefore?: boolean
}

interface Props {
  /** Точка привязки (курсор или угол кнопки) в координатах окна. */
  x: number
  y: number
  ariaLabel: string
  items: PopupItem[]
  onPick(id: string): void
  /** `restoreFocus` — вернуть фокус тому, что открыло меню: при Esc/Tab, но не при клике мимо. */
  onClose(restoreFocus: boolean): void
}

export const POPUP_MENU_WIDTH = 240

/**
 * Контекстное меню действий: рисуется порталом в `body` с `position: fixed`, чтобы не обрезаться прокруткой
 * сайдбара. Стрелки/Home/End — выбор, Enter и пробел — применить, Esc и Tab — закрыть (как `MoveMenu`).
 */
export function PopupMenu({ x, y, ariaLabel, items, onPick, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(() => Math.max(items.findIndex((i) => !i.disabled), 0))
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  // Свежий onClose без пересоздания подписок на каждый рендер сайдбара.
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - POPUP_MENU_WIDTH - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - height - 8))
    })
    ref.current?.focus({ preventScroll: true })
  }, [x, y])

  useEffect(() => {
    const close = (): void => closeRef.current(false)
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    // Прокрутка самого меню (длинный список групп) его не закрывает — только прокрутка страницы под ним.
    const onScroll = (e: Event): void => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [])

  const pick = (i: number): void => {
    const item = items[i]
    if (item && !item.disabled) onPick(item.id)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault()
        e.stopPropagation()
        const next = stepMenu(items, active, e.key === 'ArrowDown' ? 1 : -1)
        if (next >= 0) setActive(next)
        return
      }
      case 'Home':
      case 'End': {
        e.preventDefault()
        e.stopPropagation()
        const ordered = e.key === 'Home' ? items : [...items].reverse()
        const first = ordered.find((i) => !i.disabled)
        if (first) setActive(items.indexOf(first))
        return
      }
      case 'Enter':
      case ' ':
        e.preventDefault()
        e.stopPropagation()
        pick(active)
        return
      case 'Escape':
      case 'Tab':
        e.preventDefault()
        e.stopPropagation()
        onClose(true)
        return
      default:
        e.stopPropagation()
    }
  }

  // Активный пункт всегда в видимой части: меню прокручивается, если групп много.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(`#popup-menu-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return createPortal(
    <div
      ref={ref}
      className="popup-menu"
      role="menu"
      aria-label={ariaLabel}
      aria-activedescendant={`popup-menu-${active}`}
      tabIndex={-1}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, width: POPUP_MENU_WIDTH, opacity: pos ? 1 : 0 }}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <div key={item.id} role="none">
          {item.separatorBefore && <div className="popup-menu-sep" role="separator" />}
          {item.heading && <div className="popup-menu-heading" role="presentation">{item.heading}</div>}
          <button
            id={`popup-menu-${i}`}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={`popup-menu-item${i === active ? ' on' : ''}${item.danger ? ' danger' : ''}`}
            aria-disabled={item.disabled || undefined}
            title={item.label}
            onMouseEnter={() => !item.disabled && setActive(i)}
            onClick={() => pick(i)}
          >
            <span className="popup-menu-name">{item.label}</span>
            {item.hint && <span className="popup-menu-hint">{item.hint}</span>}
          </button>
        </div>
      ))}
    </div>,
    document.body
  )
}
