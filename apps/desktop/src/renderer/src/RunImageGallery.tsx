import type React from 'react'
import { useState } from 'react'
import type { RunImage } from '@orca-board/core'
import { ImageAttachments } from './ImageAttachments'
import { ImageLightbox } from './ImageLightbox'
import { useRunImageUrls } from './useRunImageUrls'

interface Props {
  globalId: string
  images: readonly RunImage[]
  /** Убрать сохранённую картинку (правка до начала работы); нет — только просмотр. */
  onRemove?(imageId: string): void
  disabled?: boolean
}

/**
 * Сохранённые картинки глобальной задачи: миниатюры, по клику — увеличение. Использовать с `key` по id задачи
 * (`useRunImageUrls`). Ошибка чтения — строкой под миниатюрами.
 */
export function RunImageGallery({ globalId, images, onRemove, disabled }: Props): React.JSX.Element | null {
  const { urls, failed, error } = useRunImageUrls(globalId, images)
  const [open, setOpen] = useState<number | null>(null)
  if (images.length === 0) return null
  const loaded = images.filter((i) => urls.has(i.id))
  // Индекс миниатюры → индекс в списке загруженных: не загрузившиеся в просмотре пропускаются.
  const openLoaded = (i: number): void => setOpen(loaded.findIndex((l) => l.id === images[i].id))
  return (
    <>
      <ImageAttachments
        items={images.map((i) => ({ key: i.id, url: urls.get(i.id), failed: failed.has(i.id) }))}
        onOpen={openLoaded}
        onRemove={onRemove}
        disabled={disabled}
      />
      {error && <span className="error-text">{error}</span>}
      {open !== null && open >= 0 && (
        <ImageLightbox urls={loaded.map((i) => urls.get(i.id) ?? '')} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
      )}
    </>
  )
}
