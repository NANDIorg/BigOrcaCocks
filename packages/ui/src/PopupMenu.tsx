import type React from 'react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { stepMenu } from './boardNav'
import { Icon } from './icons'
import { useT } from './i18n'
import { popupMenuKey } from './popupMenuNavigation'

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
  children?: PopupItem[]
  icon?: React.ReactNode
}

interface Props {
  /** Точка привязки (курсор или угол кнопки) в координатах окна. */
  x: number
  y: number
  ariaLabel: string
  items: PopupItem[]
  /** Меню приложения использует ту же клавиатуру и портал с более просторными строками. */
  variant?: 'application'
  header?: React.ReactNode
  loading?: boolean
  onPick(id: string): void
  /** true — сочетание уже обработано владельцем меню приложения. */
  onShortcut?(event: React.KeyboardEvent): boolean
  /** `restoreFocus` — вернуть фокус тому, что открыло меню: при Esc/Tab, но не при клике мимо. */
  onClose(restoreFocus: boolean): void
}

export const POPUP_MENU_WIDTH = 240

/**
 * Контекстное меню действий: рисуется порталом в `body` с `position: fixed`, чтобы не обрезаться прокруткой
 * сайдбара. Стрелки/Home/End — выбор, Enter и пробел — применить, Esc и Tab — закрыть (как `MoveMenu`).
 */
export function PopupMenu({ x, y, ariaLabel, items, variant, header, loading, onPick, onShortcut, onClose }: Props): React.JSX.Element {
  const t = useT()
  const id = useId()
  const ref = useRef<HTMLDivElement>(null)
  const [path, setPath] = useState<{ item: PopupItem; index: number }[]>([])
  const [active, setActive] = useState(() => stepMenu(items, -1, 1))
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const parent = path.at(-1)
  const levelItems = parent?.item.children ?? items
  const visibleItems: PopupItem[] = parent
    ? [{ id: `${id}-back`, label: t('shell.menu.back'), icon: <Icon.chevronLeft /> }, ...levelItems] : levelItems
  const width = variant === 'application' ? 304 : POPUP_MENU_WIDTH
  // Свежий onClose без пересоздания подписок на каждый рендер сайдбара.
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - Math.min(width, window.innerWidth - 16) - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - height - 8))
    })
  }, [x, y, width, levelItems, loading])

  useLayoutEffect(() => { ref.current?.focus({ preventScroll: true }) }, [x, y, path])

  useEffect(() => {
    if (!parent && (!items[active] || items[active].disabled)) setActive(stepMenu(items, -1, 1))
  }, [items, active, parent])

  useEffect(() => {
    const close = (): void => closeRef.current(false)
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    // Глобальная команда может открыть помощника/терминал и увести фокус без клика или window.blur.
    const onFocus = (e: FocusEvent): void => {
      if (variant === 'application' && !ref.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('focusin', onFocus)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    // Прокрутка самого меню (длинный список групп) его не закрывает — только прокрутка страницы под ним.
    const onScroll = (e: Event): void => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('focusin', onFocus)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [variant])

  const pick = (i: number): void => {
    const item = visibleItems[i]
    if (!item || item.disabled) return
    if (parent && i === 0) { back(); return }
    if (item.children?.length) {
      setPath([...path, { item, index: i }])
      setActive(stepMenu(item.children, -1, 1) + 1)
    } else onPick(item.id)
  }

  const back = (): void => {
    if (!parent) return
    setPath(path.slice(0, -1))
    setActive(parent.index)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (onShortcut?.(e)) { e.preventDefault(); e.stopPropagation(); return }
    if (e.ctrlKey || e.metaKey || e.altKey) {
      if (variant === 'application') e.stopPropagation()
      return
    }
    const action = popupMenuKey(visibleItems, active, e.key, !!parent)
    e.stopPropagation()
    if (action.kind === 'none') return
    e.preventDefault()
    if (action.kind === 'select') setActive(action.index)
    else if (action.kind === 'pick') pick(active)
    else if (action.kind === 'back') back()
    else onClose(true)
  }

  // Активный пункт всегда в видимой части: меню прокручивается, если групп много.
  useEffect(() => {
    document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [id, active, path])

  return createPortal(
    <div
      ref={ref}
      className={`popup-menu${variant === 'application' ? ' application-menu' : ''}`}
      role="menu"
      aria-label={parent?.item.label ?? ariaLabel}
      aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined}
      aria-busy={loading || undefined}
      tabIndex={-1}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, width, maxWidth: 'calc(100vw - 16px)', opacity: pos ? 1 : 0 }}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {(parent || header) && <div className="application-menu-header" role="presentation">{parent?.item.label ?? header}</div>}
      {loading && <div className="application-menu-loading" role="status">{t('common.loading')}</div>}
      {visibleItems.map((item, i) => (
        <div key={item.id} role="none">
          {item.separatorBefore && <div className="popup-menu-sep" role="separator" />}
          {item.heading && <div className="popup-menu-heading" role="presentation">{item.heading}</div>}
          <button
            id={`${id}-${i}`}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={`popup-menu-item${i === active ? ' on' : ''}${item.danger ? ' danger' : ''}`}
            aria-disabled={item.disabled || undefined}
            aria-haspopup={item.children?.length ? 'menu' : undefined}
            title={item.label}
            onMouseEnter={() => !item.disabled && setActive(i)}
            onClick={() => pick(i)}
          >
            {item.icon && <span className="popup-menu-icon" aria-hidden="true">{item.icon}</span>}
            <span className="popup-menu-name">{item.label}</span>
            {item.hint && <span className="popup-menu-hint">{item.hint}</span>}
            {!!item.children?.length && <span className="popup-menu-chevron" aria-hidden="true"><Icon.chevron /></span>}
          </button>
        </div>
      ))}
    </div>,
    document.body
  )
}
