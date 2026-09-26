import type React from 'react'
import { useRef, useState } from 'react'
import { DEFAULT_IMAGE_OBJECTIVE, type ImageAttachmentInput } from '@orca-board/core'
import { ipcErrorMessage } from './useAutoSave'
import { useT } from './i18n'
import { builtinText } from './defaultTitles'
import { ImageAttachField } from './ImageAttachField'
import { useImageAttachments } from './imageAttachments'

interface Props {
  onClose(): void
  /** Пустая цель приходит только вместе с изображениями — main подставит стандартную. */
  onStart(objective: string, images: ImageAttachmentInput[]): Promise<void>
}

export function CoordinatorModal({ onClose, onStart }: Props): React.JSX.Element {
  const t = useT()
  const [objective, setObjective] = useState('')
  const attachments = useImageAttachments()
  const { images, reading } = attachments
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Синхронная защита от двойного запуска (до перерисовки с busy).
  const busyRef = useRef(false)

  const start = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await onStart(objective.trim(), attachments.payload() ?? [])
    } catch (err) {
      // Текст и вложения остаются в форме — можно исправить и запустить снова.
      setError(t('shell.app.coordinatorError', { error: ipcErrorMessage(err) }))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const canStart = (objective.trim() !== '' || images.length > 0) && !busy && !reading
  const close = (): void => {
    if (!busyRef.current) onClose()
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t('shell.coordModal.title')}</h3>
        <p className="muted" style={{ margin: 0 }}>{t('shell.coordModal.intro')}</p>
        {/* Картинки к цели уходят в startCoordinator, который был и до картинок к замечаниям, — рукопожатие не нужно. */}
        <ImageAttachField
          attachments={attachments}
          disabled={busy}
          checkApp={false}
          hint={t('shell.coordModal.pasteHint', { keys: navigator.platform.startsWith('Mac') ? '⌘V' : 'Ctrl+V', goal: builtinText(DEFAULT_IMAGE_OBJECTIVE) })}
        >
          <label>
            {t('shell.coordModal.goal')}
            <textarea
              autoFocus
              value={objective}
              readOnly={busy}
              onChange={(e) => setObjective(e.target.value)}
              placeholder={t('shell.coordModal.goalPlaceholder')}
            />
          </label>
        </ImageAttachField>
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
