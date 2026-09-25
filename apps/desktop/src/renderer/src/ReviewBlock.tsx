import type React from 'react'
import { useEffect, useState } from 'react'
import type { ReviewInfo } from '../../shared/ipc'
import { useT } from './i18n'
import { ipcErrorMessage } from './ipcError'

interface Props {
  taskId: string
  summary?: string
  onAccept(): Promise<void>
  onReject(feedback: string): Promise<void>
}

export function ReviewBlock({ taskId, summary, onAccept, onReject }: Props): React.JSX.Element {
  const t = useT()
  const [info, setInfo] = useState<ReviewInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [mode, setMode] = useState<'view' | 'reject'>('view')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.orca.review.info(taskId).then(setInfo).catch((e: unknown) => setError(ipcErrorMessage(e)))
  }, [taskId])

  async function run(fn: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="review" onClick={(e) => e.stopPropagation()}>
      {summary && <div className="summary">{summary}</div>}
      {info && (
        <div className="review-info">
          <div className="review-line">
            <span className="chip mono">{info.branch}</span>
            <span className="muted">→ {info.base}</span>
            {info.dirty && <span className="chip warn">{t('board.review.dirty')}</span>}
          </div>
          {info.commits.length > 0 && (
            <ul className="commits">
              {info.commits.slice(0, 5).map((c) => <li key={c}>{c}</li>)}
            </ul>
          )}
          {info.stat ? <pre className="stat">{info.stat}</pre> : <div className="muted">{t('board.review.noChanges')}</div>}
        </div>
      )}
      {error && <pre className="stat error">{error}</pre>}
      {mode === 'view' ? (
        <div className="actions">
          <button className="btn-sm primary" disabled={busy} onClick={() => run(onAccept)}>
            {busy ? '…' : t('board.review.merge')}
          </button>
          <button className="btn-sm" disabled={busy} onClick={() => setMode('reject')}>{t('board.review.rework')}</button>
        </div>
      ) : (
        <div className="reject">
          <textarea
            autoFocus
            placeholder={t('board.review.feedbackPlaceholder')}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <div className="actions">
            <button className="btn-sm primary" disabled={busy || !feedback.trim()} onClick={() => run(() => onReject(feedback.trim()))}>
              {t('board.review.sendBack')}
            </button>
            <button className="btn-text" onClick={() => setMode('view')}>{t('board.cancel')}</button>
          </div>
        </div>
      )}
    </div>
  )
}
