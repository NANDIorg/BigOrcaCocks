import type React from 'react'
import { useState } from 'react'
import type { RunImage } from '@orca-board/core'
import { AttachmentList } from './AttachmentList'
import { useRunImageUrls } from './useRunImageUrls'
import { runImagesApi } from './runImages'
import { ipcErrorMessage } from './useAutoSave'

interface Props {
  globalId: string
  images: readonly RunImage[]
  /** Убрать сохранённое вложение (правка до начала работы); нет — только просмотр. */
  onRemove?(imageId: string): void
  disabled?: boolean
}

/**
 * Сохранённые вложения глобальной задачи: миниатюры картинок (по клику — на весь экран) и карточки файлов
 * с «Показать в папке» и «Открыть» для белого списка (это делает `AttachmentList`). Использовать с `key` по id задачи
 * (`useRunImageUrls`). Ошибка чтения или открытия — строкой под рядом.
 */
export function RunImageGallery({ globalId, images, onRemove, disabled }: Props): React.JSX.Element | null {
  const { urls, failed, error } = useRunImageUrls(globalId, images)
  const [actionError, setActionError] = useState<string | null>(null)
  if (images.length === 0) return null
  const act = (fn: 'revealAttachment' | 'openAttachment', id: string): void => {
    setActionError(null)
    void (async () => {
      try {
        await runImagesApi(window.orca)[fn](globalId, id)
      } catch (e) {
        setActionError(ipcErrorMessage(e))
      }
    })()
  }
  const shown = actionError ?? error
  return (
    <>
      <AttachmentList
        items={images.map((i) => ({
          key: i.id,
          kind: i.kind ?? 'image',
          name: i.name,
          ext: i.ext,
          bytes: i.bytes,
          url: urls.get(i.id),
          failed: failed.has(i.id)
        }))}
        onRemove={onRemove}
        onReveal={(id) => act('revealAttachment', id)}
        onOpen={(id) => act('openAttachment', id)}
        disabled={disabled}
      />
      {shown && <span className="error-text">{shown}</span>}
    </>
  )
}
