import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { pendingRequestsOf, type BoardColumn, type GlobalTask, type HumanRequest, type RequestResolution, type Task } from '@orca-board/core'
import { Icon } from './icons'
import { RequestCard } from './RequestCard'
import { globalTaskTicking, globalTimeLabel, globalTimeParts, globalTimeTitle, type GlobalTimePart } from './duration'
import { useNow } from './useNow'
import { globalTaskActions } from './globalReview'
import { PriorityBadge } from './Priority'
import { useT } from './i18n'
import { fullStamp, relativeTime, subtasksLabel } from './globalFormat'
import { BOARD_SORT_OPTIONS, GLOBAL_BOARD_SORT_KEY, compareGlobals, formatStamp, readSort, writeSort, type BoardSort } from './boardSort'

/**
 * Сводка по подзадачам, которую карточке не вычислить из GlobalTask: ревью кода. Всё, что ждёт человека
 * (вопросы, ответы, эскалации), — pending-запросы: GlobalTask.waiting.
 */
export interface GlobalTaskAttention {
  review: number
}

interface Props {
  /**
   * Колонки глобального канбана (globalBoardColumns: backlog / in_progress / needs_input / review / done); статус
   * карточки — id колонки. needs_input заполняется сама (подзадачи ждут человека) — туда не перетаскивают.
   * review — «Проверка»: работа закрыта и ждёт приёмки человеком.
   */
  columns: BoardColumn[]
  globals: GlobalTask[]
  /** Глобальные задачи с живым координатором (терминал role=coordinator, runId). */
  liveCoordinators: Set<string>
  attention: Map<string, GlobalTaskAttention>
  /** Запросы к человеку проекта (snapshot.requests): первый pending — на карточке в «Нужен ответ». */
  requests: HumanRequest[]
  /** Подзадачи — подпись, чей запрос. */
  tasks: Task[]
  onResolveRequest(request: HumanRequest, resolution: RequestResolution): Promise<void>
  onOpenInbox(requestId: string): void
  /** Карточка, из которой вернулись, — ей возвращается фокус. */
  focusId?: string
  onOpen(global: GlobalTask): void
  onMove(id: string, status: string): void
  onEdit(global: GlobalTask): void
  onRemove(global: GlobalTask): void
  onStartCoordinator(global: GlobalTask): void
  /** «Подтвердить» на «Проверке». */
  onAccept(global: GlobalTask): void
  /** «Вернуть в работу…» на «Проверке» — модалка с уточнением. */
  onReturn(global: GlobalTask): void
  /** Название типа задачи для чипа на карточке (`globalTypeTitle`); нет — чипа нет (старый main, «Входящие»). */
  typeTitle?(global: GlobalTask): string | undefined
}

// Живут в globalFormat.ts (тестируются без React); отсюда их берут лента «Ждут вас» и «Итог и цель».
export { relativeTime, subtasksLabel }

/**
 * Время глобальной задачи. chip (карточка) — только своё время в работе; line (внутри задачи) — два
 * подписанных: «В работе» и «Сумма подзадач». Что показывать — `globalTimeParts`. Каждое тикает само:
 * живой счётчик только у идущего, стоящее — застывшее «⏸ …».
 */
export function GlobalDuration({ global, variant = 'chip' }: { global: GlobalTask; variant?: 'chip' | 'line' }): React.JSX.Element {
  return (
    <span className={`g-duration g-duration-${variant}`}>
      {globalTimeParts(global, variant).map((part) => <DurationPart key={part} global={global} part={part} variant={variant} />)}
    </span>
  )
}

interface DurationPartProps {
  global: GlobalTask
  part: GlobalTimePart
  variant: 'chip' | 'line'
}

function DurationPart(props: DurationPartProps): React.JSX.Element | null {
  return globalTaskTicking(props.global, props.part) ? <LiveDurationPart {...props} /> : <DurationText {...props} now={0} />
}

function LiveDurationPart(props: DurationPartProps): React.JSX.Element | null {
  return <DurationText {...props} now={useNow()} />
}

function DurationText({ global, part, variant, now }: DurationPartProps & { now: number }): React.JSX.Element | null {
  const text = globalTimeLabel(global, part, now, variant)
  if (text === undefined) return null
  return <span className={part === 'own' ? 'g-duration-own' : 'g-duration-sum'} title={globalTimeTitle(global, part)}>{text}</span>
}

/** Полоса прогресса «готово / всего» с подписью; без подзадач — спокойная подпись. */
export function GlobalProgress({ global }: { global: GlobalTask }): React.JSX.Element {
  const t = useT()
  const { done, total } = global.progress
  const pct = total ? Math.round((done / total) * 100) : 0
  return (
    <div className="g-progress" title={total ? t('global.progress.title', { done, total }) : t('global.progress.noneTitle')}>
      <div className="g-progress-line">
        <span>{total ? `${done} / ${subtasksLabel(total)}` : t('global.progress.none')}</span>
        {total > 0 && <span>{pct}%</span>}
      </div>
      <div className="g-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <div className="g-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/** Верхний уровень доски: глобальные задачи по колонкам Бэклог / В работе / Нужен ответ / Проверка / Сделано проекта. */
export function GlobalBoard(props: Props): React.JSX.Element {
  const { columns, globals, liveCoordinators, attention, requests, tasks, focusId, onOpen, onMove, onEdit, onRemove, onStartCoordinator } = props
  const { onResolveRequest, onOpenInbox, onAccept, onReturn, typeTitle } = props
  const t = useT()
  const taskTitle = new Map(tasks.map((task) => [task.id, task.title]))
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [sort, setSort] = useState<BoardSort>(() => readSort(GLOBAL_BOARD_SORT_KEY))
  const changeSort = (next: BoardSort): void => {
    setSort(next)
    writeSort(GLOBAL_BOARD_SORT_KEY, next)
  }
  const byId = new Map(globals.map((g) => [g.id, g]))
  const boardRef = useRef<HTMLDivElement>(null)

  // Вернулись с экрана глобальной задачи — фокус на её карточку (клавиатурный возврат не теряет место).
  useEffect(() => {
    if (!focusId) return
    const el = boardRef.current?.querySelector<HTMLElement>(`[data-global-id="${CSS.escape(focusId)}"]`)
    el?.focus({ preventScroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const columnIds = new Set(columns.map((c) => c.id))
  // Карточка в колонке, которой уже нет в проекте (гонка с правкой колонок), — показываем в первой.
  const columnOf = (g: GlobalTask): string => (columnIds.has(g.status) ? g.status : columns[0]?.id ?? g.status)

  return (
    <div className="board-wrap">
      <div className="board-toolbar">
        <span className="board-sort-label">{t('global.board.sort')}</span>
        <div className="segmented" role="group" aria-label={t('global.board.sortAria')}>
          {BOARD_SORT_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`seg ${sort === o.value ? 'active' : ''}`}
              onClick={() => changeSort(o.value)}
            >
              {o.title}
            </button>
          ))}
        </div>
      </div>
      <div className="g-board" ref={boardRef}>
        {columns.map((column) => {
          const items = globals.filter((g) => columnOf(g) === column.id).sort((a, b) => compareGlobals(sort, a, b))
          // «Нужен ответ» вычисляется из подзадач: карточка сама приходит и уходит, руками её сюда не ставят.
          const auto = column.kind === 'needs_input'
          return (
            <section
              key={column.id}
              className={`g-column ${dragOver === column.id ? 'drag-over' : ''}`}
              style={{ '--col': column.color } as React.CSSProperties}
              aria-label={`${column.title}: ${items.length}`}
              onDragOver={(e) => {
                if (auto || !e.dataTransfer.types.includes('text/global-id')) return
                e.preventDefault()
                setDragOver(column.id)
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (auto) return
                const id = e.dataTransfer.getData('text/global-id')
                if (id && byId.get(id)?.status !== column.id) onMove(id, column.id)
                setDragOver(null)
                setDragging(null)
              }}
            >
              <header className="g-col-head">
                <span className="g-col-title" title={column.title}>{column.title}</span>
                <span className="g-col-count">{items.length}</span>
              </header>
              <div className="g-col-body">
                {dragOver === column.id && dragging && byId.get(dragging)?.status !== column.id && <div className="placeholder" />}
                {items.length === 0 && dragOver !== column.id && (
                  <div className="g-empty">
                    {auto
                      ? t('global.board.emptyAuto')
                      : column.kind === 'review'
                        ? t('global.board.emptyReview')
                        : t('global.board.empty')}
                  </div>
                )}
                {items.map((g) => {
                  const live = liveCoordinators.has(g.id)
                  const att = attention.get(g.id)
                  const actions = globalTaskActions(g, column.kind, live)
                  // Первый (самый старый) запрос — прямо на карточке; остальные — во Входящих.
                  const request = column.kind === 'needs_input' ? pendingRequestsOf(requests, { runId: g.id }).sort((a, b) => a.createdAt - b.createdAt)[0] : undefined
                  return (
                    <article
                      key={g.id}
                      className={`g-card ${dragging === g.id ? 'dragging' : ''}`}
                      tabIndex={0}
                      draggable
                      data-global-id={g.id}
                      aria-label={t('global.board.cardAria', { title: g.title, done: g.progress.done, total: g.progress.total })}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/global-id', g.id)
                        e.dataTransfer.effectAllowed = 'move'
                        setDragging(g.id)
                      }}
                      onDragEnd={() => {
                        setDragging(null)
                        setDragOver(null)
                      }}
                      onClick={() => onOpen(g)}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onOpen(g)
                        }
                      }}
                    >
                      <div className="card-tools" onClick={(e) => e.stopPropagation()}>
                        {actions.startCoordinator && (
                          <button type="button" className="card-tool" title={t('global.action.start')} aria-label={t('global.action.start')} onClick={() => onStartCoordinator(g)}>
                            <Icon.play />
                          </button>
                        )}
                        <button type="button" className="card-tool" title={t('global.action.edit')} aria-label={t('global.action.edit')} onClick={() => onEdit(g)}>
                          <Icon.edit />
                        </button>
                        {!g.inbox && (
                          <button type="button" className="card-tool danger" title={t('global.action.remove')} aria-label={t('global.action.remove')} onClick={() => onRemove(g)}>
                            <Icon.trash />
                          </button>
                        )}
                      </div>
                      <div className="g-card-title" title={g.title}>{g.title}</div>
                      {g.description && g.description.trim() !== g.title && (
                        <div className="g-card-desc" title={g.description}>{g.description}</div>
                      )}
                      <div className="g-card-chips">
                        <span className="g-chip status">{column.title}</span>
                        <PriorityBadge item={g} className="g-chip" />
                        {g.inbox && <span className="g-chip">{t('global.board.inbox')}</span>}
                        {typeTitle?.(g) && <span className="g-chip task-type-chip" title={t('global.board.type')}>{typeTitle(g)}</span>}
                        {live && <span className="chip live">{t('global.board.live')}</span>}
                        {g.waiting > 0 && <span className="g-chip warn">{t('global.board.waiting', { count: g.waiting })}</span>}
                        {att && att.review > 0 && <span className="g-chip review">{t('global.board.review', { count: att.review })}</span>}
                      </div>
                      {request && (
                        // Клики внутри запроса не открывают задачу, а перетаскивание из него не тащит карточку.
                        <div className="g-card-request" draggable onDragStart={(e) => { e.preventDefault(); e.stopPropagation() }} onClick={(e) => e.stopPropagation()}>
                          <RequestCard
                            key={request.id}
                            request={request}
                            compact
                            where={taskTitle.get(request.taskId)}
                            onResolve={(res) => onResolveRequest(request, res)}
                          />
                          <button type="button" className="btn-text g-card-inbox" onClick={() => onOpenInbox(request.id)}>
                            {g.waiting > 1 ? t('global.board.openInboxMore', { count: g.waiting - 1 }) : t('global.board.openInbox')}
                          </button>
                        </div>
                      )}
                      <GlobalProgress global={g} />
                      {(actions.accept || actions.returnToWork) && (
                        <div className="g-card-review" onClick={(e) => e.stopPropagation()}>
                          {actions.accept && (
                            <button type="button" className="btn-sm primary" onClick={() => onAccept(g)} title={t('global.action.acceptTitle')}>
                              {t('global.action.accept')}
                            </button>
                          )}
                          {actions.returnToWork && (
                            <button
                              type="button"
                              className="btn-sm"
                              title={t('global.action.returnTitle')}
                              onClick={() => onReturn(g)}
                            >
                              {t('global.action.return')}
                            </button>
                          )}
                          {g.returns && g.returns.length > 0 && (
                            <span className="g-card-returns" title={t('global.board.returnsTitle')}>{t('global.board.returns', { count: g.returns.length })}</span>
                          )}
                        </div>
                      )}
                      {column.kind === 'done' && g.closedAt !== undefined ? (
                        <div className="stamp">{t('global.board.closedAt', { date: formatStamp(g.closedAt) })}</div>
                      ) : sort === 'updated' ? (
                        <div className="stamp">{t('global.board.updatedAt', { date: formatStamp(g.activityAt) })}</div>
                      ) : null}
                      <div className="g-card-foot">
                        <span title={fullStamp(g.activityAt)}>{relativeTime(g.activityAt)}</span>
                        {!g.inbox ? (
                          <span>{g.closedAt !== undefined && `${t('global.board.closed')} · `}<GlobalDuration global={g} /></span>
                        ) : g.closedAt !== undefined && <span>{t('global.board.closed')}</span>}
                      </div>
                    </article>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
