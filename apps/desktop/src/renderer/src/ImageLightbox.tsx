import type React from 'react'
import { useEffect, useRef } from 'react'
import { useT } from './i18n'
import { Icon } from './icons'

interface Props {
  /** `blob:` URL картинок, которые уже загрузились, по порядку показа. */
  urls: string[]
  index: number
  onIndex(i: number): void
  onClose(): void
}

/**
 * Увеличенное изображение поверх экрана. Escape закрывает только оверлей (модалки под ним остаются),
 * ←/→ листают, клик по фону закрывает, фокус уходит на «Закрыть» и возвращается на прежнее место.
 */
export function ImageLightbox({ urls, index, onIndex, onClose }: Props): React.JSX.Element | null {
  const t = useT()
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
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft' && at > 0) onIndex(at - 1)
      else if (e.key === 'ArrowRight' && at < last) onIndex(at + 1)
      else return
      e.stopImmediatePropagation()
      e.preventDefault()
    }
    // Захват на window: раньше обработчиков модалок, которые тоже закрываются по Escape.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  if (urls.length === 0) return null
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={t('common.image.viewer', { n: at + 1, total: urls.length })} onClick={onClose}>
      <img src={urls[at]} alt={t('common.image.alt', { n: at + 1 })} onClick={(e) => e.stopPropagation()} />
      <button ref={closeRef} type="button" className="lightbox-btn lightbox-close" title={t('common.close')} aria-label={t('common.close')} onClick={onClose}>
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
    </div>
  )
}
