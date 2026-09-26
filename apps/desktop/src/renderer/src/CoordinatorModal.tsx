import type React from 'react'
import { useRef, useState } from 'react'
import { DEFAULT_IMAGE_OBJECTIVE, type ImageAttachmentInput } from '@orca-board/core'
import { ipcErrorMessage } from './useAutoSave'
import { useT } from './i18n'
import { builtinText } from './defaultTitles'
import { ImageAttachments } from './ImageAttachments'
import { pasteKeys } from './imagePaste'
import { useImageAttachments } from './useImageAttachments'

interface Props {
  onClose(): void
  /** Пустая цель приходит только вместе с изображениями — main подставит стандартную. */
  onStart(objective: string, images: ImageAttachmentInput[]): Promise<void>
}

export function CoordinatorModal({ onClose, onStart }: Props): React.JSX.Element {
  const t = useT()
  const [objective, setObjective] = useState('')
  const [busy, setBusy] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  // Синхронная защита от двойного запуска (до перерисовки с busy).
  const busyRef = useRef(false)
  const pasted = useImageAttachments({ locked: busy })
  const { images, reading } = pasted
  const error = pasted.error ?? startError

  const start = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setStartError(null)
    pasted.clearError()
    try {
      await onStart(objective.trim(), pasted.payload())
    } catch (err) {
      // Текст и вложения остаются в форме — можно исправить и запустить снова.
      setStartError(t('shell.app.coordinatorError', { error: ipcErrorMessage(err) }))
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
            onPaste={pasted.onPaste}
            placeholder={t('shell.coordModal.goalPlaceholder')}
          />
        </label>
        <span className="muted coord-hint">
          {t('shell.coordModal.pasteHint', { keys: pasteKeys(navigator.platform), goal: builtinText(DEFAULT_IMAGE_OBJECTIVE) })}
        </span>
        <ImageAttachments items={images.map((img) => ({ key: String(img.id), url: img.url }))} reading={reading} disabled={busy} onRemove={(key) => pasted.remove(Number(key))} />
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
