import type React from 'react'
import { useState } from 'react'
import type { AnswerAudience } from '@orca-board/core'
import { Markdown } from './Markdown'

interface Props {
  answer: string
  /** Суть ответа одной строкой (`done --summary`). */
  summary?: string
  answerFor: AnswerAudience
  /** Ответ ждёт решения (задача в колонке review): показать «Принять» / «Уточнить». */
  actionable: boolean
  onAccept(): Promise<void>
  /** Вернуть воркеру с уточнением и перезапустить его. */
  onClarify(text: string): Promise<void>
}

/** Ответ задачи-ответа: markdown, а под ним — принять или уточнить (уточнение перезапускает воркера). */
export function AnswerBlock({ answer, summary, answerFor, actionable, onAccept, onClarify }: Props): React.JSX.Element {
  const [mode, setMode] = useState<'view' | 'clarify'>('view')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(fn: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="answer">
      {summary && <div className="answer-summary">{summary}</div>}
      <Markdown text={answer} className="answer-body" />
      {actionable && answerFor === 'coordinator' && (
        <div className="muted">Ответ предназначен координатору — он примет его сам. Принять можно и вручную.</div>
      )}
      {error && <span className="error-text">{error}</span>}
      {actionable && (mode === 'view' ? (
        <div className="actions">
          <button className="btn-sm primary" disabled={busy} onClick={() => void run(onAccept)}>
            {busy ? '…' : 'Принять'}
          </button>
          <button className="btn-sm" disabled={busy} onClick={() => setMode('clarify')}>Уточнить</button>
        </div>
      ) : (
        <div className="reject">
          <textarea
            autoFocus
            placeholder="Что уточнить или раскрыть подробнее. Воркер получит прошлый ответ и это уточнение."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="actions">
            <button className="btn-sm primary" disabled={busy || !text.trim()} onClick={() => void run(() => onClarify(text.trim()))}>
              {busy ? '…' : 'Отправить уточнение'}
            </button>
            <button className="btn-text" disabled={busy} onClick={() => setMode('view')}>Отмена</button>
          </div>
        </div>
      ))}
    </div>
  )
}
