import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { GlobalTask, ImageAttachmentInput } from '@orca-board/core'
import { ipcErrorMessage } from './useAutoSave'
import { isRunWorkflow, returnHint, reviewErrorMessage } from './globalReview'
import { useT } from './i18n'
import { ImageAttachField } from './ImageAttachField'
import { useImageAttachments } from './imageDrafts'

interface Props {
  global: GlobalTask
  /** Прежний координатор ещё жив — его терминал закроется при возврате (предупреждаем). */
  closesCoordinator?: boolean
  onClose(): void
  /** Возврат с уточнением: задача уходит в работу, запускается координатор. Ошибка остаётся в модалке. */
  onSubmit(text: string, images?: ImageAttachmentInput[]): Promise<void>
}

/** «Вернуть в работу…» с «Проверки»: что доделать — обязательно, это уточнение попадёт в цель координатора. */
export function ReturnGlobalModal({ global, closesCoordinator = false, onClose, onSubmit }: Props): React.JSX.Element {
  const t = useT()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const attachments = useImageAttachments()
  const canSubmit = !busy && text.trim() !== '' && !attachments.reading

  const close = (): void => {
    if (!busyRef.current) onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const submit = async (): Promise<void> => {
    if (busyRef.current || !canSubmit) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await onSubmit(text.trim(), attachments.payload())
    } catch (e) {
      setError(reviewErrorMessage(e))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={t('global.return.title')} onClick={(e) => e.stopPropagation()}>
        <h3>{t('global.return.title')}</h3>
        <p className="muted modal-sub" title={global.title}>{global.title}</p>
        <ImageAttachField attachments={attachments} disabled={busy}>
          <label>
            {t('global.return.what')}
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
              }}
              placeholder={t('global.return.placeholder')}
            />
          </label>
        </ImageAttachField>
        <span className="muted g-return-hint">{returnHint(closesCoordinator, isRunWorkflow(global))} {t('global.return.send')}</span>
        {error && <span className="error-text">{error}</span>}
        <div className="row">
          <button className="btn-text" onClick={close} disabled={busy}>{t('global.cancel')}</button>
          <button className="btn-primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? t('global.return.busy') : t('global.return.title')}
          </button>
        </div>
      </div>
    </div>
  )
}
