import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  IMAGE_ATTACHMENT_LIMITS,
  DEFAULT_IMAGE_OBJECTIVE,
  isImageAttachmentMime,
  sniffImageType,
  type ImageAttachmentInput
} from '@orca-board/core'
import { ipcErrorMessage } from './useAutoSave'
import { useT } from './i18n'

interface Props {
  onClose(): void
  /** Пустая цель приходит только вместе с изображениями — main подставит стандартную. */
  onStart(objective: string, images: ImageAttachmentInput[]): Promise<void>
}

/** Вставленное изображение: байты уходят в main при запуске, `url` — только для миниатюры. */
interface Pasted extends ImageAttachmentInput {
  id: number
  url: string
}

const MB = 1024 * 1024
const { maxCount, maxBytes, maxTotalBytes } = IMAGE_ATTACHMENT_LIMITS

export function CoordinatorModal({ onClose, onStart }: Props): React.JSX.Element {
  const t = useT()
  const [objective, setObjective] = useState('')
  const [images, setImages] = useState<Pasted[]>([])
  const [reading, setReading] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Синхронная защита от двойного запуска (до перерисовки с busy) и актуальные данные для async-вставки.
  const busyRef = useRef(false)
  const imagesRef = useRef<Pasted[]>([])
  const nextId = useRef(1)
  imagesRef.current = images

  useEffect(() => () => imagesRef.current.forEach((img) => URL.revokeObjectURL(img.url)), [])

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...e.clipboardData.items]
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null)
    if (files.length === 0) return // обычный текст — стандартная вставка
    // Текст вставляем как обычно, если он есть рядом с картинкой; иначе браузеру вставлять нечего.
    if (!e.clipboardData.getData('text/plain')) e.preventDefault()
    if (busyRef.current) return
    setError(null)
    setReading((n) => n + files.length)
    for (const file of files) {
      void addImage(file).finally(() => setReading((n) => n - 1))
    }
  }

  const addImage = async (file: File): Promise<void> => {
    try {
      if (!isImageAttachmentMime(file.type)) throw new Error(t('shell.coordModal.errFormat', { type: file.type }))
      if (file.size > maxBytes) throw new Error(t('shell.coordModal.errSize', { mb: maxBytes / MB }))
      const data = new Uint8Array(await file.arrayBuffer())
      const mime = sniffImageType(data)
      if (!mime) throw new Error(t('shell.coordModal.errUnknown'))
      const current = imagesRef.current
      if (current.length >= maxCount) throw new Error(t('shell.coordModal.errCount', { count: maxCount }))
      const total = current.reduce((s, img) => s + img.data.byteLength, 0) + data.byteLength
      if (total > maxTotalBytes) throw new Error(t('shell.coordModal.errTotal', { mb: maxTotalBytes / MB }))
      const img: Pasted = { id: nextId.current++, mime, data, url: URL.createObjectURL(new Blob([data], { type: mime })) }
      imagesRef.current = [...current, img]
      setImages(imagesRef.current)
    } catch (err) {
      setError(t('shell.coordModal.imageError', { error: ipcErrorMessage(err) }))
    }
  }

  const removeImage = (id: number): void => {
    const img = imagesRef.current.find((i) => i.id === id)
    if (img) URL.revokeObjectURL(img.url)
    imagesRef.current = imagesRef.current.filter((i) => i.id !== id)
    setImages(imagesRef.current)
  }

  const start = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await onStart(objective.trim(), images.map(({ mime, data }) => ({ mime, data })))
    } catch (err) {
      // Текст и вложения остаются в форме — можно исправить и запустить снова.
      setError(t('shell.app.coordinatorError', { error: ipcErrorMessage(err) }))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const canStart = (objective.trim() !== '' || images.length > 0) && !busy && reading === 0
  const close = (): void => {
    if (!busyRef.current) onClose()
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t('shell.coordModal.title')}</h3>
        <p className="muted" style={{ margin: 0 }}>{t('shell.coordModal.intro')}</p>
        <label>
          {t('shell.coordModal.goal')}
          <textarea
            autoFocus
            value={objective}
            readOnly={busy}
            onChange={(e) => setObjective(e.target.value)}
            onPaste={onPaste}
            placeholder={t('shell.coordModal.goalPlaceholder')}
          />
        </label>
        <span className="muted coord-hint">
          {t('shell.coordModal.pasteHint', { keys: navigator.platform.startsWith('Mac') ? '⌘V' : 'Ctrl+V', goal: DEFAULT_IMAGE_OBJECTIVE })}
        </span>
        {(images.length > 0 || reading > 0) && (
          <div className="coord-images">
            {images.map((img, i) => (
              <div key={img.id} className="coord-image">
                <img src={img.url} alt={t('shell.coordModal.image', { n: i + 1 })} />
                <button
                  className="coord-image-remove"
                  title={t('shell.coordModal.removeImage')}
                  aria-label={t('shell.coordModal.removeImageN', { n: i + 1 })}
                  disabled={busy}
                  onClick={() => removeImage(img.id)}
                >
                  ×
                </button>
              </div>
            ))}
            {reading > 0 && <div className="coord-image coord-image-loading">…</div>}
          </div>
        )}
        {error && <span className="error-text">{error}</span>}
        <div className="row">
          <button className="btn-text" onClick={close} disabled={busy}>{t('shell.cancel')}</button>
          <button className="btn-primary" disabled={!canStart} onClick={() => void start()}>
            {busy ? t('shell.coordModal.starting') : t('shell.coordModal.start')}
          </button>
        </div>
      </div>
    </div>
  )
}
