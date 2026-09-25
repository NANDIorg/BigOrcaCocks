import type React from 'react'
import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import type { DispatchShowcase, HumanRequest, HumanRequestKind, RequestResolution } from '@orca-board/core'
import { Markdown } from './Markdown'
import { ShowcaseBlock } from './ShowcaseBlock'
import { bodyWithoutShowcase } from './showcase'
import { ipcErrorMessage } from './useAutoSave'
import { t as tr, useT } from './i18n'

/** Подпись вида запроса на текущем языке. */
export function requestKindTitle(kind: HumanRequestKind): string {
  return tr(`shell.request.kind.${kind}`)
}

/**
 * Подпись вида запроса в заголовке карточки. Геттеры, а не строки: объект читают и чужие экраны
 * (`TaskModal`), и подпись должна быть на языке, выбранном к моменту отрисовки.
 */
export const REQUEST_KIND_TITLE: Record<HumanRequestKind, string> = {
  get question() { return requestKindTitle('question') },
  get answer() { return requestKindTitle('answer') },
  get escalation() { return requestKindTitle('escalation') },
  get approval() { return requestKindTitle('approval') }
}

const KIND_ICON: Record<HumanRequestKind, string> = { question: '❓', answer: '📄', escalation: '⚠', approval: '✋' }

/** Действия карточки для горячих клавиш Инбокса (InboxPanel): вызываются на выбранной карточке. */
export interface RequestCardHandle {
  /** Вариант вопроса по номеру (1 — первый). */
  option(n: number): void
  /** «Принять» ответ (с решением из поля) или этап воркфлоу. */
  accept(): void
  /** «Уточнить…» ответа / «Вернуть…» этапа воркфлоу: открыть поле текста. */
  clarify(): void
  /** «Перезапустить» эскалацию. */
  restart(): void
  /** Фокус в поле ввода карточки (свой ответ / решение / уточнение). */
  focusInput(): void
}

interface Props {
  request: HumanRequest
  /** Решить запрос; ошибка (reject) показывается на карточке. */
  onResolve(resolution: RequestResolution): Promise<void>
  /** Короткий вид (карточка на доске): без контекста и тела ответа, мелкие кнопки. */
  compact?: boolean
  /** Где запрос: «глобальная › подзадача». */
  where?: string
  /** Метка этапа воркфлоу («Этап «Уточнение»», `requestStageLabel`): вопрос задан агентом на этапе «Вопрос человеку». */
  stage?: string
  /** Карточка выбрана (Инбокс): подсветка и подписи горячих клавиш. */
  active?: boolean
  /** Ответ целиком (answer): без колбэка кнопки «Открыть полностью» нет. */
  onOpenFull?(request: HumanRequest): void
  /** Терминал задачи (escalation): без колбэка кнопки нет. */
  onOpenTerminal?(taskId: string): void
  /** Esc в поле ввода: поле теряет фокус, дальше решает владелец (Инбокс возвращает фокус карточке). */
  onEscape?(): void
  /** Клик по карточке (Инбокс: выбрать её). */
  onSelect?(): void
  /**
   * Показ человеку у approval (`requestShowcase` из showcase.ts по `showcaseDispatchId`): блок «Показ» развёрнут,
   * его раздел убирается из body. Нет — показ остаётся только текстом в body (старый запрос, нет снимка dispatch).
   */
  showcase?: DispatchShowcase
}

/** Enter — отправить, Shift+Enter — перенос строки, Esc — выйти из поля. */
function submitKeys(send: () => void, escape?: () => void): (e: React.KeyboardEvent<HTMLTextAreaElement>) => void {
  return (e) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      e.currentTarget.blur()
      escape?.()
    }
  }
}

/** Подсказка горячей клавиши на кнопке — только у выбранной карточки Инбокса. */
function Kbd({ show, k }: { show: boolean; k: string }): React.JSX.Element | null {
  return show ? <kbd className="rq-kbd">{k}</kbd> : null
}

/**
 * Запрос к человеку (HumanRequest): вопрос с вариантами и своим ответом, ответ задачи-ответа с
 * «Принять» + решение / «Уточнить…», эскалация с «Перезапустить» / «Терминал» / «Скрыть»,
 * этап воркфлоу «человек» (approval) с «Принять» / «Вернуть…» и замечаниями.
 * Поля ввода — свои у каждой карточки. Один компонент для Инбокса, карточки на доске и модалки задачи.
 */
export const RequestCard = forwardRef<RequestCardHandle, Props>(function RequestCard(props, ref) {
  const { request: r, onResolve, compact = false, where, stage, active = false, onOpenFull, onOpenTerminal, onEscape, onSelect, showcase } = props
  const [text, setText] = useState('')
  const [decision, setDecision] = useState('')
  const [clarifying, setClarifying] = useState(false)
  const [clarifyText, setClarifyText] = useState('')
  const [showBody, setShowBody] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const clarifyRef = useRef<HTMLTextAreaElement>(null)
  const hints = active && !compact
  const t = useT()

  async function resolve(resolution: RequestResolution): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onResolve(resolution)
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const sendText = (): void => {
    if (text.trim()) void resolve({ action: 'answer', text: text.trim() })
  }
  const accept = (): void => void resolve({ action: 'accept', ...(decision.trim() ? { text: decision.trim() } : {}) })
  const sendClarify = (): void => {
    if (clarifyText.trim()) void resolve({ action: 'clarify', text: clarifyText.trim() })
  }
  // Этап воркфлоу «человек»: «Вернуть» — с замечаниями, они уйдут воркеру при следующем запуске.
  const sendReject = (): void => {
    if (clarifyText.trim()) void resolve({ action: 'reject', text: clarifyText.trim() })
  }
  const openClarify = (): void => {
    setClarifying(true)
    // Поле появится после перерисовки.
    setTimeout(() => clarifyRef.current?.focus(), 0)
  }

  useImperativeHandle(ref, () => ({
    option(n) {
      const o = r.kind === 'question' ? r.options[n - 1] : undefined
      if (o) void resolve({ action: 'answer', optionId: o.id })
    },
    accept() {
      if (r.kind === 'answer' || r.kind === 'approval') accept()
    },
    clarify() {
      if (r.kind === 'answer' || r.kind === 'approval') openClarify()
    },
    restart() {
      if (r.kind === 'escalation') void resolve({ action: 'restart' })
    },
    focusInput() {
      ;(clarifying ? clarifyRef : inputRef).current?.focus()
    }
  }))

  const shownShowcase = r.kind === 'approval' && !compact ? showcase : undefined
  const body = bodyWithoutShowcase(r.body, shownShowcase)
  const bodyLabel = t(r.kind === 'answer' ? 'shell.request.body.answer' : r.kind === 'question' ? 'shell.request.body.context' : r.kind === 'approval' ? 'shell.request.body.check' : 'shell.request.body.details')

  return (
    <div className={`rq rq-${r.kind}${compact ? ' compact' : ''}${active ? ' active' : ''}`} onClick={onSelect}>
      <div className="rq-head">
        <span className="rq-kind">{KIND_ICON[r.kind]} {requestKindTitle(r.kind)}</span>
        {where && <span className="rq-where" title={where}>· {where}</span>}
        {stage && <span className="rq-stage" title={t('shell.request.stageHint')}>{stage}</span>}
      </div>
      <div className="rq-title">{r.title}</div>

      {shownShowcase && <ShowcaseBlock taskId={r.taskId} showcase={shownShowcase} />}

      {body && !compact && (
        <div className="rq-body">
          <button className="rq-toggle" onClick={() => setShowBody((v) => !v)} aria-expanded={showBody}>
            {showBody ? '▾' : '▸'} {bodyLabel}
          </button>
          {showBody && <Markdown text={body} className="rq-md" />}
        </div>
      )}

      {r.kind === 'question' && (
        <>
          {r.options.length > 0 && (
            <div className="rq-options">
              {r.options.map((o, i) => (
                <button
                  key={o.id}
                  className={`rq-option${o.recommended ? ' recommended' : ''}`}
                  disabled={busy}
                  title={o.hint ?? o.label}
                  onClick={() => void resolve({ action: 'answer', optionId: o.id })}
                >
                  {i < 9 && <Kbd show={hints} k={String(i + 1)} />}
                  <span className="rq-option-label">{o.label}</span>
                  {o.recommended && <span className="rq-star" title={t('shell.request.recommended')}>★</span>}
                  {o.hint && !compact && <span className="rq-hint">{o.hint}</span>}
                </button>
              ))}
            </div>
          )}
          <div className="rq-free">
            <textarea
              ref={inputRef}
              rows={1}
              value={text}
              placeholder={t(r.options.length ? 'shell.request.ownAnswer' : 'shell.request.answerPlaceholder')}
              aria-label={t('shell.request.ownAnswerLabel')}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={submitKeys(sendText, onEscape)}
            />
            <button className="btn-sm primary" disabled={busy || !text.trim()} onClick={sendText} title={t('shell.request.sendHint')}>
              {busy ? '…' : t('shell.request.reply')}
            </button>
          </div>
        </>
      )}

      {r.kind === 'answer' && (
        <>
          {onOpenFull && r.body && (
            <div>
              <button className="btn-text rq-open" onClick={() => onOpenFull(r)}>{t('shell.request.openFull')}</button>
            </div>
          )}
          {clarifying ? (
            <div className="rq-free rq-stack">
              <textarea
                ref={clarifyRef}
                value={clarifyText}
                placeholder={t('shell.request.clarifyPlaceholder')}
                aria-label={t('shell.request.clarifyLabel')}
                disabled={busy}
                onChange={(e) => setClarifyText(e.target.value)}
                onKeyDown={submitKeys(sendClarify, onEscape)}
              />
              <div className="rq-actions">
                <button className="btn-sm primary" disabled={busy || !clarifyText.trim()} onClick={sendClarify}>
                  {busy ? '…' : t('shell.request.sendClarify')}
                </button>
                <button className="btn-text" disabled={busy} onClick={() => setClarifying(false)}>{t('shell.cancel')}</button>
              </div>
            </div>
          ) : (
            <div className="rq-free rq-stack">
              <textarea
                ref={inputRef}
                rows={compact ? 1 : 2}
                value={decision}
                placeholder={t('shell.request.decisionPlaceholder')}
                aria-label={t('shell.request.decisionLabel')}
                disabled={busy}
                onChange={(e) => setDecision(e.target.value)}
                onKeyDown={submitKeys(accept, onEscape)}
              />
              <div className="rq-actions">
                <button className="btn-sm primary" disabled={busy} onClick={accept}>
                  <Kbd show={hints} k="A" />{busy ? '…' : t('shell.request.accept')}
                </button>
                <button className="btn-sm" disabled={busy} onClick={openClarify}>
                  <Kbd show={hints} k="C" />{t('shell.request.clarify')}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {r.kind === 'approval' && (
        <div className="rq-free rq-stack">
          {clarifying ? (
            <>
              <textarea
                ref={clarifyRef}
                value={clarifyText}
                placeholder={t('shell.request.rejectPlaceholder')}
                aria-label={t('shell.request.rejectLabel')}
                disabled={busy}
                onChange={(e) => setClarifyText(e.target.value)}
                onKeyDown={submitKeys(sendReject, onEscape)}
              />
              <div className="rq-actions">
                <button className="btn-sm primary" disabled={busy || !clarifyText.trim()} onClick={sendReject}>
                  {busy ? '…' : t('shell.request.reject')}
                </button>
                <button className="btn-text" disabled={busy} onClick={() => setClarifying(false)}>{t('shell.cancel')}</button>
              </div>
            </>
          ) : (
            <>
              {!compact && (
                <textarea
                  ref={inputRef}
                  rows={1}
                  className="rq-decision"
                  value={decision}
                  placeholder={t('shell.request.approvalPlaceholder')}
                  title={t('shell.request.approvalHint')}
                  aria-label={t('shell.request.decisionLabel')}
                  disabled={busy}
                  onChange={(e) => setDecision(e.target.value)}
                  onKeyDown={submitKeys(accept, onEscape)}
                />
              )}
              <div className="rq-actions">
                <button className="btn-sm primary" disabled={busy} onClick={accept} title={t('shell.request.acceptHint')}>
                  <Kbd show={hints} k="A" />{busy ? '…' : t('shell.request.accept')}
                </button>
                <button className="btn-sm" disabled={busy} onClick={openClarify}>
                  <Kbd show={hints} k="C" />{t('shell.request.rejectMore')}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {r.kind === 'escalation' && (
        <div className="rq-actions">
          <button className="btn-sm primary" disabled={busy} onClick={() => void resolve({ action: 'restart' })}>
            <Kbd show={hints} k="R" />{busy ? '…' : t('shell.request.restart')}
          </button>
          {onOpenTerminal && (
            <button className="btn-sm" disabled={busy} onClick={() => onOpenTerminal(r.taskId)}>{t('shell.request.terminal')}</button>
          )}
          <button className="btn-sm" disabled={busy} onClick={() => void resolve({ action: 'dismiss' })} title={t('shell.request.dismissHint')}>
            {t('shell.request.dismiss')}
          </button>
        </div>
      )}

      {error && <span className="error-text">{error}</span>}
    </div>
  )
})
