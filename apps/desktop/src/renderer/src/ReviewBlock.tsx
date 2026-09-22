import type React from 'react'
import { useEffect, useState } from 'react'
import type { ReviewInfo } from '../../shared/ipc'

interface Props {
  taskId: string
  summary?: string
  onAccept(): Promise<void>
  onReject(feedback: string): Promise<void>
}

export function ReviewBlock({ taskId, summary, onAccept, onReject }: Props): React.JSX.Element {
  const [info, setInfo] = useState<ReviewInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [mode, setMode] = useState<'view' | 'reject'>('view')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.orca.review.info(taskId).then(setInfo).catch((e: Error) => setError(e.message))
  }, [taskId])

  async function run(fn: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
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
            {info.dirty && <span className="chip warn">незакоммичено</span>}
          </div>
          {info.commits.length > 0 && (
            <ul className="commits">
              {info.commits.slice(0, 5).map((c) => <li key={c}>{c}</li>)}
            </ul>
          )}
          {info.stat ? <pre className="stat">{info.stat}</pre> : <div className="muted">Изменений нет</div>}
        </div>
      )}
      {error && <pre className="stat error">{error}</pre>}
      {mode === 'view' ? (
        <div className="actions">
          <button className="btn-sm primary" disabled={busy} onClick={() => run(onAccept)}>
            {busy ? '…' : 'Слить и закрыть'}
          </button>
          <button className="btn-sm" disabled={busy} onClick={() => setMode('reject')}>Доработать</button>
        </div>
      ) : (
        <div className="reject">
          <textarea
            autoFocus
            placeholder="Что исправить. Попадёт в промпт при перезапуске."
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <div className="actions">
            <button className="btn-sm primary" disabled={busy || !feedback.trim()} onClick={() => run(() => onReject(feedback.trim()))}>
              Вернуть в работу
            </button>
            <button className="btn-text" onClick={() => setMode('view')}>Отмена</button>
          </div>
        </div>
      )}
    </div>
  )
}
