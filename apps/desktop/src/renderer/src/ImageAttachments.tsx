import type React from 'react'
import { useT } from './i18n'

/** Одна миниатюра: `url` нет — ещё грузится (или `failed`). */
export interface ImageThumb {
  key: string
  url?: string
  failed?: boolean
}

interface Props {
  items: ImageThumb[]
  /** Сколько файлов ещё читается — плитка-заглушка в конце ряда. */
  reading?: number
  /** Убрать картинку; нет — миниатюры только для просмотра. */
  onRemove?(key: string): void
  /** Клик или Enter по миниатюре — увеличить; нет — миниатюра не кликабельна. */
  onOpen?(index: number): void
  disabled?: boolean
}

/**
 * Ряд миниатюр картинок с кнопкой удаления и (по желанию) открытием. Общий для вставки (`CoordinatorModal`,
 * `GlobalTaskModal`) и просмотра сохранённых картинок задачи.
 */
export function ImageAttachments({ items, reading = 0, onRemove, onOpen, disabled = false }: Props): React.JSX.Element | null {
  const t = useT()
  if (items.length === 0 && reading === 0) return null
  return (
    <div className="coord-images">
      {items.map((img, i) => (
        <div key={img.key} className="coord-image">
          {img.url && onOpen ? (
            <button type="button" className="coord-image-open" title={t('common.image.open', { n: i + 1 })} aria-label={t('common.image.open', { n: i + 1 })} onClick={() => onOpen(i)}>
              <img src={img.url} alt={t('common.image.alt', { n: i + 1 })} />
            </button>
          ) : img.url ? (
            <img src={img.url} alt={t('common.image.alt', { n: i + 1 })} />
          ) : (
            <div className="coord-image-loading" role="img" aria-label={t('common.image.alt', { n: i + 1 })} title={img.failed ? t('common.image.loadFailed') : undefined}>
              {img.failed ? '!' : '…'}
            </div>
          )}
          {onRemove && (
            <button
              type="button"
              className="coord-image-remove"
              title={t('common.image.remove')}
              aria-label={t('common.image.removeN', { n: i + 1 })}
              disabled={disabled}
              onClick={() => onRemove(img.key)}
            >
              ×
            </button>
          )}
        </div>
      ))}
      {reading > 0 && <div className="coord-image coord-image-loading">…</div>}
    </div>
  )
}
