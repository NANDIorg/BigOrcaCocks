import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { GlobalTask, ImageAttachmentInput } from '@orca-board/core'
import { ipcErrorMessage } from './useAutoSave'
import { isRunWorkflow, returnHint, reviewErrorMessage } from './globalReview'
import { useT } from './i18n'
import { ImageAttachField } from './ImageAttachField'
import { useAttachmentDrafts } from './attachmentDrafts'
import { lightboxOpen } from './imageViewer'

interface Props {
  global: GlobalTask
  /** Прежний координатор ещё жив — его терминал закроется при возврате (предупреждаем). */
  closesCoordinator?: boolean
  /**
   * Сколько approval прогона ждут решения. Больше одного у прогона с воркфлоу — параллельные пути: «Вернуть» идёт по
   * переходу одной ноды `human`, и какой путь возвращать, окно не знает — отправка выключена, подсказка про «Входящие».
   */
  approvals?: number
  /** Путь разветвления, который вернётся (`reviewLaneTitle`): ждущий approval один и стоит внутри пути. Нет — прежние тексты. */
  lane?: string
  onClose(): void
  /** Возврат с уточнением: задача уходит в работу, запускается координатор. Ошибка остаётся в модалке. */
  onSubmit(text: string, images?: ImageAttachmentInput[]): Promise<void>
}

/** «Вернуть в работу…» с «Проверки»: что доделать — обязательно, это уточнение попадёт в цель координатора. */
export function ReturnGlobalModal({ global, closesCoordinator = false, approvals = 0, lane, onClose, onSubmit }: Props): React.JSX.Element {
  const t = useT()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const attachments = useAttachmentDrafts()
  const many = approvals > 1 && isRunWorkflow(global)
  const canSubmit = !busy && text.trim() !== '' && !attachments.reading && !many
  const title = lane !== undefined && !many ? t('global.return.titleLane', { lane }) : t('global.return.title')

  const close = (): void => {
    if (!busyRef.current) onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Esc поверх открытой картинки закрывает только её (ImageLightbox слушает тот же window).
      if (e.key === 'Escape' && !lightboxOpen()) {
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
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
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
        {many
          ? <span className="muted g-return-hint">{t('global.action.manyApprovals', { count: approvals })}. {t('global.action.manyApprovalsTitle')}</span>
          : <span className="muted g-return-hint">{returnHint(closesCoordinator, isRunWorkflow(global), lane)} {t('global.return.send')}</span>}
        {error && <span className="error-text">{error}</span>}
        <div className="row">
          <button className="btn-text" onClick={close} disabled={busy}>{t('global.cancel')}</button>
          <button className="btn-primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? t('global.return.busy') : title}
          </button>
        </div>
      </div>
    </div>
  )
}
