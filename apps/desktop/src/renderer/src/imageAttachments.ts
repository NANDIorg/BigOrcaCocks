import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IMAGE_ATTACHMENT_LIMITS,
  isImageAttachmentMime,
  sniffImageType,
  type ImageAttachmentInput,
  type ImageAttachmentMime
} from '@orca-board/core'
import type { OrcaApi } from '../../shared/ipc'
import { t } from './i18n'
import { ipcErrorMessage } from './ipcError'

/**
 * Изображения, приложенные к тексту (цель координатора, замечания при возврате в работу): состояние формы,
 * проверки лимитов и отбор файлов из буфера/перетаскивания. Проверки — теми же константами, что и в main
 * (`validateImageAttachments`): ошибка показывается до отправки, а main остаётся последним рубежом.
 */

/** Приложенное изображение: байты уходят в main при отправке формы, `url` — только для миниатюры. */
export interface AttachedImage extends ImageAttachmentInput {
  id: number
  url: string
}

const MB = 1024 * 1024
const { maxCount, maxBytes, maxTotalBytes } = IMAGE_ATTACHMENT_LIMITS

/** Что нужно от элемента буфера обмена (`DataTransferItem`) — чтобы тестировать без DOM. */
export interface ClipboardItemLike {
  kind: string
  type: string
  getAsFile(): File | null
}

/** Картинки из буфера обмена. Обычный текст (или нет файлов) — пусто: стандартная вставка. */
export function imageFilesFromClipboard(items: ArrayLike<ClipboardItemLike>): File[] {
  return Array.from(items)
    .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    .map((it) => it.getAsFile())
    .filter((f): f is File => f !== null)
}

/**
 * Файлы из перетаскивания. Берём все, а не только `image/*`: неподходящий формат человек должен увидеть
 * ошибкой, а не тем, что файл молча пропал.
 */
export function imageFilesFromDrop(files: ArrayLike<File> | null | undefined): File[] {
  return files ? Array.from(files) : []
}

/** В перетаскивании есть файлы (а не выделенный текст) — только тогда поле принимает drop. */
export function dragHasFiles(types: ArrayLike<string> | null | undefined): boolean {
  return types ? Array.from(types).includes('Files') : false
}

/** Проверка до чтения файла: тип по заявленному MIME и размер одного файла. Ошибка — с текстом на языке интерфейса. */
export function checkFileMeta(file: { type: string; size: number }): void {
  if (!isImageAttachmentMime(file.type)) throw new Error(t('common.attach.errFormat', { type: file.type || '—' }))
  if (file.size > maxBytes) throw new Error(t('common.attach.errSize', { mb: maxBytes / MB }))
}

/**
 * Проверка после чтения: тип по сигнатуре (MIME из буфера не доверяем), число и суммарный размер вместе
 * с уже приложенными. Возвращает тип для миниатюры.
 */
export function checkImageData(data: Uint8Array, existing: readonly { data: { byteLength: number } }[]): ImageAttachmentMime {
  const mime = sniffImageType(data)
  if (!mime) throw new Error(t('common.attach.errUnknown'))
  if (existing.length >= maxCount) throw new Error(t('common.attach.errCount', { count: maxCount }))
  const total = existing.reduce((s, img) => s + img.data.byteLength, 0) + data.byteLength
  if (total > maxTotalBytes) throw new Error(t('common.attach.errTotal', { mb: maxTotalBytes / MB }))
  return mime
}

/** Байты для IPC: только `mime` и `data` (без `id`/`url`); нет картинок — undefined, аргумент не передаётся. */
export function imagesPayload(images: readonly AttachedImage[]): ImageAttachmentInput[] | undefined {
  return images.length > 0 ? images.map(({ mime, data }) => ({ mime, data })) : undefined
}

export interface ImageAttachments {
  images: AttachedImage[]
  /** Идёт чтение файлов: отправлять форму рано, картинка ещё не в списке. */
  reading: boolean
  /** Ошибка добавления последнего файла (текст уже на языке интерфейса). */
  error: string | null
  add(files: readonly File[]): void
  remove(id: number): void
  /** Убрать все (и освободить blob-URL миниатюр): после отправки или отмены. */
  clear(): void
  clearError(): void
  /** Байты для IPC или undefined, если картинок нет. */
  payload(): ImageAttachmentInput[] | undefined
}

/** Состояние приложенных изображений одной формы. blob-URL освобождаются при удалении и размонтировании. */
export function useImageAttachments(): ImageAttachments {
  const [images, setImages] = useState<AttachedImage[]>([])
  const [reading, setReading] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // Актуальный список для async-чтения: проверка лимитов и добавление идут без ожидания перерисовки.
  const ref = useRef<AttachedImage[]>([])
  const nextId = useRef(1)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      ref.current.forEach((img) => URL.revokeObjectURL(img.url))
    }
  }, [])

  const addOne = useCallback(async (file: File): Promise<void> => {
    try {
      checkFileMeta(file)
      const data = new Uint8Array(await file.arrayBuffer())
      const mime = checkImageData(data, ref.current)
      if (!mounted.current) return
      const img: AttachedImage = { id: nextId.current++, mime, data, url: URL.createObjectURL(new Blob([data], { type: mime })) }
      ref.current = [...ref.current, img]
      setImages(ref.current)
    } catch (err) {
      if (mounted.current) setError(t('common.attach.imageError', { error: ipcErrorMessage(err) }))
    }
  }, [])

  const add = useCallback(
    (files: readonly File[]): void => {
      if (files.length === 0) return
      setError(null)
      setReading((n) => n + files.length)
      // По очереди: порядок миниатюр совпадает с порядком файлов, а проверка лимитов видит предыдущие.
      void (async () => {
        for (const f of files) {
          await addOne(f)
          if (mounted.current) setReading((n) => n - 1)
        }
      })()
    },
    [addOne]
  )

  const remove = useCallback((id: number): void => {
    const img = ref.current.find((i) => i.id === id)
    if (img) URL.revokeObjectURL(img.url)
    ref.current = ref.current.filter((i) => i.id !== id)
    setImages(ref.current)
    setError(null)
  }, [])

  const clear = useCallback((): void => {
    ref.current.forEach((img) => URL.revokeObjectURL(img.url))
    ref.current = []
    setImages([])
    setError(null)
  }, [])

  const clearError = useCallback((): void => setError(null), [])
  const payload = useCallback((): ImageAttachmentInput[] | undefined => imagesPayload(ref.current), [])

  return { images, reading: reading > 0, error, add, remove, clear, clearError, payload }
}

/**
 * Поддерживает ли запущенный main картинки к замечаниям. main и preload собираются только при запуске, а renderer
 * в `pnpm dev` обновляется по HMR: «новый preload + старый main» молча отбросил бы лишний аргумент `images`, и
 * картинка пропала бы без ошибки. Поэтому перед показом «Приложить» зовём `attachments.ping()`.
 */
export type AttachmentsSupport = 'checking' | 'ok' | 'stale'

export async function attachmentsSupport(api: Partial<OrcaApi> | undefined): Promise<'ok' | 'stale'> {
  const ping = api?.attachments?.ping
  if (typeof ping !== 'function') return 'stale'
  try {
    return (await ping()) === true ? 'ok' : 'stale'
  } catch {
    // «No handler registered for 'attachments:ping'» — main старый.
    return 'stale'
  }
}

/** Ошибка «старый main/preload без картинок» на текущем языке интерфейса. */
export function staleAttachmentsMessage(): string {
  return t('common.attach.stale')
}

/** Ответ рукопожатия не меняется до перезапуска приложения — спрашиваем main один раз. */
let supportProbe: Promise<'ok' | 'stale'> | undefined

export function probeAttachments(api: Partial<OrcaApi> | undefined = window.orca): Promise<'ok' | 'stale'> {
  supportProbe ??= attachmentsSupport(api)
  return supportProbe
}

/** Хук над `probeAttachments`: пока идёт проверка — `checking`. `enabled=false` — проверка не нужна (`ok` сразу). */
export function useAttachmentsSupport(enabled = true): AttachmentsSupport {
  const [state, setState] = useState<AttachmentsSupport>(enabled ? 'checking' : 'ok')
  useEffect(() => {
    if (!enabled) return
    let alive = true
    void probeAttachments().then((s) => {
      if (alive) setState(s)
    })
    return () => {
      alive = false
    }
  }, [enabled])
  return enabled ? state : 'ok'
}
