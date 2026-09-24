import type React from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { Dispatch, HumanRequest, Question, RequestResolution, Task } from '@orca-board/core'
import { RequestCard } from './RequestCard'
import { requestShowcase } from './showcase'
import { relativeTime } from './GlobalBoard'
import { formatStamp } from './boardSort'
import { ipcErrorMessage } from './useAutoSave'
import { useNow } from './useNow'
import { isTypingTarget } from './hotkeys'
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
  onResolveRequest(request: HumanRequest, resolution: RequestResolution): Promise<void>
  /** Вопрос воркера без запроса — ответ уходит вопросу (`questions.answer`). */
  onAnswerQuestion(questionId: string, answer: string): Promise<void>
  /** Ревью-действия задачи (`review.accept` / `review.reject`): у ответа — «Принять» / «Уточнить», у кода — «Принять» / «Вернуть». */
  onAcceptTask(taskId: string): Promise<void>
  onRejectTask(taskId: string, feedback: string): Promise<void>
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
  const taskById = new Map(tasks.map((t) => [t.id, t]))

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), [])
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
        <h3 id={headId}>Ждут вас <span className="attn-n" title={attentionCountTitle(items)}>{items.length}</span></h3>
        <span className="attn-sum" aria-live="polite">{sum}</span>
        <span className="grow" />
        <span className="muted attn-hint"><kbd className="rq-kbd">G</kbd> к ленте</span>
        <button type="button" className="btn-sm" aria-expanded={!collapsed} aria-controls={listId} onClick={toggle}>
          {collapsed ? 'Развернуть' : 'Свернуть'}
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
          aria-label={`Подробно: ${detailTask?.title ?? detail.taskId}`}
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || isTypingTarget(e.target)) return
            e.preventDefault()
            setDetailId(null)
            cardOf(detail.id)?.focus()
          }}
        >
          <div className="attn-detail-head">
            <span className="muted">Подробно · {detailTask?.title ?? detail.taskId}</span>
            <button type="button" className="btn-text" onClick={() => { setDetailId(null); cardOf(detail.id)?.focus() }}>Закрыть</button>
          </div>
          <RequestCard
            request={detailRequest}
            showcase={requestShowcase(detailRequest, dispatches)}
            where={detailTask?.title ?? detail.taskId}
            onResolve={(res) => onResolveRequest(detailRequest, res)}
            onOpenFull={(req) => onOpenTask(req.taskId)}
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
  const resolve = (res: RequestResolution): Promise<void> => {
    if (request) return onResolveRequest(request, res)
    const q = item.question as Question
    return onAnswerQuestion(q.id, questionAnswerText(q, res))
  }

  const sendClarify = (): void => {
    const t = text.trim()
    if (!t) return
    void run(async () => {
      if (request) await onResolveRequest(request, { action: 'clarify', text: t })
      else await onRejectTask(item.taskId, t)
      setClarifying(false)
      setText('')
    })
  }
  const accept = (): void => void run(() => (request ? onResolveRequest(request, { action: 'accept' }) : onAcceptTask(item.taskId)))

  const isReview = item.kind === 'review'
  const clarifyLabel = isReview ? 'Вернуть…' : 'Уточнить…'
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
      <button type="button" className="act-task" title={`${taskTitle} — показать на доске`} onClick={() => revealOnBoard(item.taskId)}>{taskTitle}</button>

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
        <ul className="act-thumbs" aria-label="Файлы показа">
          {shownFiles.slice(0, THUMBS).map((f) => <li key={f} className="act-thumb" title={f}>{f.split('/').pop()}</li>)}
          {shownFiles.length > THUMBS && <li className="act-thumb more">+{shownFiles.length - THUMBS}</li>}
        </ul>
      )}

      {clarifying ? (
        <div className="act-clarify">
          <textarea
            rows={2}
            autoFocus
            value={text}
            disabled={busy}
            aria-label={isReview ? 'Замечания' : 'Уточнение'}
            placeholder={isReview ? 'Что исправить. Воркер получит замечания.' : 'Что уточнить. Воркер получит прошлый ответ и это уточнение.'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendClarify()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setClarifying(false)
              }
            }}
          />
          <div className="act-row">
            <button type="button" className="btn-sm primary" disabled={busy || !text.trim()} onClick={sendClarify}>{busy ? '…' : 'Отправить'}</button>
            <button type="button" className="btn-text" disabled={busy} onClick={() => setClarifying(false)}>Отмена</button>
          </div>
        </div>
      ) : (
        <>
          {item.kind === 'failure' && !request && task && (
            <div className="act-row">
              <button type="button" className="btn-sm primary" disabled={busy} onClick={() => void run(() => onStartTask(task))}>↻ Перезапустить</button>
              <button type="button" className="btn-sm" onClick={() => onOpenTerminal(item.taskId)}>Терминал</button>
            </div>
          )}
          {(item.kind === 'showcase' || item.kind === 'approval') && (
            <div className="act-row">
              <button type="button" className="btn-sm primary" aria-expanded={detailOpen} onClick={onToggleDetail}>
                {detailOpen ? 'Скрыть' : item.kind === 'showcase' ? 'Смотреть и решить' : 'Открыть и решить'}
              </button>
            </div>
          )}
          {(item.kind === 'answer' || isReview) && (
            <div className="act-row">
              {request ? (
                <button type="button" className="btn-sm primary" aria-expanded={detailOpen} onClick={onToggleDetail}>{detailOpen ? 'Скрыть' : 'Прочитать'}</button>
              ) : (
                <button type="button" className="btn-sm primary" onClick={() => onOpenTask(item.taskId)}>{isReview ? 'Открыть' : 'Прочитать'}</button>
              )}
              <button type="button" className="btn-sm ok" disabled={busy} onClick={accept}>{busy ? '…' : 'Принять'}</button>
              <button type="button" className="btn-sm" disabled={busy} onClick={() => setClarifying(true)}>{clarifyLabel}</button>
            </div>
          )}
        </>
      )}
      {error && <span className="error-text">{error}</span>}
    </article>
  )
}
