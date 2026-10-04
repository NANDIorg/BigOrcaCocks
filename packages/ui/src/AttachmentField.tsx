import type React from 'react'
import { useRef, useState } from 'react'
import { useT } from './i18n'
import { AttachmentList, type AttachmentTile } from './AttachmentList'
import { acceptFor, dragHasFiles, filesFromDrop, limitsFor, pasteKeys, type AttachmentDrafts, type DraftAttachment } from './attachmentDrafts'

interface Props {
  attachments: AttachmentDrafts
  /** Идёт отправка: вставка, drop и удаление выключены. */
  disabled?: boolean
  /** Тесное место (карточка на доске, лента): мелкие миниатюры, без подсказки. */
  compact?: boolean
  /**
   * Своя подсказка вместо стандартной (у цели координатора она ещё говорит про цель по умолчанию). В режиме «только
   * картинки» (старый main) — всегда стандартная: своя обещала бы файлы.
   */
  hint?: string
  /**
   * Приложить нельзя (глобальная задача уже начата): вместо кнопки и подсказки — этот текст, вставка и drop
   * не принимаются, а уже сохранённые вложения (`saved`) только показываются.
   */
  lockedHint?: string
  /** Уже сохранённые вложения (правка глобальной задачи) — перед добавленными в форме. */
  saved?: React.ReactNode
  /** Подпись группы для чтения с экрана, когда у поля нет своей. */
  label?: string
  /** Поле ввода, к которому приложены файлы (`<textarea>`): вставка из буфера ловится всплытием. */
  children: React.ReactNode
}

/** Вложения черновика формы → элементы ряда: у файла `ext` возьмёт `attachmentChip` из имени, как его возьмёт main. */
export function draftTiles(items: readonly DraftAttachment[]): AttachmentTile[] {
  return items.map((it) => ({ key: String(it.id), kind: it.kind, url: it.url, name: it.name, bytes: it.data.byteLength }))
}

/**
 * Обёртка над полем текста: «Приложить» (выбор файла), вставка из буфера (⌘V/Ctrl+V), перетаскивание файла,
 * ряд вложений с «×» и ошибки под полем. Одна на все формы с вложениями (цель координатора, глобальная задача,
 * возвраты и уточнения). Состояние и рукопожатие с main — в `useAttachmentDrafts()` у формы: ей же нужны байты
 * при отправке. Текст в поле не трогаем — введённое не теряется ни при какой ошибке вложения.
 */
export function AttachmentField({ attachments, disabled = false, compact = false, hint, lockedHint, saved, label, children }: Props): React.JSX.Element {
  const t = useT()
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const { items, reading, error, support, mode } = attachments
  const active = (support === 'ok' || support === 'imagesOnly') && !disabled && lockedHint === undefined
  const limits = limitsFor(mode)

  const onPaste = (e: React.ClipboardEvent): void => {
    if (active) attachments.onPaste(e)
  }

  const onDragOver = (e: React.DragEvent): void => {
    if (!dragHasFiles(e.dataTransfer.types)) return
    e.preventDefault() // без этого браузер не отдаст drop (и не откроет файл вместо приложения)
    e.stopPropagation() // колонка доски со своим drop не должна принять файл за перенос карточки
    e.dataTransfer.dropEffect = active ? 'copy' : 'none'
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

  const bar = (): React.ReactNode => {
    if (lockedHint !== undefined) return <span className="muted attach-hint">{lockedHint}</span>
    if (support === 'stale') return <span className="muted attach-hint">{t('common.attach.stale')}</span>
    return (
      <div className="attach-bar">
        <button
          type="button"
          className="btn-sm attach-add"
          disabled={!active}
          title={mode === 'files'
            ? `${t('common.attach.addTitle', { count: limits.maxCount, mb: limits.maxBytes / (1024 * 1024) })}. ${t('common.attach.agentReads')}`
            : t('common.attach.addTitleImages')}
          onClick={() => fileRef.current?.click()}
        >
          📎 {t('common.attach.add')}
        </button>
        <input ref={fileRef} type="file" accept={acceptFor(mode)} multiple hidden tabIndex={-1} onChange={onPick} />
        {!compact && (
          <span className="muted attach-hint">
            {(mode === 'files' ? hint : undefined) ?? t(mode === 'files' ? 'common.attach.hint' : 'common.attach.hintImages', { keys: pasteKeys(navigator.platform) })}
          </span>
        )}
      </div>
    )
  }

  return (
    <div
      className={`attach${compact ? ' compact' : ''}${dragging ? ' dragging' : ''}`}
      role={label ? 'group' : undefined}
      aria-label={label}
      onPaste={onPaste}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children}
      {bar()}
      {saved}
      <AttachmentList
        items={draftTiles(items)}
        reading={reading ? 1 : 0}
        compact={compact}
        disabled={disabled}
        onRemove={(key) => attachments.remove(Number(key))}
      />
      {/* По строке на отвергнутый файл. */}
      {error && <span className="error-text attach-error" role="alert">{error}</span>}
    </div>
  )
}
