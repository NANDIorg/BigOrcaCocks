import type React from 'react'
import { useRef, useState } from 'react'
import { DEFAULT_IMAGE_OBJECTIVE, type AttachmentInput } from '@orca-board/core'
import { ipcErrorMessage } from './useAutoSave'
import { useT } from './i18n'
import { builtinText } from './defaultTitles'
import { ImageAttachments } from './ImageAttachments'
import { pasteKeys, useAttachmentDrafts } from './attachmentDrafts'
import { isNoCommitsError } from './initialCommit'

interface Props {
  onClose(): void
  /** Пустая цель приходит только вместе с вложениями — main подставит стандартную. */
  onStart(objective: string, images: AttachmentInput[] | undefined): Promise<void>
  /** Репозиторий без коммитов (`git.noCommits`): окно начального коммита; после коммита оно вызовет `retry`. */
  onNoCommits(retry: () => void): void
}

export function CoordinatorModal({ onClose, onStart, onNoCommits }: Props): React.JSX.Element {
  const t = useT()
  const [objective, setObjective] = useState('')
  const [busy, setBusy] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  // Синхронная защита от двойного запуска (до перерисовки с busy).
  const busyRef = useRef(false)
  const pasted = useAttachmentDrafts({ locked: busy, legacyImages: true })
  const { items, reading } = pasted
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
      // Цель и вложения остаются в форме: после начального коммита запуск повторится с ними же.
      if (isNoCommitsError(err)) onNoCommits(() => void start())
      // Текст и вложения остаются в форме — можно исправить и запустить снова.
      else setStartError(t('shell.app.coordinatorError', { error: ipcErrorMessage(err) }))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const canStart = (objective.trim() !== '' || items.length > 0) && !busy && !reading
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
        <ImageAttachments items={items.map((it) => ({ key: String(it.id), url: it.url }))} reading={reading ? 1 : 0} disabled={busy} onRemove={(key) => pasted.remove(Number(key))} />
        {error && <span className="error-text" style={{ whiteSpace: 'pre-line' }}>{error}</span>}
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
