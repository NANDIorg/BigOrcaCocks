import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ATTACHMENT_LIMITS,
  IMAGE_ATTACHMENT_LIMITS,
  IMAGE_ATTACHMENT_TYPES,
  attachmentDisplayName,
  isImageAttachmentMime,
  sniffImageType,
  type AttachmentInput,
  type AttachmentKind
} from '@orca-board/core'
import type { OrcaApi } from '../../shared/ipc'
import { t } from './i18n'
import { ipcErrorMessage } from './ipcError'

/**
 * Вложения, приложенные к тексту формы (цель координатора, глобальная задача, замечания при возврате, уточнения):
 * отбор файлов из буфера и перетаскивания, проверки лимитов, состояние формы и рукопожатие с main. Модуль не знает
 * о конкретных формах. Проверки — теми же константами, что и в main (`validateAttachments` или прежний
 * `validateImageAttachments`): ошибка показывается до отправки, а main остаётся последним рубежом.
 */

const MB = 1024 * 1024

/** Режим приёма: `files` — любые файлы (`ATTACHMENT_LIMITS`), `images` — только PNG/JPEG/GIF/WebP (старый main). */
export type AttachmentMode = 'files' | 'images'

export function limitsFor(mode: AttachmentMode): { maxCount: number; maxBytes: number; maxTotalBytes: number } {
  return mode === 'images' ? IMAGE_ATTACHMENT_LIMITS : ATTACHMENT_LIMITS
}

/** `accept` для выбора файла: в режиме картинок — четыре формата main, иначе без ограничений (undefined). */
export function acceptFor(mode: AttachmentMode): string | undefined {
  return mode === 'images' ? Object.keys(IMAGE_ATTACHMENT_TYPES).join(',') : undefined
}

/** Подпись сочетания клавиш вставки для подсказки: ⌘V на macOS, иначе Ctrl+V. */
export function pasteKeys(platform: string): string {
  return platform.startsWith('Mac') ? '⌘V' : 'Ctrl+V'
}

// ---------- Буфер обмена и перетаскивание ----------

/** Что нужно от элемента буфера обмена (`DataTransferItem`) — чтобы тестировать без DOM. */
export interface ClipboardItemLike {
  kind: string
  type: string
  getAsFile(): File | null
}

export interface ClipboardLike {
  items: ArrayLike<ClipboardItemLike>
  getData(format: string): string
}

/**
 * Файлы из вставки и нужно ли гасить стандартную вставку текста. Берём любые файловые элементы, не только `image/*`.
 * Файл, скопированный в Finder/Проводнике, приходит вместе с `text/plain` — своим именем (или путём): такой текст
 * в поле не вставляем. Текст рядом с картинкой, который именем файла не является (картинка из браузера с подписью),
 * вставляется как обычно. Файлов нет — `files` пуст, вставка текста стандартная.
 */
export function filesFromClipboard(data: ClipboardLike): { files: File[]; suppressText: boolean } {
  const files = Array.from(data.items)
    .filter((it) => it.kind === 'file')
    .map((it) => it.getAsFile())
    .filter((f): f is File => f !== null)
  if (files.length === 0) return { files, suppressText: false }
  const text = data.getData('text/plain').trim()
  if (!text) return { files, suppressText: true }
  const names = new Set(files.map((f) => f.name))
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const onlyNames = lines.every((line) => names.has(line.split(/[\\/]/).pop() ?? line))
  return { files, suppressText: onlyNames }
}

/** Элемент перетаскивания: `webkitGetAsEntry` нужен, чтобы отличить папку от файла (Chromium отдаёт папку «файлом»). */
export interface DropItemLike {
  kind: string
  getAsFile(): File | null
  webkitGetAsEntry?(): { isDirectory: boolean; name: string } | null
}

export interface DropLike {
  items?: ArrayLike<DropItemLike> | null
  files?: ArrayLike<File> | null
}

/**
 * Файлы из перетаскивания (или выбора файла) и имена папок, которые не принимаются. Берём все файлы, а не только
 * подходящие: неподходящий человек должен увидеть ошибкой, а не тем, что файл молча пропал. Звать синхронно
 * в обработчике `drop` — после него `items` пустеют.
 */
export function filesFromDrop(dt: DropLike | null | undefined): { files: File[]; folders: string[] } {
  const files: File[] = []
  const folders: string[] = []
  const items = dt?.items ? Array.from(dt.items).filter((it) => it.kind === 'file') : []
  if (items.length === 0) return { files: dt?.files ? Array.from(dt.files) : [], folders }
  for (const it of items) {
    const entry = it.webkitGetAsEntry?.() ?? null
    const file = it.getAsFile()
    if (entry?.isDirectory) folders.push(entry.name || file?.name || '')
    else if (file) files.push(file)
  }
  return { files, folders }
}

/** В перетаскивании есть файлы (а не выделенный текст) — только тогда поле принимает drop. */
export function dragHasFiles(types: ArrayLike<string> | null | undefined): boolean {
  return types ? Array.from(types).includes('Files') : false
}

// ---------- Проверки ----------

/** Уже приложенное: количество и суммарный размер (сохранённые у задачи + добавленные в форме). */
export interface AttachmentUsage {
  count: number
  bytes: number
}

/** Сумма: количество и размер элементов списка. */
export function usageOf(items: readonly { bytes: number }[]): AttachmentUsage {
  return { count: items.length, bytes: items.reduce((s, i) => s + i.bytes, 0) }
}

/** Сложить два учёта (сохранённые + добавленные). */
export function addUsage(a: AttachmentUsage, b: AttachmentUsage): AttachmentUsage {
  return { count: a.count + b.count, bytes: a.bytes + b.bytes }
}

/** Имя файла в ошибке: очищенное, как в UI; у картинки из буфера имени может не быть. */
function shownName(name: string | undefined): string {
  return attachmentDisplayName(name) || t('common.attach.unnamed')
}

function fail(name: string | undefined, error: string): Error {
  return new Error(t('common.attach.errNamed', { name: shownName(name), error }))
}

/** Проверка до чтения файла: пустой, слишком большой, в режиме картинок — не картинка. Ошибка — с именем файла. */
export function checkFileMeta(file: { name?: string; type: string; size: number }, mode: AttachmentMode = 'files'): void {
  const { maxBytes } = limitsFor(mode)
  if (file.size === 0) throw fail(file.name, t('common.attach.errEmpty'))
  if (file.size > maxBytes) throw fail(file.name, t('common.attach.errSize', { mb: maxBytes / MB }))
  if (mode === 'images' && !isImageAttachmentMime(file.type)) throw fail(file.name, t('common.attach.errImagesOnly'))
}

/**
 * Проверка прочитанных байтов: вид — по сигнатуре (заявленному MIME из буфера не верим), затем лимиты с учётом уже
 * приложенного (`usage` — сохранённые у задачи + добавленные в форме). Возвращает вид и MIME для отправки.
 */
export function checkAttachmentData(
  data: Uint8Array,
  file: { name?: string; type?: string },
  usage: AttachmentUsage,
  mode: AttachmentMode = 'files'
): { kind: AttachmentKind; mime: string } {
  const { maxCount, maxBytes, maxTotalBytes } = limitsFor(mode)
  if (data.byteLength === 0) throw fail(file.name, t('common.attach.errEmpty'))
  if (data.byteLength > maxBytes) throw fail(file.name, t('common.attach.errSize', { mb: maxBytes / MB }))
  const image = sniffImageType(data)
  if (!image && mode === 'images') throw fail(file.name, t('common.attach.errImagesOnly'))
  if (usage.count >= maxCount) throw fail(file.name, t('common.attach.errCount', { count: maxCount }))
  if (usage.bytes + data.byteLength > maxTotalBytes) throw fail(file.name, t('common.attach.errTotal', { mb: maxTotalBytes / MB }))
  if (image) return { kind: 'image', mime: image }
  return { kind: 'file', mime: file.type || 'application/octet-stream' }
}

// ---------- Состояние формы ----------

/** Приложенный файл: байты уходят в main при отправке, `url` (blob) — только у картинки, для миниатюры. */
export interface DraftAttachment {
  id: number
  kind: AttachmentKind
  mime: string
  /** Исходное имя для показа (`attachmentDisplayName`); у картинки из буфера может быть пустым. */
  name: string
  data: Uint8Array
  url?: string
}

/** Байты для IPC: `mime`, `data` и `name` (если есть), без служебных полей; нет вложений — undefined. */
export function attachmentsPayload(items: readonly DraftAttachment[]): AttachmentInput[] | undefined {
  if (items.length === 0) return undefined
  return items.map(({ mime, data, name }) => (name ? { mime, data, name } : { mime, data }))
}

interface Options {
  /** Уже сохранённые у задачи вложения (правка): их количество и размер входят в лимиты. */
  saved?: AttachmentUsage
  /** Пока true, новые файлы не принимаются (идёт отправка или правка запрещена). */
  locked?: boolean
  /**
   * Форма принимала картинки ещё до рукопожатия с main (цель координатора, глобальная задача): у самого старого
   * main там режим `imagesOnly`, а не `stale` (`useAttachmentsSupport`).
   */
  legacyImages?: boolean
}

export interface AttachmentDrafts {
  items: DraftAttachment[]
  /** Что примет main: пока идёт проверка или main старый — проверки как для картинок (`modeFor`). */
  support: AttachmentsSupport
  mode: AttachmentMode
  /** Идёт чтение файлов: отправлять форму рано, файл ещё не в списке. */
  reading: boolean
  /** Ошибки последнего добавления, по строке на файл (текст на языке интерфейса); сбрасывается при следующем. */
  error: string | null
  /** Файлы из выбора, вставки или перетаскивания; `folders` — имена отвергнутых папок (`filesFromDrop`). */
  add(files: readonly File[], folders?: readonly string[]): void
  /** Вешается на `onPaste` поля: файлов в буфере нет — стандартная вставка текста. */
  onPaste(e: React.ClipboardEvent): void
  remove(id: number): void
  /** Убрать все (и освободить blob-URL миниатюр): после отправки или отмены. */
  clear(): void
  clearError(): void
  /** Байты для IPC или undefined, если вложений нет. */
  payload(): AttachmentInput[] | undefined
}

/** Состояние вложений одной формы. blob-URL освобождаются при удалении, очистке и размонтировании. */
export function useAttachmentDrafts({ saved, locked = false, legacyImages = false }: Options = {}): AttachmentDrafts {
  const support = useAttachmentsSupport(legacyImages)
  const mode = modeFor(support)
  const [items, setItems] = useState<DraftAttachment[]>([])
  const [reading, setReading] = useState(0)
  const [errors, setErrors] = useState<string[]>([])
  // Актуальные данные для async-чтения: к его концу состояние компонента уже могло смениться.
  const ref = useRef<DraftAttachment[]>([])
  const savedRef = useRef<AttachmentUsage>({ count: 0, bytes: 0 })
  const lockedRef = useRef(false)
  const modeRef = useRef<AttachmentMode>('files')
  const nextId = useRef(1)
  const mounted = useRef(true)
  savedRef.current = saved ?? { count: 0, bytes: 0 }
  // `stale` — main вложений не примет: файлы не берём, форма показывает «перезапустите приложение».
  lockedRef.current = locked || support === 'stale'
  modeRef.current = mode

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      revoke(ref.current)
    }
  }, [])

  const addOne = useCallback(async (file: File): Promise<void> => {
    try {
      checkFileMeta(file, modeRef.current)
      const data = new Uint8Array(await file.arrayBuffer())
      const usage = addUsage(savedRef.current, usageOf(ref.current.map((i) => ({ bytes: i.data.byteLength }))))
      const { kind, mime } = checkAttachmentData(data, file, usage, modeRef.current)
      if (!mounted.current) return
      const item: DraftAttachment = { id: nextId.current++, kind, mime, name: attachmentDisplayName(file.name), data }
      if (kind === 'image') item.url = URL.createObjectURL(new Blob([data], { type: mime }))
      ref.current = [...ref.current, item]
      setItems(ref.current)
    } catch (err) {
      if (mounted.current) setErrors((e) => [...e, ipcErrorMessage(err)])
    }
  }, [])

  const add = useCallback(
    (files: readonly File[], folders: readonly string[] = []): void => {
      if (lockedRef.current || (files.length === 0 && folders.length === 0)) return
      setErrors(folders.map((name) => t('common.attach.errNamed', { name: shownName(name), error: t('common.attach.errFolder') })))
      if (files.length === 0) return
      setReading((n) => n + files.length)
      // По очереди: порядок вложений совпадает с порядком файлов, а проверка лимитов видит предыдущие.
      void (async () => {
        for (const f of files) {
          await addOne(f)
          if (mounted.current) setReading((n) => n - 1)
        }
      })()
    },
    [addOne]
  )

  const onPaste = useCallback(
    (e: React.ClipboardEvent): void => {
      const { files, suppressText } = filesFromClipboard(e.clipboardData)
      if (files.length === 0) return // обычный текст — стандартная вставка
      if (suppressText) e.preventDefault()
      add(files)
    },
    [add]
  )

  const remove = useCallback((id: number): void => {
    revoke(ref.current.filter((i) => i.id === id))
    ref.current = ref.current.filter((i) => i.id !== id)
    setItems(ref.current)
    setErrors([])
  }, [])

  const clear = useCallback((): void => {
    revoke(ref.current)
    ref.current = []
    setItems([])
    setErrors([])
  }, [])

  const clearError = useCallback((): void => setErrors([]), [])
  const payload = useCallback((): AttachmentInput[] | undefined => attachmentsPayload(ref.current), [])

  return { items, support, mode, reading: reading > 0, error: errors.length > 0 ? errors.join('\n') : null, add, onPaste, remove, clear, clearError, payload }
}

function revoke(items: readonly DraftAttachment[]): void {
  for (const i of items) if (i.url) URL.revokeObjectURL(i.url)
}

// ---------- Рукопожатие с main ----------

/**
 * Что примет запущенный main. main и preload собираются только при запуске, а renderer в `pnpm dev` обновляется
 * по HMR: старый main отверг бы файл (а самый старый молча отбросил бы лишний аргумент вложений).
 * `ok` — любые файлы; `imagesOnly` — только картинки, файлы появятся после перезапуска; `stale` — вложений нет совсем.
 */
export type AttachmentsSupport = 'checking' | 'ok' | 'imagesOnly' | 'stale'

export async function attachmentsSupport(api: Partial<OrcaApi> | undefined): Promise<'ok' | 'imagesOnly' | 'stale'> {
  const capabilities = api?.attachments?.capabilities
  if (typeof capabilities === 'function') {
    try {
      return (await capabilities()).files === true ? 'ok' : 'imagesOnly'
    } catch {
      // «No handler registered for 'attachments:capabilities'» — main старше preload; проверяем ping.
    }
  }
  const ping = api?.attachments?.ping
  if (typeof ping !== 'function') return 'stale'
  try {
    return (await ping()) === true ? 'imagesOnly' : 'stale'
  } catch {
    // «No handler registered for 'attachments:ping'» — main без вложений к замечаниям.
    return 'stale'
  }
}

/** Режим проверок для ответа рукопожатия: пока ответа нет или main старый — только картинки. */
export function modeFor(support: AttachmentsSupport): AttachmentMode {
  return support === 'ok' ? 'files' : 'images'
}

/** Ошибка «старый main/preload без вложений» на текущем языке интерфейса. */
export function staleAttachmentsMessage(): string {
  return t('common.attach.stale')
}

/** Ответ рукопожатия не меняется до перезапуска приложения — спрашиваем main один раз. */
let supportProbe: Promise<'ok' | 'imagesOnly' | 'stale'> | undefined

export function probeAttachments(api: Partial<OrcaApi> | undefined = window.orca): Promise<'ok' | 'imagesOnly' | 'stale'> {
  supportProbe ??= attachmentsSupport(api)
  return supportProbe
}

/** Забыть кешированный ответ — только для тестов. */
export function resetAttachmentsProbe(): void {
  supportProbe = undefined
}

/**
 * Хук над `probeAttachments`: пока идёт проверка — `checking`. `legacyImages` — форма принимала картинки ещё до
 * рукопожатия (цель координатора, глобальная задача): у самого старого main там `imagesOnly`, а не `stale`.
 */
export function useAttachmentsSupport(legacyImages = false): AttachmentsSupport {
  const [state, setState] = useState<AttachmentsSupport>('checking')
  useEffect(() => {
    let alive = true
    void probeAttachments().then((s) => {
      if (alive) setState(s === 'stale' && legacyImages ? 'imagesOnly' : s)
    })
    return () => {
      alive = false
    }
  }, [legacyImages])
  return state
}
