import type React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { menuIndexForKey, stepMenu } from './boardNav'
import { useT } from './i18n'

/** Колонка, куда можно перенести карточку. `disabled` — колонка, где карточка уже лежит. */
export interface MoveTarget {
  id: string
  title: string
  color: string
  disabled?: boolean
}

interface Props {
  /** Карточка, к которой привязано меню: рядом с ней оно и появляется. */
  anchor: HTMLElement
  targets: MoveTarget[]
  onPick(id: string): void
  /**
   * Закрыть без выбора. `restoreFocus` — вернуть фокус карточке: так при Esc/Tab (клавиатура), но не при клике
   * мимо или прокрутке — там фокус уже у того, куда человек кликнул.
   */
  onClose(restoreFocus: boolean): void
}

const WIDTH = 216

/**
 * Меню «Переместить в…»: перенос карточки без мыши. Цифры 1–9 — номер колонки, стрелки и Enter — выбор,
 * Esc — закрыть. Рисуется в `body` (порталом) с `position: fixed`: у колонки своя прокрутка, и внутри неё меню
 * обрезалось бы у нижнего края.
 */
export function MoveMenu({ anchor, targets, onPick, onClose }: Props): React.JSX.Element {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(() => Math.max(targets.findIndex((t) => !t.disabled), 0))
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  // Свежий onClose без пересоздания подписок на каждый рендер доски.
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect()
    const height = ref.current?.offsetHeight ?? 0
    const left = Math.max(8, Math.min(rect.right - WIDTH - 8, window.innerWidth - WIDTH - 8))
    const top = Math.max(8, Math.min(rect.top + 32, window.innerHeight - height - 8))
    setPos({ left, top })
    ref.current?.focus({ preventScroll: true })
  }, [anchor])

  useEffect(() => {
    const close = (): void => closeRef.current(false)
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    // Прокрутка колонки уводит карточку из-под меню — закрываем, а не таскаем его следом.
    document.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [])

  const pick = (i: number): void => {
    const t = targets[i]
    if (t && !t.disabled) onPick(t.id)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const byDigit = menuIndexForKey(e.key, targets)
    if (byDigit !== undefined) {
      e.preventDefault()
      e.stopPropagation()
      pick(byDigit)
      return
    }
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault()
        e.stopPropagation()
        const next = stepMenu(targets, active, e.key === 'ArrowDown' ? 1 : -1)
        if (next >= 0) setActive(next)
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
        // defaultPrevented — чтобы глобальный Escape («назад к общей доске») не сработал заодно.
        e.preventDefault()
        e.stopPropagation()
        onClose(true)
        return
      default:
        // Остальные клавиши доске не нужны, пока открыто меню.
        e.stopPropagation()
    }
  }

  return createPortal(
    <div
      ref={ref}
      className="move-menu"
      role="menu"
      aria-label={t('board.move.aria')}
      aria-activedescendant={`move-menu-${active}`}
      tabIndex={-1}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, width: WIDTH, opacity: pos ? 1 : 0 }}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="move-menu-title">{t('board.move.title')}</div>
      {targets.map((target, i) => (
        <button
          key={target.id}
          id={`move-menu-${i}`}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={`move-menu-item ${i === active ? 'on' : ''}`}
          aria-disabled={target.disabled || undefined}
          onMouseEnter={() => !target.disabled && setActive(i)}
          onClick={() => pick(i)}
        >
          <span className="sw" style={{ background: target.color }} aria-hidden />
          <span className="move-menu-name">{target.title}</span>
          {target.disabled ? <span className="k">{t('board.move.here')}</span> : i < 9 && <kbd className="k">{i + 1}</kbd>}
        </button>
      ))}
    </div>,
    document.body
  )
}
