import type React from 'react'
import { useRef, useState } from 'react'
import { useT } from './i18n'
import { ImageAttachments } from './ImageAttachments'
import { acceptFor, dragHasFiles, filesFromDrop, limitsFor, pasteKeys, type AttachmentDrafts } from './attachmentDrafts'

interface Props {
  attachments: AttachmentDrafts
  /** Идёт отправка: вставка, drop и удаление выключены. */
  disabled?: boolean
  /** Тесное место (карточка на доске, лента): мелкие миниатюры, без подсказки. */
  compact?: boolean
  /** Своя подсказка вместо стандартной (у цели координатора она ещё говорит про цель по умолчанию). */
  hint?: string
  /** Поле ввода, к которому приложены картинки (`<textarea>`): вставка из буфера ловится всплытием. */
  children: React.ReactNode
}

/**
 * Обёртка над полем текста: «Приложить» (выбор файла), вставка из буфера (⌘V/Ctrl+V), перетаскивание файла,
 * миниатюры с «×» и ошибки под полем. Состояние и рукопожатие с main — в `useAttachmentDrafts()` у формы: ей же
 * нужны байты при отправке. Текст в поле не трогаем — введённое не теряется ни при какой ошибке вложения.
 */
export function ImageAttachField({ attachments, disabled = false, compact = false, hint, children }: Props): React.JSX.Element {
  const t = useT()
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const { items, reading, error, support, mode } = attachments
  const active = (support === 'ok' || support === 'imagesOnly') && !disabled
  const limits = limitsFor(mode)

  const onPaste = (e: React.ClipboardEvent): void => {
    if (active) attachments.onPaste(e)
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
    if (!active) return
    const { files, folders } = filesFromDrop(e.dataTransfer)
    attachments.add(files, folders)
  }

  const onPick = (e: React.ChangeEvent<HTMLInputElement>): void => {
    attachments.add(filesFromDrop({ files: e.target.files }).files)
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
            title={mode === 'files' ? t('common.attach.addTitle', { count: limits.maxCount, mb: limits.maxBytes / (1024 * 1024) }) : t('common.attach.addTitleImages')}
            onClick={() => fileRef.current?.click()}
          >
            📎 {t('common.attach.add')}
          </button>
          <input ref={fileRef} type="file" accept={acceptFor(mode)} multiple hidden tabIndex={-1} onChange={onPick} />
          {!compact && (
            <span className="muted attach-hint">
              {hint ?? t(mode === 'files' ? 'common.attach.hint' : 'common.attach.hintImages', { keys: pasteKeys(navigator.platform) })}
            </span>
          )}
        </div>
      )}
      <ImageAttachments
        items={items.map((it) => ({ key: String(it.id), url: it.url }))}
        reading={reading ? 1 : 0}
        compact={compact}
        disabled={disabled}
        onRemove={(key) => attachments.remove(Number(key))}
      />
      {/* По строке на отвергнутый файл. */}
      {error && <span className="error-text" style={{ whiteSpace: 'pre-line' }}>{error}</span>}
    </div>
  )
}
