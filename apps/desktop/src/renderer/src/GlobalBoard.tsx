import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { pendingRequestsOf, type BoardColumn, type GlobalTask, type HumanRequest, type RequestResolution, type Task } from '@orca-board/core'
import { Icon } from './icons'
import { RequestCard } from './RequestCard'
import { formatDuration, globalTaskDuration } from './duration'
import { useNow } from './useNow'
import { GLOBAL_BOARD_SORT_KEY, SORT_OPTIONS, compareGlobals, formatStamp, readSort, writeSort, type BoardSort } from './boardSort'

/**
 * Сводка по подзадачам, которую карточке не вычислить из GlobalTask: ревью кода. Всё, что ждёт человека
 * (вопросы, ответы, эскалации), — pending-запросы: GlobalTask.waiting.
 */
export interface GlobalTaskAttention {
  review: number
}

interface Props {
  /**
   * Колонки глобального канбана (globalBoardColumns: backlog / in_progress / needs_input / done); статус карточки —
   * id колонки. needs_input заполняется сама (подзадачи ждут человека) — туда не перетаскивают.
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
}

/** «только что», «5 мин назад», «3 ч назад», иначе дата. */
export function relativeTime(ts: number, now = Date.now()): string {
  const min = Math.floor((now - ts) / 60000)
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин назад`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} ч назад`
  return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** «1 подзадача», «3 подзадачи», «5 подзадач». */
export function subtasksLabel(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return `${n} подзадача`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} подзадачи`
  return `${n} подзадач`
}

/** Полоса прогресса «готово / всего» с подписью; без подзадач — спокойная подпись. */
/**
 * Время работы глобальной задачи — сумма времени работы подзадач (`globalTaskDuration`). Хоть одна
 * подзадача в работе — живой счётчик «⏱ 1 ч 5 мин»; закрытая — итог «за 3 ч 20 мин»; иначе застывшее «⏸ …».
 * variant="line" — строка «Время работы: …» для шапок.
 */
export function GlobalDuration({ global, variant = 'chip' }: { global: GlobalTask; variant?: 'chip' | 'line' }): React.JSX.Element {
  if (global.activeSince.length > 0) return <LiveDuration global={global} variant={variant} />
  const text = formatDuration(globalTaskDuration(global, 0))
  const title = 'Сумма времени работы подзадач; сейчас ни одна не в работе'
  if (variant === 'line') return <span className="g-duration" title={title}>Время работы: {text}</span>
  return <span className="g-duration" title={title}>{global.closedAt !== undefined ? `за ${text}` : `⏸ ${text}`}</span>
}

function LiveDuration({ global, variant }: { global: GlobalTask; variant: 'chip' | 'line' }): React.JSX.Element {
  const text = formatDuration(globalTaskDuration(global, useNow()))
  return <span className="g-duration" title="Сумма времени работы подзадач; идёт, пока хоть одна в работе">{variant === 'line' ? `Время работы: ${text}` : `⏱ ${text}`}</span>
}

export function GlobalProgress({ global }: { global: GlobalTask }): React.JSX.Element {
  const { done, total } = global.progress
  const pct = total ? Math.round((done / total) * 100) : 0
  return (
    <div className="g-progress" title={total ? `Готово ${done} из ${total}` : 'Подзадач пока нет'}>
      <div className="g-progress-line">
        <span>{total ? `${done} / ${subtasksLabel(total)}` : 'Нет подзадач'}</span>
        {total > 0 && <span>{pct}%</span>}
      </div>
      <div className="g-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <div className="g-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/** Верхний уровень доски: глобальные задачи по колонкам Бэклог / В работе / Нужен ответ / Сделано проекта. */
export function GlobalBoard(props: Props): React.JSX.Element {
  const { columns, globals, liveCoordinators, attention, requests, tasks, focusId, onOpen, onMove, onEdit, onRemove, onStartCoordinator } = props
  const { onResolveRequest, onOpenInbox } = props
  const taskTitle = new Map(tasks.map((t) => [t.id, t.title]))
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
        <span className="board-sort-label">Сортировка:</span>
        <div className="segmented" role="group" aria-label="Сортировка карточек">
          {SORT_OPTIONS.map((o) => (
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
                    {auto ? 'Здесь появятся задачи, где подзадачи ждут вашего ответа' : 'Здесь пока пусто — перетащите карточку сюда'}
                  </div>
                )}
                {items.map((g) => {
                  const live = liveCoordinators.has(g.id)
                  const att = attention.get(g.id)
                  // Первый (самый старый) запрос — прямо на карточке; остальные — во Входящих.
                  const request = column.kind === 'needs_input' ? pendingRequestsOf(requests, { runId: g.id }).sort((a, b) => a.createdAt - b.createdAt)[0] : undefined
                  return (
                    <article
                      key={g.id}
                      className={`g-card ${dragging === g.id ? 'dragging' : ''}`}
                      tabIndex={0}
                      draggable
                      data-global-id={g.id}
                      aria-label={`Глобальная задача «${g.title}», ${g.progress.done} из ${g.progress.total} готово. Enter — открыть`}
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
                        {!g.inbox && !live && (
                          <button type="button" className="card-tool" title="Запустить координатора" aria-label="Запустить координатора" onClick={() => onStartCoordinator(g)}>
                            <Icon.play />
                          </button>
                        )}
                        <button type="button" className="card-tool" title="Редактировать" aria-label="Редактировать" onClick={() => onEdit(g)}>
                          <Icon.edit />
                        </button>
                        {!g.inbox && (
                          <button type="button" className="card-tool danger" title="Удалить" aria-label="Удалить" onClick={() => onRemove(g)}>
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
                        {g.inbox && <span className="g-chip">служебная</span>}
                        {live && <span className="chip live">● координатор</span>}
                        {g.waiting > 0 && <span className="g-chip warn">ждёт вашего ответа: {g.waiting}</span>}
                        {att && att.review > 0 && <span className="g-chip review">на ревью: {att.review}</span>}
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
                            {g.waiting > 1 ? `Открыть во Входящих · ещё ${g.waiting - 1}` : 'Открыть во Входящих'}
                          </button>
                        </div>
                      )}
                      <GlobalProgress global={g} />
                      {column.kind === 'done' && g.closedAt !== undefined ? (
                        <div className="stamp">Завершено: {formatStamp(g.closedAt)}</div>
                      ) : sort === 'updated' ? (
                        <div className="stamp">Обновлено: {formatStamp(g.activityAt)}</div>
                      ) : null}
                      <div className="g-card-foot">
                        <span title={new Date(g.activityAt).toLocaleString('ru-RU')}>{relativeTime(g.activityAt)}</span>
                        {!g.inbox ? (
                          <span>{g.closedAt !== undefined && 'закрыта · '}<GlobalDuration global={g} /></span>
                        ) : g.closedAt !== undefined && <span>закрыта</span>}
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
