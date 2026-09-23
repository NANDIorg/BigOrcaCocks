import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { GlobalTask } from '@orca-board/core'
import { ipcErrorMessage } from './useAutoSave'
import { reviewErrorMessage } from './globalReview'

interface Props {
  global: GlobalTask
  onClose(): void
  /** Возврат с уточнением: задача уходит в работу, запускается координатор. Ошибка остаётся в модалке. */
  onSubmit(text: string): Promise<void>
}

/** «Вернуть в работу…» с «Проверки»: что доделать — обязательно, это уточнение попадёт в цель координатора. */
export function ReturnGlobalModal({ global, onClose, onSubmit }: Props): React.JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const canSubmit = !busy && text.trim() !== ''

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
      await onSubmit(text.trim())
    } catch (e) {
      setError(reviewErrorMessage(ipcErrorMessage(e)))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Вернуть в работу" onClick={(e) => e.stopPropagation()}>
        <h3>Вернуть в работу</h3>
        <p className="muted modal-sub" title={global.title}>{global.title}</p>
        <label>
          Что доделать
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
            }}
            placeholder="Что не так с результатом и что нужно изменить. Координатор получит это уточнение и продолжит работу."
          />
        </label>
        <span className="muted g-return-hint">Задача уйдёт в «В работе», и откроется терминал координатора. ⌘/Ctrl+Enter — отправить.</span>
        {error && <span className="error-text">{error}</span>}
        <div className="row">
          <button className="btn-text" onClick={close} disabled={busy}>Отмена</button>
          <button className="btn-primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? 'Запускаю…' : 'Вернуть в работу'}
          </button>
        </div>
      </div>
    </div>
  )
}
