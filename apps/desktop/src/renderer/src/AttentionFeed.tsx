import type React from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { Dispatch, HumanRequest, ImageAttachmentInput, Question, RequestResolution, Task } from '@orca-board/core'
import { RequestCard } from './RequestCard'
import { requestShowcase } from './showcase'
import { relativeTime } from './GlobalBoard'
import { formatStamp } from './boardSort'
import { ipcErrorMessage } from './useAutoSave'
import { useNow } from './useNow'
import { isTypingTarget } from './hotkeys'
import { useT } from './i18n'
import { ImageAttachField } from './ImageAttachField'
import { useImageAttachments } from './imageAttachments'
import { onFocusFeed, onRevealInFeed, revealOnBoard, scrollBehavior } from './feedLink'
import {
  ATTENTION_COLOR, ATTENTION_GLYPH, attentionCountTitle, attentionLabel, attentionSummary, defaultCollapsed, feedItemOfTask, questionAnswerText, questionAsRequest,
  readCollapsed, writeCollapsed, type AttentionItem
} from './attention'

/** Сколько подсвечен пункт, к которому прокрутили с доски (мс). */
const HIGHLIGHT_MS = 2500

interface Props {
  items: AttentionItem[]
  /** Подзадачи глобальной задачи: имя задачи на карточке ленты и что перезапускать. */
  tasks: Task[]
  runId: string
  dispatches: Dispatch[]
  /** Запросы к человеку — тот же колбэк, что у Инбокса и модалки задачи. */
  onResolveRequest(request: HumanRequest, resolution: RequestResolution, images?: ImageAttachmentInput[]): Promise<void>
  /** Вопрос воркера без запроса — ответ уходит вопросу (`questions.answer`). */
  onAnswerQuestion(questionId: string, answer: string): Promise<void>
  /** Ревью-действия задачи (`review.accept` / `review.reject`): у ответа — «Принять» / «Уточнить», у кода — «Принять» / «Вернуть». */
  onAcceptTask(taskId: string): Promise<void>
  onRejectTask(taskId: string, feedback: string, images?: ImageAttachmentInput[]): Promise<void>
  onStartTask(task: Task): void | Promise<void>
  onOpenTask(taskId: string): void
  onOpenTerminal(taskId: string): void
}

/**
 * Лента «Ждут вас»: всё, что ждёт человека в этой глобальной задаче, — одна строка карточек с прокруткой вбок
 * (сбои, вопросы, показ, ответы). Отвечать можно прямо в ленте; сворачивается в полосу-сводку, выбор помнит
 * localStorage. Пунктов нет — компонент ничего не рисует. Клавиша G — фокус в ленту, стрелки — между карточками.
 */
export function AttentionFeed(props: Props): React.JSX.Element | null {
  const { items, tasks, runId, dispatches, onResolveRequest, onAnswerQuestion, onAcceptTask, onRejectTask, onStartTask, onOpenTask, onOpenTerminal } = props
  const t = useT()
  const now = useNow()
  const headId = useId()
  const listId = useId()
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed() ?? defaultCollapsed(items.length, window.innerWidth))
  const [highlight, setHighlight] = useState<string | null>(null)
  /** Пункт, чьи подробности открыты под лентой (показ, ответ целиком). */
  const [detailId, setDetailId] = useState<string | null>(null)
  const [tabIndex, setTabIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const itemsRef = useRef(items)
  itemsRef.current = items
  const tabIndexRef = useRef(tabIndex)
  tabIndexRef.current = tabIndex
  const timers = useRef<number[]>([])
  const taskById = new Map(tasks.map((task) => [task.id, task]))

  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), [])
  const later = useCallback((fn: () => void, ms = 0): void => {
    timers.current.push(window.setTimeout(fn, ms))
  }, [])

  const cardOf = useCallback((id?: string): HTMLElement | null => {
    const list = listRef.current
    if (!list) return null
    const cards = [...list.querySelectorAll<HTMLElement>('.act-card')]
    return (id ? cards.find((c) => c.dataset.attnId === id) : cards[0]) ?? null
  }, [])

  const toggle = (): void => {
    setCollapsed((prev) => {
      writeCollapsed(!prev)
      return !prev
    })
  }

  // «в ленте ↑» на доске: развернуть (не запоминая), прокрутить, подсветить и дать фокус карточке.
  useEffect(() => onRevealInFeed((taskId) => {
    const item = feedItemOfTask(itemsRef.current, taskId)
    if (!item) return
    setCollapsed(false)
    setHighlight(item.id)
    // Табуляция и клавиша G после этого ведут к тому же пункту, а не к прежнему.
    setTabIndex(itemsRef.current.indexOf(item))
    later(() => {
      const card = cardOf(item.id)
      card?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: scrollBehavior() })
      card?.focus({ preventScroll: true })
    })
    later(() => setHighlight((cur) => (cur === item.id ? null : cur)), HIGHLIGHT_MS)
  }), [cardOf, later])

  // Клавиша G (её ловит экран глобальной задачи): фокус в ленту, развернув её, если свёрнута.
  useEffect(() => onFocusFeed(() => {
    if (itemsRef.current.length === 0) return
    setCollapsed(false)
    later(() => {
      const card = cardOf(itemsRef.current[tabIndexRef.current]?.id) ?? cardOf()
      card?.focus({ preventScroll: true })
      card?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: scrollBehavior() })
    })
  }), [cardOf, later])

  // Подробности закрытого (решённого) пункта не остаются висеть.
  const detail = items.find((i) => i.id === detailId && i.request)
  const detailRequest = detail?.request
  useEffect(() => {
    if (detailId && !detail) setDetailId(null)
  }, [detailId, detail])
  const active = Math.min(tabIndex, items.length - 1)

  if (items.length === 0) return null

  const moveFocus = (e: React.KeyboardEvent<HTMLElement>, index: number): void => {
    if (e.target !== e.currentTarget) return
    const to = e.key === 'ArrowRight' ? index + 1 : e.key === 'ArrowLeft' ? index - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null
    if (to === null) return
    e.preventDefault()
    const next = Math.max(0, Math.min(items.length - 1, to))
    setTabIndex(next)
    later(() => cardOf(items[next].id)?.focus())
  }

  const sum = attentionSummary(items)
  const detailTask = detail ? taskById.get(detail.taskId) : undefined

  return (
    <section className={`attn${collapsed ? ' collapsed' : ''}`} aria-labelledby={headId}>
      <div className="attn-head">
        <h3 id={headId}>{t('shell.feed.title')} <span className="attn-n" title={attentionCountTitle(items)}>{items.length}</span></h3>
        <span className="attn-sum" aria-live="polite">{sum}</span>
        <span className="grow" />
        <span className="muted attn-hint"><kbd className="rq-kbd">G</kbd> {t('shell.feed.keyHint')}</span>
        <button type="button" className="btn-sm" aria-expanded={!collapsed} aria-controls={listId} onClick={toggle}>
          {collapsed ? t('shell.feed.expand') : t('shell.feed.collapse')}
        </button>
      </div>
      <div id={listId} ref={listRef} className="attn-list" role="list" hidden={collapsed}>
        {items.map((item, i) => (
          <FeedCard
            key={item.id}
            item={item}
            task={taskById.get(item.taskId)}
            runId={runId}
            now={now}
            highlighted={highlight === item.id}
            tabIndex={i === active ? 0 : -1}
            onKeyDown={(e) => moveFocus(e, i)}
            onFocus={() => setTabIndex(i)}
            detailOpen={detailId === item.id}
            onToggleDetail={() => setDetailId((cur) => (cur === item.id ? null : item.id))}
            onResolveRequest={onResolveRequest}
            onAnswerQuestion={onAnswerQuestion}
            onAcceptTask={onAcceptTask}
            onRejectTask={onRejectTask}
            onStartTask={onStartTask}
            onOpenTask={onOpenTask}
            onOpenTerminal={onOpenTerminal}
          />
        ))}
      </div>
      {detail && detailRequest && !collapsed && (
        <div
          className="attn-detail"
          role="region"
          aria-label={t('shell.feed.detailLabel', { title: detailTask?.title ?? detail.taskId })}
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || isTypingTarget(e.target)) return
            e.preventDefault()
            setDetailId(null)
            cardOf(detail.id)?.focus()
          }}
        >
          <div className="attn-detail-head">
            <span className="muted">{t('shell.feed.detailHead', { title: detailTask?.title ?? detail.taskId })}</span>
            <button type="button" className="btn-text" onClick={() => { setDetailId(null); cardOf(detail.id)?.focus() }}>{t('common.close')}</button>
          </div>
          <RequestCard
            request={detailRequest}
            showcase={requestShowcase(detailRequest, dispatches)}
            where={detailTask?.title ?? detail.taskId}
            onResolve={(res, images) => onResolveRequest(detailRequest, res, images)}
            onOpenFull={(req) => { if (req.taskId !== undefined) onOpenTask(req.taskId) }}
            onOpenTerminal={onOpenTerminal}
          />
        </div>
      )}
    </section>
  )
}

interface CardProps {
  item: AttentionItem
  task?: Task
  runId: string
  now: number
  highlighted: boolean
  tabIndex: number
  onKeyDown(e: React.KeyboardEvent<HTMLElement>): void
  onFocus(): void
  detailOpen: boolean
  onToggleDetail(): void
  onResolveRequest: Props['onResolveRequest']
  onAnswerQuestion: Props['onAnswerQuestion']
  onAcceptTask: Props['onAcceptTask']
  onRejectTask: Props['onRejectTask']
  onStartTask: Props['onStartTask']
  onOpenTask: Props['onOpenTask']
  onOpenTerminal: Props['onOpenTerminal']
}

/** Сколько подписей файлов показа на карточке: остальные — «+N». */
const THUMBS = 3

function FeedCard(props: CardProps): React.JSX.Element {
  const { item, task, runId, now, highlighted, detailOpen, onToggleDetail, onResolveRequest, onAnswerQuestion, onAcceptTask, onRejectTask, onStartTask, onOpenTask, onOpenTerminal } = props
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clarifying, setClarifying] = useState(false)
  const [text, setText] = useState('')
  const attachments = useImageAttachments()
  const t = useT()
  const taskTitle = task?.title ?? item.taskId
  const label = attentionLabel(item)
  const request = item.request

  async function run(fn: () => void | Promise<void>): Promise<boolean> {
    if (busy) return false
    setBusy(true)
    setError(null)
    try {
      await fn()
      return true
    } catch (e) {
      setError(ipcErrorMessage(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  /** Ответ на вопрос без запроса → `questions.answer`, иначе запрос решается как обычно. */
  const resolve = (res: RequestResolution, images?: ImageAttachmentInput[]): Promise<void> => {
    if (request) return onResolveRequest(request, res, images)
    const q = item.question as Question
    return onAnswerQuestion(q.id, questionAnswerText(q, res))
  }

  const sendClarify = (): void => {
    const note = text.trim()
    if (!note || attachments.reading) return
    void run(async () => {
      const images = attachments.payload()
      if (request) await onResolveRequest(request, { action: 'clarify', text: note }, images)
      else await onRejectTask(item.taskId, note, images)
      setClarifying(false)
      setText('')
      attachments.clear()
    })
  }
  const cancelClarify = (): void => {
    attachments.clear()
    setClarifying(false)
  }
  const accept = (): void => void run(() => (request ? onResolveRequest(request, { action: 'accept' }) : onAcceptTask(item.taskId)))

  const isReview = item.kind === 'review'
  const clarifyLabel = t(isReview ? 'shell.request.rejectMore' : 'shell.request.clarify')
  const shownFiles = item.showcaseFiles ?? []

  return (
    <article
      className={`act-card act-${item.kind}${highlighted ? ' hl' : ''}`}
      role="listitem"
      tabIndex={props.tabIndex}
      data-attn-id={item.id}
      data-task-id={item.taskId}
      aria-label={`${label}: ${taskTitle}`}
      style={{ '--k': ATTENTION_COLOR[item.kind] } as React.CSSProperties}
      onKeyDown={props.onKeyDown}
      onFocus={(e) => { if (e.target === e.currentTarget) props.onFocus() }}
    >
      <div className="act-kind">
        <span aria-hidden>{ATTENTION_GLYPH[item.kind]}</span>
        <span>{label}</span>
        <span className="grow" />
        <span className="act-ago" title={formatStamp(item.at)}>{relativeTime(item.at, now)}</span>
      </div>
      <button type="button" className="act-task" title={t('shell.feed.showOnBoard', { title: taskTitle })} onClick={() => revealOnBoard(item.taskId)}>{taskTitle}</button>

      {(item.kind === 'question' || (item.kind === 'failure' && request)) && (
        <RequestCard
          compact
          request={request ?? questionAsRequest(item.question as Question, runId)}
          onResolve={resolve}
          onOpenTerminal={onOpenTerminal}
        />
      )}

      {!(item.kind === 'question' || (item.kind === 'failure' && request)) && <div className="act-q" title={item.title}>{item.title}</div>}

      {item.kind === 'showcase' && shownFiles.length > 0 && (
        <ul className="act-thumbs" aria-label={t('shell.feed.files')}>
          {shownFiles.slice(0, THUMBS).map((f) => <li key={f} className="act-thumb" title={f}>{f.split('/').pop()}</li>)}
          {shownFiles.length > THUMBS && <li className="act-thumb more">+{shownFiles.length - THUMBS}</li>}
        </ul>
      )}

      {clarifying ? (
        <div className="act-clarify">
          <ImageAttachField attachments={attachments} disabled={busy} compact>
            <textarea
              rows={2}
              autoFocus
              value={text}
              disabled={busy}
              aria-label={t(isReview ? 'shell.request.rejectLabel' : 'shell.request.clarifyLabel')}
              placeholder={t(isReview ? 'shell.feed.rejectPlaceholder' : 'shell.feed.clarifyPlaceholder')}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  sendClarify()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  cancelClarify()
                }
              }}
            />
          </ImageAttachField>
          <div className="act-row">
            <button type="button" className="btn-sm primary" disabled={busy || attachments.reading || !text.trim()} onClick={sendClarify}>{busy ? '…' : t('shell.feed.send')}</button>
            <button type="button" className="btn-text" disabled={busy} onClick={cancelClarify}>{t('shell.cancel')}</button>
          </div>
        </div>
      ) : (
        <>
          {item.kind === 'failure' && !request && task && (
            <div className="act-row">
              <button type="button" className="btn-sm primary" disabled={busy} onClick={() => void run(() => onStartTask(task))}>{t('shell.feed.restart')}</button>
              <button type="button" className="btn-sm" onClick={() => onOpenTerminal(item.taskId)}>{t('shell.request.terminal')}</button>
            </div>
          )}
          {(item.kind === 'showcase' || item.kind === 'approval') && (
            <div className="act-row">
              <button type="button" className="btn-sm primary" aria-expanded={detailOpen} onClick={onToggleDetail}>
                {detailOpen ? t('shell.feed.hide') : t(item.kind === 'showcase' ? 'shell.feed.viewDecide' : 'shell.feed.openDecide')}
              </button>
            </div>
          )}
          {(item.kind === 'answer' || isReview) && (
            <div className="act-row">
              {request ? (
                <button type="button" className="btn-sm primary" aria-expanded={detailOpen} onClick={onToggleDetail}>{detailOpen ? t('shell.feed.hide') : t('shell.feed.read')}</button>
              ) : (
                <button type="button" className="btn-sm primary" onClick={() => onOpenTask(item.taskId)}>{t(isReview ? 'shell.feed.open' : 'shell.feed.read')}</button>
              )}
              <button type="button" className="btn-sm ok" disabled={busy} onClick={accept}>{busy ? '…' : t('shell.request.accept')}</button>
              <button type="button" className="btn-sm" disabled={busy} onClick={() => setClarifying(true)}>{clarifyLabel}</button>
            </div>
          )}
        </>
      )}
      {error && <span className="error-text">{error}</span>}
    </article>
  )
}
