import {
  IMAGE_ATTACHMENT_LIMITS,
  isImageAttachmentMime,
  sniffImageType,
  type ImageAttachmentMime
} from '@orca-board/core'
import { t } from './i18n'

/**
 * Чистая логика вставки картинок (CoordinatorModal, GlobalTaskModal): какие файлы взять из буфера и как проверить
 * очередную картинку до отправки в main. Main всё равно перепроверит (`validateImageAttachments`) — здесь только
 * быстрая обратная связь. Ошибки — `Error` с текстом на языке интерфейса.
 */

const MB = 1024 * 1024
const { maxCount, maxBytes, maxTotalBytes } = IMAGE_ATTACHMENT_LIMITS

/** Уже приложенное к задаче: количество и суммарный размер (сохранённые + вставленные, но ещё не отправленные). */
export interface ImageUsage {
  count: number
  bytes: number
}

/** Элемент буфера обмена (`DataTransferItem`) — ровно то, что нужно для отбора картинок. */
export interface ClipboardItemLike {
  kind: string
  type: string
  getAsFile(): File | null
}

/** Файлы-картинки из буфера обмена. Пусто — в буфере обычный текст, стандартная вставка. */
export function clipboardImageFiles(items: ArrayLike<ClipboardItemLike>): File[] {
  return Array.from(items)
    .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    .map((it) => it.getAsFile())
    .filter((f): f is File => f !== null)
}

/** Проверка до чтения файла: заявленный тип и размер одного изображения. */
export function checkImageFile(file: { type: string; size: number }): void {
  if (!isImageAttachmentMime(file.type)) throw new Error(t('common.image.errFormat', { type: file.type }))
  if (file.size > maxBytes) throw new Error(t('common.image.errSize', { mb: maxBytes / MB }))
}

/**
 * Проверка прочитанных байтов: тип — по сигнатуре (заявленному MIME из буфера не верим), затем лимиты задачи
 * с учётом уже приложенного. Возвращает настоящий тип.
 */
export function checkImageData(data: Uint8Array, usage: ImageUsage): ImageAttachmentMime {
  const mime = sniffImageType(data)
  if (!mime) throw new Error(t('common.image.errUnknown'))
  if (usage.count >= maxCount) throw new Error(t('common.image.errCount', { count: maxCount }))
  if (usage.bytes + data.byteLength > maxTotalBytes) throw new Error(t('common.image.errTotal', { mb: maxTotalBytes / MB }))
  return mime
}

/** Сумма: количество и размер картинок списка. */
export function imageUsage(items: readonly { bytes: number }[]): ImageUsage {
  return { count: items.length, bytes: items.reduce((s, i) => s + i.bytes, 0) }
}

/** Сложить два учёта (сохранённые + вставленные). */
export function addUsage(a: ImageUsage, b: ImageUsage): ImageUsage {
  return { count: a.count + b.count, bytes: a.bytes + b.bytes }
}

/** Подпись сочетания клавиш вставки для подсказки: ⌘V на macOS, иначе Ctrl+V. */
export function pasteKeys(platform: string): string {
  return platform.startsWith('Mac') ? '⌘V' : 'Ctrl+V'
}

/** `accept` для выбора файла — те же четыре формата, что принимает main. */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'
