import type React from 'react'
import { useRef, useState } from 'react'
import { IMAGE_ATTACHMENT_TYPES } from '@orca-board/core'
import { useT } from './i18n'
import {
  dragHasFiles,
  imageFilesFromClipboard,
  imageFilesFromDrop,
  useAttachmentsSupport,
  type ImageAttachments
} from './imageAttachments'

interface Props {
  attachments: ImageAttachments
  /** Идёт отправка: вставка, drop и удаление выключены. */
  disabled?: boolean
  /** Тесное место (карточка на доске, лента): мелкие миниатюры, без подсказки. */
  compact?: boolean
  /**
   * Спросить main через `attachments.ping()`, что он умеет принимать картинки. Нужно всем формам возврата:
   * старый main молча отбросил бы лишний аргумент. Форма, у которой картинки были и раньше (цель координатора), — false.
   */
  checkApp?: boolean
  /** Своя подсказка вместо стандартной (у цели координатора она ещё говорит про цель по умолчанию). */
  hint?: string
  /** Поле ввода, к которому приложены картинки (`<textarea>`): вставка из буфера ловится всплытием. */
  children: React.ReactNode
}

const ACCEPT = Object.keys(IMAGE_ATTACHMENT_TYPES).join(',')

/**
 * Обёртка над полем текста: «Приложить» (выбор файла), вставка из буфера (⌘V/Ctrl+V), перетаскивание файла,
 * миниатюры с «×» и ошибки под полем. Состояние — в `useImageAttachments()` у формы: ей же нужны байты
 * при отправке. Текст в поле не трогаем — введённое не теряется ни при какой ошибке картинки.
 */
export function ImageAttachField({ attachments, disabled = false, compact = false, checkApp = true, hint, children }: Props): React.JSX.Element {
  const t = useT()
  const support = useAttachmentsSupport(checkApp)
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const { images, reading, error } = attachments
  const active = support === 'ok' && !disabled

  const onPaste = (e: React.ClipboardEvent): void => {
    const files = imageFilesFromClipboard(e.clipboardData.items)
    if (files.length === 0) return // обычный текст — стандартная вставка
    // Текст вставляем как обычно, если он есть рядом с картинкой; иначе браузеру вставлять нечего.
    if (!e.clipboardData.getData('text/plain')) e.preventDefault()
    if (active) attachments.add(files)
  }

  const onDragOver = (e: React.DragEvent): void => {
    if (!dragHasFiles(e.dataTransfer.types)) return
    e.preventDefault() // без этого браузер не отдаст drop
    e.stopPropagation() // колонка доски со своим drop не должна принять файл за перенос карточки
    if (active) setDragging(true)
  }

  const onDragLeave = (e: React.DragEvent): void => {
    // dragleave прилетает и при переходе на дочерний элемент — гасим подсветку, только когда вышли из поля.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
  }

  const onDrop = (e: React.DragEvent): void => {
    if (!dragHasFiles(e.dataTransfer.types)) return
    e.preventDefault()
    e.stopPropagation()
    setDragging(false)
    if (active) attachments.add(imageFilesFromDrop(e.dataTransfer.files))
  }

  const onPick = (e: React.ChangeEvent<HTMLInputElement>): void => {
    attachments.add(imageFilesFromDrop(e.target.files))
    e.target.value = '' // тот же файл можно выбрать повторно после «×»
  }

  return (
    <div
      className={`attach${compact ? ' compact' : ''}${dragging ? ' dragging' : ''}`}
      onPaste={onPaste}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children}
      {support === 'stale' ? (
        <span className="muted attach-hint">{t('common.attach.stale')}</span>
      ) : (
        <div className="attach-bar">
          <button
            type="button"
            className="btn-sm attach-add"
            disabled={!active}
            title={t('common.attach.addTitle')}
            onClick={() => fileRef.current?.click()}
          >
            📎 {t('common.attach.add')}
          </button>
          <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden tabIndex={-1} onChange={onPick} />
          {!compact && (
            <span className="muted attach-hint">
              {hint ?? t('common.attach.hint', { keys: navigator.platform.startsWith('Mac') ? '⌘V' : 'Ctrl+V' })}
            </span>
          )}
        </div>
      )}
      {(images.length > 0 || reading) && (
        <div className="attach-images">
          {images.map((img, i) => (
            <div key={img.id} className="attach-image">
              <img src={img.url} alt={t('common.attach.image', { n: i + 1 })} />
              <button
                type="button"
                className="attach-image-remove"
                title={t('common.attach.removeImage')}
                aria-label={t('common.attach.removeImageN', { n: i + 1 })}
                disabled={disabled}
                onClick={() => attachments.remove(img.id)}
              >
                ×
              </button>
            </div>
          ))}
          {reading && <div className="attach-image attach-image-loading">…</div>}
        </div>
      )}
      {error && <span className="error-text">{error}</span>}
    </div>
  )
}
