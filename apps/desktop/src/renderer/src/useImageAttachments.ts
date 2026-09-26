import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { ImageAttachmentInput } from '@orca-board/core'
import { addUsage, checkImageData, checkImageFile, clipboardImageFiles, imageUsage, type ImageUsage } from './imagePaste'
import { ipcErrorMessage } from './useAutoSave'
import { useT } from './i18n'

/** Вставленное или выбранное изображение: байты уходят в main при сохранении, `url` — только для миниатюры. */
export interface PendingImage extends ImageAttachmentInput {
  id: number
  url: string
}

interface Options {
  /** Уже сохранённые у задачи картинки (правка): их количество и размер входят в лимиты. */
  saved?: ImageUsage
  /** Пока true, новые изображения не принимаются (идёт сохранение). */
  locked?: boolean
}

export interface ImageAttachments {
  images: PendingImage[]
  /** Сколько файлов ещё читается — на это время сохранять нельзя. */
  reading: number
  /** Ошибка последней попытки добавить; сбрасывается при следующей. */
  error: string | null
  clearError(): void
  /** Вешается на `onPaste` поля. Картинок в буфере нет — ничего не делает, вставка текста стандартная. */
  onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>): void
  /** Файлы из выбора (`input type=file`). */
  addFiles(files: Iterable<File>): void
  remove(id: number): void
  /** Данные для IPC без служебных полей. */
  payload(): ImageAttachmentInput[]
}

/**
 * Вставка картинок из буфера и выбор файлов: чтение, проверка (`imagePaste`), превью и освобождение `blob:` URL.
 * Общий код `CoordinatorModal` и `GlobalTaskModal`.
 */
export function useImageAttachments({ saved, locked = false }: Options = {}): ImageAttachments {
  const t = useT()
  const [images, setImages] = useState<PendingImage[]>([])
  const [reading, setReading] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // Актуальные данные для async-чтения файла: к моменту его конца состояние компонента уже могло смениться.
  const imagesRef = useRef<PendingImage[]>([])
  const savedRef = useRef<ImageUsage>({ count: 0, bytes: 0 })
  const lockedRef = useRef(false)
  const nextId = useRef(1)
  imagesRef.current = images
  savedRef.current = saved ?? { count: 0, bytes: 0 }
  lockedRef.current = locked

  useEffect(() => () => imagesRef.current.forEach((img) => URL.revokeObjectURL(img.url)), [])

  const addImage = async (file: File): Promise<void> => {
    try {
      checkImageFile(file)
      const data = new Uint8Array(await file.arrayBuffer())
      const current = imagesRef.current
      const mime = checkImageData(data, addUsage(savedRef.current, imageUsage(current.map((i) => ({ bytes: i.data.byteLength })))))
      const img: PendingImage = { id: nextId.current++, mime, data, url: URL.createObjectURL(new Blob([data], { type: mime })) }
      imagesRef.current = [...current, img]
      setImages(imagesRef.current)
    } catch (err) {
      setError(t('common.image.error', { error: ipcErrorMessage(err) }))
    }
  }

  const addFiles = (files: Iterable<File>): void => {
    const list = [...files]
    if (list.length === 0 || lockedRef.current) return
    setError(null)
    setReading((n) => n + list.length)
    for (const file of list) void addImage(file).finally(() => setReading((n) => n - 1))
  }

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = clipboardImageFiles(e.clipboardData.items)
    if (files.length === 0) return // обычный текст — стандартная вставка
    // Текст вставляем как обычно, если он есть рядом с картинкой; иначе браузеру вставлять нечего.
    if (!e.clipboardData.getData('text/plain')) e.preventDefault()
    addFiles(files)
  }

  const remove = (id: number): void => {
    const img = imagesRef.current.find((i) => i.id === id)
    if (img) URL.revokeObjectURL(img.url)
    imagesRef.current = imagesRef.current.filter((i) => i.id !== id)
    setImages(imagesRef.current)
  }

  return {
    images,
    reading,
    error,
    clearError: () => setError(null),
    onPaste,
    addFiles,
    remove,
    payload: () => imagesRef.current.map(({ mime, data }) => ({ mime, data }))
  }
}
