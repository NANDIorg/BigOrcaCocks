import type React from 'react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useT } from './i18n'
import { Icon } from './icons'
import { viewerKeyAction } from './imageViewer'

interface Props {
  /** `blob:` URL картинок, которые уже загрузились, по порядку показа. */
  urls: string[]
  index: number
  onIndex(i: number): void
  onClose(): void
}

/**
 * Изображение на весь экран поверх всего. Рисуется порталом в `body`: миниатюры лежат и в панели Инбокса
 * (свой z-index и `transform` — для `position: fixed` это чужой слой и containing block). Пока открыт, забирает
 * клавиатуру: Escape закрывает только его (модалки под ним проверяют `lightboxOpen()`), ←/→ листают, Tab ходит
 * по его кнопкам, остальные клавиши до доски и вкладок под ним не доходят. Клик по фону закрывает; клики не
 * всплывают по React-дереву в карточку, из которой открыт просмотр. Фокус — на «Закрыть», при закрытии возвращается.
 */
export function ImageLightbox({ urls, index, onIndex, onClose }: Props): React.JSX.Element | null {
  const t = useT()
  const rootRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const last = urls.length - 1
  const at = Math.min(Math.max(index, 0), last)

  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    return () => prev?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const action = viewerKeyAction(e.key, at, last)
      if (action.kind === 'pass') {
        // Tab — по кругу между кнопками оверлея, не под него.
        const buttons = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
        if (buttons.length === 0) return
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = e.shiftKey ? (i <= 0 ? buttons.length - 1 : i - 1) : (i + 1) % buttons.length
        buttons[next].focus()
        e.preventDefault()
        e.stopImmediatePropagation()
        return
      }
      e.stopImmediatePropagation()
      // Остальные клавиши не отменяем: Enter и пробел на сфокусированной кнопке должны её нажать.
      if (action.kind === 'swallow') return
      e.preventDefault()
      if (action.kind === 'close') onClose()
      else onIndex(action.index)
    }
    // Захват на window: раньше обработчиков модалок, доски и вкладок.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  if (urls.length === 0) return null
  const stop = (e: React.SyntheticEvent): void => e.stopPropagation()
  return createPortal(
    <div
      ref={rootRef}
      // Литерал, а не LIGHTBOX_CLASS: windowDrag.test.ts ищет класс диалога в тексте разметки (защита от drag-областей
      // шапок на macOS); совпадение с константой проверяет imageViewer.test.ts.
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t('common.image.viewer', { n: at + 1, total: urls.length })}
      onClick={(e) => {
        e.stopPropagation()
        onClose()
      }}
      onMouseDown={stop}
      onPointerDown={stop}
    >
      <img src={urls[at]} alt={t('common.image.alt', { n: at + 1 })} onClick={stop} />
      <button ref={closeRef} type="button" className="lightbox-btn lightbox-close" title={t('common.close')} aria-label={t('common.close')} onClick={(e) => { e.stopPropagation(); onClose() }}>
        <Icon.close />
      </button>
      {at > 0 && (
        <button type="button" className="lightbox-btn lightbox-prev" title={t('common.image.prev')} aria-label={t('common.image.prev')} onClick={(e) => { e.stopPropagation(); onIndex(at - 1) }}>
          ‹
        </button>
      )}
      {at < last && (
        <button type="button" className="lightbox-btn lightbox-next" title={t('common.image.next')} aria-label={t('common.image.next')} onClick={(e) => { e.stopPropagation(); onIndex(at + 1) }}>
          ›
        </button>
      )}
      {urls.length > 1 && (
        <span className="lightbox-count" aria-hidden="true">
          {t('common.image.counter', { n: at + 1, total: urls.length })}
        </span>
      )}
    </div>,
    document.body
  )
}
