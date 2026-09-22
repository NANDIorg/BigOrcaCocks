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
      if (!isImageAttachmentMime(file.type)) throw new Error(`формат ${file.type} не поддерживается (нужен PNG, JPEG, GIF или WebP)`)
      if (file.size > maxBytes) throw new Error(`изображение больше ${maxBytes / MB} МБ`)
      const data = new Uint8Array(await file.arrayBuffer())
      const mime = sniffImageType(data)
      if (!mime) throw new Error('не удалось распознать изображение')
      const current = imagesRef.current
      if (current.length >= maxCount) throw new Error(`можно приложить не больше ${maxCount} изображений`)
      const total = current.reduce((s, img) => s + img.data.byteLength, 0) + data.byteLength
      if (total > maxTotalBytes) throw new Error(`изображения вместе больше ${maxTotalBytes / MB} МБ`)
      const img: Pasted = { id: nextId.current++, mime, data, url: URL.createObjectURL(new Blob([data], { type: mime })) }
      imagesRef.current = [...current, img]
      setImages(imagesRef.current)
    } catch (err) {
      setError(`Изображение не добавлено: ${ipcErrorMessage(err)}`)
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
      setError(`Не удалось запустить координатора: ${ipcErrorMessage(err)}`)
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
        <h3>Запустить координатора</h3>
        <p className="muted" style={{ margin: 0 }}>
          Claude Code откроется в корне репозитория с инструкцией координатора. Он разобьёт цель на задачи,
          запустит воркеров и будет ждать событий.
        </p>
        <label>
          Цель
          <textarea
            autoFocus
            value={objective}
            readOnly={busy}
            onChange={(e) => setObjective(e.target.value)}
            onPaste={onPaste}
            placeholder="Например: добавить экспорт отчёта в PDF, покрыть тестами, обновить README"
          />
        </label>
        <span className="muted coord-hint">
          Скриншот можно вставить в поле через {navigator.platform.startsWith('Mac') ? '⌘V' : 'Ctrl+V'} — координатор
          получит его файлом. Без текста цель будет: «{DEFAULT_IMAGE_OBJECTIVE}»
        </span>
        {(images.length > 0 || reading > 0) && (
          <div className="coord-images">
            {images.map((img, i) => (
              <div key={img.id} className="coord-image">
                <img src={img.url} alt={`Изображение ${i + 1}`} />
                <button
                  className="coord-image-remove"
                  title="Убрать изображение"
                  aria-label={`Убрать изображение ${i + 1}`}
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
          <button className="btn-text" onClick={close} disabled={busy}>Отмена</button>
          <button className="btn-primary" disabled={!canStart} onClick={() => void start()}>
            {busy ? 'Запуск…' : 'Запустить'}
          </button>
        </div>
      </div>
    </div>
  )
}
