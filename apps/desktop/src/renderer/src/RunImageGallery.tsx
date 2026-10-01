import type React from 'react'
import type { RunImage } from '@orca-board/core'
import { ImageAttachments } from './ImageAttachments'
import { useRunImageUrls } from './useRunImageUrls'

interface Props {
  globalId: string
  images: readonly RunImage[]
  /** Убрать сохранённую картинку (правка до начала работы); нет — только просмотр. */
  onRemove?(imageId: string): void
  disabled?: boolean
}

/**
 * Сохранённые картинки глобальной задачи: миниатюры, по клику — на весь экран (это делает `ImageAttachments`).
 * Использовать с `key` по id задачи (`useRunImageUrls`). Ошибка чтения — строкой под миниатюрами.
 */
export function RunImageGallery({ globalId, images, onRemove, disabled }: Props): React.JSX.Element | null {
  const { urls, failed, error } = useRunImageUrls(globalId, images)
  if (images.length === 0) return null
  return (
    <>
      <ImageAttachments
        items={images.map((i) => ({ key: i.id, url: urls.get(i.id), failed: failed.has(i.id) }))}
        onRemove={onRemove}
        disabled={disabled}
      />
      {error && <span className="error-text">{error}</span>}
    </>
  )
}
