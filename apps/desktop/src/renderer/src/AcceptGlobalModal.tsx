import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { BoardColumn, Dispatch, GlobalTask, HumanRequest, Task } from '@orca-board/core'
import { Markdown } from './Markdown'
import { reviewErrorMessage } from './globalReview'
import { RequestShowcaseBlock } from './ShowcaseBlock'
import { bodyWithoutShowcases, requestShowcases } from './showcase'
import { useT } from './i18n'

interface Props {
  global: GlobalTask
  /** Ждущий approval ноды `human` (`runApprovalRequest`): что человек подтверждает. Нет — запрос ещё не создан, кнопка неактивна. */
  request?: HumanRequest
  /** Подзадачи прогона, колонки и запуски: показ подзадач в approval (`requestShowcases`) — заголовки и состояние блоков. */
  tasks?: Task[]
  columns?: BoardColumn[]
  dispatches?: Dispatch[]
  onClose(): void
  /** «Подтвердить» с решением (пустая строка — без него): граф идёт дальше, решение уйдёт координатору в следующем этапе. */
  onSubmit(decision: string): Promise<void>
}

/**
 * «Подтвердить» у глобальной задачи с воркфлоу: approval ноды `human`. Решение необязательно — это выбранный вариант или
 * пожелание, которое координатор получит в `stage_started` следующего этапа. Ошибка остаётся в окне. Показ подзадач —
 * блоками с превью; в просмотрщике то же поле решения и «Подтвердить» («Вернуть» — отдельная кнопка экрана задачи).
 */
export function AcceptGlobalModal({ global, request, tasks, columns, dispatches, onClose, onSubmit }: Props): React.JSX.Element {
  const t = useT()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const canSubmit = !busy && request !== undefined
  const showcases = request ? requestShowcases(request, dispatches, tasks, (status) => columns?.find((c) => c.id === status)?.kind) : []
  const body = bodyWithoutShowcases(request?.body, showcases)

  const close = (): void => {
    if (!busyRef.current) onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Esc поверх открытого просмотрщика показа закрывает только его (ShowcaseViewer слушает тот же window).
      if (e.key === 'Escape' && !document.querySelector('.sv-host')) {
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
      setError(reviewErrorMessage(e))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className={`modal${showcases.length > 0 ? ' g-accept-modal' : ''}`} role="dialog" aria-modal="true" aria-label={t('global.accept.title')} onClick={(e) => e.stopPropagation()}>
        <h3>{t('global.accept.title')}</h3>
        <p className="muted modal-sub" title={global.title}>{global.title}</p>
        {request ? (
          <>
            <div className="g-accept-check">
              <div className="g-accept-what muted">{t('global.accept.check')}</div>
              <div className="g-accept-title">{request.title}</div>
              {body && <Markdown text={body} className="rq-md" />}
            </div>
            <RequestShowcaseBlock
              items={showcases}
              decision={{ value: text, onChange: setText, onAccept: () => void submit(), busy, acceptLabel: t('global.action.accept') }}
            />
          </>
        ) : (
          <p className="muted">{t('global.accept.noRequest')}</p>
        )}
        <label>
          {t('global.accept.decision')}
          <textarea
            autoFocus
            value={text}
            disabled={request === undefined}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
            }}
            placeholder={t('global.accept.placeholder')}
          />
        </label>
        <span className="muted g-return-hint">{t('global.accept.hint')} {t('global.accept.send')}</span>
        {error && <span className="error-text">{error}</span>}
        <div className="row">
          <button className="btn-text" onClick={close} disabled={busy}>{t('global.cancel')}</button>
          <button className="btn-primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? t('global.accept.busy') : t('global.action.accept')}
          </button>
        </div>
      </div>
    </div>
  )
}
