import type React from 'react'
import { useState } from 'react'
import { useT } from './i18n'
import { ImageLightbox } from './ImageLightbox'
import { viewerItems, type ViewerThumb } from './imageViewer'

/** Одна миниатюра: `url` нет — ещё грузится (или `failed`). */
export type ImageThumb = ViewerThumb

interface Props {
  items: ImageThumb[]
  /** Сколько файлов ещё читается — плитка-заглушка в конце ряда. */
  reading?: number
  /** Убрать картинку; нет — миниатюры только для просмотра. */
  onRemove?(key: string): void
  disabled?: boolean
  /** Тесное место (карточка запроса, лента): 48 px вместо 72. */
  compact?: boolean
}

/**
 * Ряд миниатюр приложенных картинок: клик открывает картинку на весь экран (`ImageLightbox`), «×» убирает.
 * Общий для всех мест с вложениями: вставка в цель координатора и глобальную задачу, сохранённые картинки задачи
 * (`RunImageGallery`), поля замечаний (`ImageAttachField`). Открытую картинку помним по ключу — просмотр
 * переживает удаление соседней.
 */
export function ImageAttachments({ items, reading = 0, onRemove, disabled = false, compact = false }: Props): React.JSX.Element | null {
  const t = useT()
  const [openKey, setOpenKey] = useState<string | null>(null)
  if (items.length === 0 && reading === 0) return null
  const viewer = viewerItems(items, openKey)
  return (
    <div className={compact ? 'attach-images compact' : 'attach-images'}>
      {items.map((img, i) => (
        <div key={img.key} className="attach-image">
          {img.url && !img.failed ? (
            <button
              type="button"
              className="attach-image-open"
              title={t('common.image.open', { n: i + 1 })}
              aria-label={t('common.image.open', { n: i + 1 })}
              onClick={(e) => {
                // Карточка запроса кликабельна целиком — клик по миниатюре не должен её выбирать.
                e.stopPropagation()
                setOpenKey(img.key)
              }}
            >
              <img src={img.url} alt={t('common.image.alt', { n: i + 1 })} decoding="async" />
            </button>
          ) : (
            <div className="attach-image-loading" role="img" aria-label={t('common.image.alt', { n: i + 1 })} title={img.failed ? t('common.image.loadFailed') : undefined}>
              {img.failed ? '!' : '…'}
            </div>
          )}
          {onRemove && (
            <button
              type="button"
              className="attach-image-remove"
              title={t('common.image.remove')}
              aria-label={t('common.image.removeN', { n: i + 1 })}
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation()
                onRemove(img.key)
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
      {reading > 0 && (
        <div className="attach-image">
          <div className="attach-image-loading">…</div>
        </div>
      )}
      {viewer && <ImageLightbox urls={viewer.urls} index={viewer.index} onIndex={(j) => setOpenKey(viewer.keys[j] ?? null)} onClose={() => setOpenKey(null)} />}
    </div>
  )
}
