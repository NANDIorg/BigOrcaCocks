import type React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Task, Question, Dispatch, BoardColumn, ColumnKind, Role, Run } from '@orca-board/core'
import { type RunFilter, runShortLabel } from './runs'
import { BOARD_SORT_KEY, BOARD_SORT_OPTIONS, compareTasks, isBoardSort, readSort, writeSort, type BoardSort } from './boardSort'
import { compareInColumn, dropStatus, localBoardColumns, pendingDeps, type DisplayColumn } from './boardColumns'
import {
  boardProgress, matchesFilter, readDoneCollapsed, readFilter, readRoles, writeDoneCollapsed, writeFilter, writeRoles,
  type BoardFilter
} from './boardView'
import { isArrowKey, isEditableTarget, moveFocus } from './boardNav'
import {
  cardEssenceFor, cardStateLabel, cardState, depsLabel, stageLabel, type CardEssence, type CardState, type CardStateInput
} from './cardState'
import { BoardCard } from './BoardCard'
import { splitByStage, stageGroups } from './runStage'
import { MoveMenu, type MoveTarget } from './MoveMenu'
import { onFocusBoard, onRevealOnBoard, scrollBehavior } from './feedLink'
import { Icon } from './icons'
import { useT } from './i18n'

interface Props {
  /** Колонки проекта в порядке показа; статус задачи — id колонки. «Готовы» показывается внутри «Бэклога» (`localBoardColumns`). */
  columns: BoardColumn[]
  /** Роли типа глобальной задачи этих карточек (`rolesForRun`) — для подписи на карточке. */
  roles: Role[]
  tasks: Task[]
  /** Прогоны проекта: метка на карточке и фильтр. Нет — доска одной глобальной задачи, без меток и фильтра. */
  runs?: Run[]
  /** Фильтр по прогону; хранит App, свой у каждого проекта. */
  runFilter?: RunFilter
  onRunFilter?(filter: RunFilter): void
  /** Подпись пустой колонки. */
  emptyText?: string
  questions: Question[]
  dispatches: Dispatch[]
  selectedId?: string
  runningTaskIds: Set<string>
  /**
   * Названия нод воркфлоу по id (`wfNodeTitles`) — для пилюли этапа на карточке. Нет (старый main, тип без графа) —
   * пилюли этапа нет, гейт подписывается и без неё.
   */
  stageTitles?: Readonly<Record<string, string>>
  onSelect(task: Task): void
  /** status — id колонки. */
  onMove(id: string, status: string): void
  onStart(task: Task): void
  onRemove(id: string): void
  onAnswer(questionId: string, answer: string): void
  onAccept(taskId: string): Promise<void>
  onReject(taskId: string, feedback: string): Promise<void>
  /** Открыть карточку целиком (модалка задачи): клик по карточке и кнопка «Открыть». */
  onOpenTask?: (task: Task) => void
  /**
   * Задачи, у которых есть пункт в ленте «Ждут вас» (`attentionTaskIds`). Единственный источник «ждёт человека»:
   * по нему работает фильтр «Ждут вас», его счётчик и ссылка «в ленте ↑» — состояние карточки для этого не
   * пересчитывается, иначе доска и лента разошлись бы.
   */
  waitingTaskIds: ReadonlySet<string>
  /**
   * Показать в ленте «Ждут вас» карточку этой задачи (ссылка «в ленте ↑»). Нет — ленты нет, ссылки на карточке
   * тоже: строка сути остаётся, вести ей некуда. Ссылка только у карточек из `waitingTaskIds`: у остальных в
   * ленте ничего нет.
   */
  onRevealInFeed?(taskId: string): void
}

/** Всё, что доска знает о карточке: считается один раз на снимок и питает и вид, и фильтры. */
interface CardInfo {
  input: CardStateInput
  state: CardState
  essence: CardEssence | null
  waits: boolean
}

/** Элемент карточки на доске по id задачи. */
function cardElement(root: HTMLElement | null, id: string): HTMLElement | null {
  return root?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"]`) ?? null
}

export function Board(props: Props): React.JSX.Element {
  const { columns, roles, runs = [], runFilter = 'all', onRunFilter, emptyText, questions, dispatches, selectedId, runningTaskIds, stageTitles, waitingTaskIds, onSelect, onMove, onStart, onRemove, onOpenTask, onRevealInFeed } = props
  const t = useT()
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [sort, setSort] = useState<BoardSort>(() => readSort(BOARD_SORT_KEY))
  const [filter, setFilter] = useState<BoardFilter>(readFilter)
  const [myRoles, setMyRoles] = useState<string[]>(readRoles)
  const [rolesOpen, setRolesOpen] = useState(false)
  const [doneCollapsed, setDoneCollapsed] = useState(readDoneCollapsed)
  const [focusedId, setFocusedId] = useState<string | undefined>()
  const [menu, setMenu] = useState<{ taskId: string; anchor: HTMLElement } | null>(null)
  const boardRef = useRef<HTMLDivElement>(null)
  const rolesRef = useRef<HTMLDivElement>(null)
  /**
   * Перенесённая карточка, которой вернуть фокус: перенос идёт через main, и карточка появится в новой колонке
   * позже — новым элементом, уже без фокуса. `from` — колонка, из которой её перенесли.
   */
  const pendingFocus = useRef<{ id: string; from: string } | null>(null)
  /** Карточка, к которой просили прокрутить из ленты: показываем, как только она оказалась на доске. */
  const pendingReveal = useRef<string | null>(null)
  const [, setRevealTick] = useState(0)

  const changeSort = (next: BoardSort): void => {
    setSort(next)
    writeSort(BOARD_SORT_KEY, next)
  }
  const changeFilter = (next: BoardFilter): void => {
    setFilter(next)
    writeFilter(next)
  }
  const toggleRole = (id: string): void => {
    const next = myRoles.includes(id) ? myRoles.filter((r) => r !== id) : [...myRoles, id]
    setMyRoles(next)
    writeRoles(next)
  }
  const changeDoneCollapsed = (next: boolean): void => {
    setDoneCollapsed(next)
    writeDoneCollapsed(next)
  }

  const byId = new Map(props.tasks.map((t) => [t.id, t]))
  const runById = new Map(runs.map((r) => [r.id, r]))
  // Выбранный прогон исчез из снимка — показываем все.
  const runSel: RunFilter = runFilter === 'all' || runFilter === 'none' || runById.has(runFilter) ? runFilter : 'all'
  const tasks = props.tasks.filter((t) =>
    runSel === 'all' ? true : runSel === 'none' ? !t.runId : t.runId === runSel
  )
  // Все проверки статуса — по виду колонки, а не по её id: id у кастомных колонок произвольные.
  const kindById = new Map(columns.map((c) => [c.id, c.kind]))
  const kindOf = (status: string): ColumnKind | undefined => kindById.get(status)
  const roleOf = (task: Task): Role | undefined => roles.find((r) => r.id === task.roleId)
  const open = (task: Task): void => {
    onSelect(task)
    onOpenTask?.(task)
  }
  const remove = (task: Task): void => {
    if (window.confirm(t('board.confirmRemove', { title: task.title }))) onRemove(task.id)
  }
  const openQ = new Map<string, Question[]>()
  questions.filter((q) => !q.answeredAt).forEach((q) => openQ.set(q.taskId, [...(openQ.get(q.taskId) ?? []), q]))
  const lastDispatch = new Map<string, Dispatch>()
  dispatches.forEach((d) => lastDispatch.set(d.taskId, d))

  const info = new Map<string, CardInfo>()
  for (const task of tasks) {
    const kind = kindOf(task.status)
    const input: CardStateInput = {
      kind,
      task,
      dispatch: lastDispatch.get(task.id),
      questions: openQ.get(task.id) ?? [],
      running: runningTaskIds.has(task.id),
      waitingDeps: kind === 'backlog' ? pendingDeps(task, (dep) => byId.get(dep)?.status, kindOf) : 0
    }
    const state = cardState(input)
    const waits = waitingTaskIds.has(task.id)
    info.set(task.id, { input, state, essence: cardEssenceFor(input, state, waits), waits })
  }
  const canStart = (t: Task): boolean => {
    const kind = kindOf(t.status)
    const d = lastDispatch.get(t.id)
    return (kind === 'ready' || kind === 'backlog' || d?.outcome === 'unknown' || d?.outcome === 'failed') && !runningTaskIds.has(t.id)
  }

  // Роли, что есть на доске: «Мои роли» выбирают из них; выбранной роли на доске уже нет — не учитываем.
  const boardRoleIds = [...new Set(tasks.map((t) => t.roleId))]
  const effectiveRoles = myRoles.filter((r) => boardRoleIds.includes(r))
  const visible = (t: Task): boolean => {
    const i = info.get(t.id)
    return !!i && matchesFilter(filter, { state: i.state, waits: i.waits, roleId: t.roleId }, effectiveRoles)
  }
  const waitCount = tasks.filter((t) => info.get(t.id)?.waits).length
  const badCount = tasks.filter((t) => info.get(t.id)?.state === 'bad').length
  const progress = boardProgress(tasks.map((t) => kindOf(t.status)))

  // Подзадачи воркфлоу глобальной задачи (`Task.stageOf`) внутри колонки идут группами по этапам; этапов меньше двух — как раньше.
  const stageInfo = stageGroups(tasks, stageTitles, (status) => kindOf(status) === 'done')
  const views = localBoardColumns(columns)
  const columnItems = new Map<string, Task[]>()
  for (const view of views) {
    const inColumn = tasks
      .filter((t) => view.statuses.includes(t.status) && visible(t))
      .sort(compareInColumn(kindOf, (a, b) => compareTasks(sort, a, b)))
    // Порядок карточек — как на экране (по группам этапов): по нему ходят стрелки.
    columnItems.set(view.column.id, stageInfo ? splitByStage(inColumn, stageInfo).flatMap((g) => g.items) : inColumn)
  }
  const isCollapsed = (view: DisplayColumn): boolean => view.column.kind === 'done' && doneCollapsed
  // Сетка для стрелок: только развёрнутые колонки, слева направо.
  const grid = views.filter((v) => !isCollapsed(v)).map((v) => (columnItems.get(v.column.id) ?? []).map((t) => t.id))
  const flatIds = grid.flat()
  const tabStopId = focusedId !== undefined && flatIds.includes(focusedId) ? focusedId : flatIds[0]

  // Карточка переехала в другую колонку — возвращаем ей фокус, как только она появилась на новом месте.
  useLayoutEffect(() => {
    const pending = pendingFocus.current
    if (!pending || byId.get(pending.id)?.status === pending.from) return
    const el = cardElement(boardRef.current, pending.id)
    if (el) {
      pendingFocus.current = null
      el.focus()
    }
  })

  const focusCard = (id: string): void => {
    setFocusedId(id)
    cardElement(boardRef.current, id)?.focus()
  }

  // Связка с лентой: имя задачи в карточке ленты выделяет карточку здесь, клавиша G возвращает фокус на доску.
  // Подписка одна на всё время жизни доски, а обработчики свежие на каждый рендер — через ref.
  const link = useRef({ reveal: (_id: string): void => undefined, focusBoard: (): void => undefined })
  link.current = {
    reveal: (id) => {
      const task = byId.get(id)
      if (!task) return
      // Фильтр («Проблемы», «Мои роли») мог спрятать карточку — выделять было бы нечего.
      if (!visible(task)) changeFilter('all')
      setFocusedId(id)
      onSelect(task)
      pendingReveal.current = id
      setRevealTick((n) => n + 1)
    },
    focusBoard: () => {
      const id = selectedId !== undefined && flatIds.includes(selectedId) ? selectedId : tabStopId
      if (id) focusCard(id)
    }
  }
  useEffect(() => {
    const offReveal = onRevealOnBoard((id) => link.current.reveal(id))
    const offFocus = onFocusBoard(() => link.current.focusBoard())
    return () => {
      offReveal()
      offFocus()
    }
  }, [])

  // Выделенную из ленты карточку прокручиваем в видимую область и берём в фокус, когда она уже на доске: после
  // смены фильтра она появляется только в этом рендере. Не нашли (например, в свёрнутом «Сделано») — просто забываем.
  useLayoutEffect(() => {
    const id = pendingReveal.current
    if (!id) return
    pendingReveal.current = null
    const el = cardElement(boardRef.current, id)
    if (!el) return
    el.focus({ preventScroll: true })
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: scrollBehavior() })
  })

  // Меню «Переместить в…»: цели — колонки доски; там, где карточка уже лежит, пункт отключён.
  const menuTask = menu ? byId.get(menu.taskId) : undefined
  const menuTargets: MoveTarget[] = menuTask
    ? views.map((v) => ({ id: v.column.id, title: v.column.title, color: v.column.color, disabled: dropStatus(v, menuTask.status) === undefined }))
    : []
  const openMenu = (task: Task, anchor: HTMLElement): void => {
    setFocusedId(task.id)
    setMenu({ taskId: task.id, anchor })
  }

  // Меню «Мои роли»: закрывается кликом мимо и Esc.
  useEffect(() => {
    if (!rolesOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!rolesRef.current?.contains(e.target as Node)) setRolesOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setRolesOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [rolesOpen])

  /**
   * Клавиатура доски. Срабатывает, только когда в фокусе сама карточка: кнопки на ней и поля ввода (свой ответ,
   * поиск) получают клавиши как обычно. M и S — по физической клавише (`code`), чтобы работали и в русской раскладке.
   */
  const onBoardKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
    const target = e.target as HTMLElement
    if (isEditableTarget(target)) return
    const el = target.closest<HTMLElement>('[data-card-id]')
    const id = el?.dataset.cardId
    if (!el || el !== target || !id) return
    const task = byId.get(id)
    if (!task) return
    if (isArrowKey(e.key)) {
      e.preventDefault()
      const next = moveFocus(grid, id, e.key)
      if (next && next !== id) focusCard(next)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      open(task)
    } else if (e.code === 'KeyM') {
      e.preventDefault()
      openMenu(task, el)
    } else if (e.code === 'KeyS' && canStart(task)) {
      e.preventDefault()
      onStart(task)
    }
  }

  const pickMove = (status: string): void => {
    if (!menu) return
    const id = menu.taskId
    const task = byId.get(id)
    setMenu(null)
    // В свёрнутое «Сделано» карточка уходит с доски — возвращать фокус некуда.
    const hidden = columns.find((c) => c.id === status)?.kind === 'done' && doneCollapsed
    pendingFocus.current = task && !hidden ? { id, from: task.status } : null
    onMove(id, status)
  }

  const dropOn = (view: DisplayColumn, e: React.DragEvent): void => {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/task-id')
    const from = id ? byId.get(id)?.status : undefined
    const to = from === undefined ? undefined : dropStatus(view, from)
    if (id && to !== undefined) onMove(id, to)
    setDragOver(null)
    setDragging(null)
  }
  const dragOverColumn = (view: DisplayColumn, e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes('text/task-id')) return
    e.preventDefault()
    setDragOver(view.column.id)
  }

  const filterButton = (value: Exclude<BoardFilter, 'roles'>, count: number, cls = ''): React.JSX.Element => (
    <button
      key={value}
      type="button"
      className={`filter ${cls}`}
      aria-pressed={filter === value}
      title={value === 'wait' ? t('board.filter.waitTitle') : undefined}
      onClick={() => changeFilter(value)}
    >
      {t(`board.filter.${value}`)} <span className="n">{count}</span>
    </button>
  )

  return (
    <div className="board-wrap">
      <div className="lb-toolbar" role="toolbar" aria-label={t('board.toolbar')}>
        <div className="lb-progress" role="img" aria-label={t('board.progress', { done: progress.done, total: progress.total })} title={t('board.progress', { done: progress.done, total: progress.total })}>
          <span><b>{progress.done}</b>/{progress.total}</span>
          <div className="bar" aria-hidden="true">
            {progress.parts.map((p) => (
              <span key={p.key} className={`seg-${p.key}`} style={{ width: `${(p.count / progress.total) * 100}%` }} />
            ))}
          </div>
        </div>
        <div className="filters" role="group" aria-label={t('board.filter.group')}>
          {filterButton('all', tasks.length)}
          {filterButton('wait', waitCount, 'wait')}
          {filterButton('bad', badCount, 'bad')}
          <div className="roles-filter" ref={rolesRef}>
            <button
              type="button"
              className="filter"
              aria-pressed={filter === 'roles'}
              aria-haspopup="true"
              aria-expanded={rolesOpen}
              title={t('board.filter.rolesTitle')}
              onClick={() => {
                if (filter !== 'roles') changeFilter('roles')
                setRolesOpen((v) => !v)
              }}
            >
              {t('board.filter.roles')}{effectiveRoles.length > 0 && <> <span className="n">{effectiveRoles.length}</span></>} ▾
            </button>
            {rolesOpen && (
              <div className="roles-pop" role="group" aria-label={t('board.filter.rolesPop')}>
                {boardRoleIds.length === 0 && <div className="muted">{t('board.filter.noTasks')}</div>}
                {boardRoleIds.map((id) => (
                  <label key={id} className="roles-pop-item">
                    <input type="checkbox" checked={myRoles.includes(id)} onChange={() => toggleRole(id)} />
                    <span>{roles.find((r) => r.id === id)?.title ?? id}</span>
                  </label>
                ))}
                {boardRoleIds.length > 0 && effectiveRoles.length === 0 && <div className="muted roles-pop-hint">{t('board.filter.noRoles')}</div>}
              </div>
            )}
          </div>
        </div>
        <span className="grow" />
        {onRunFilter && (runs.length > 0 || runSel !== 'all') && (
          <label className="lb-select">
            <span className="board-sort-label">{t('board.run.label')}</span>
            <select className="run-filter" value={runSel} aria-label={t('board.run.aria')} onChange={(e) => onRunFilter(e.target.value)}>
              <option value="all">{t('board.run.all')}</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id} title={r.objective}>
                  {runShortLabel(r, 5, 40)}{r.closedAt !== undefined ? ` ${t('board.run.closed')}` : ''}
                </option>
              ))}
              <option value="none">{t('board.run.none')}</option>
            </select>
          </label>
        )}
        <label className="lb-select">
          <span className="board-sort-label">{t('board.sort.label')}</span>
          <select
            className="sort"
            value={sort}
            aria-label={t('board.sort.aria')}
            onChange={(e) => {
              if (isBoardSort(e.target.value)) changeSort(e.target.value)
            }}
          >
            {BOARD_SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.title}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="board" ref={boardRef} onKeyDown={onBoardKeyDown}>
        {views.map((view) => {
          const { column, statuses } = view
          const status = column.id
          const merged = statuses.length > 1
          const items = columnItems.get(status) ?? []
          const hidden = tasks.filter((t) => statuses.includes(t.status)).length - items.length
          const colStyle = { '--c': column.color } as React.CSSProperties
          const dropProps = {
            onDragOver: (e: React.DragEvent) => dragOverColumn(view, e),
            onDragLeave: () => setDragOver(null),
            onDrop: (e: React.DragEvent) => dropOn(view, e)
          }
          if (isCollapsed(view)) {
            return (
              <button
                key={status}
                type="button"
                className={`column collapsed ${dragOver === status ? 'drag-over' : ''}`}
                style={colStyle}
                aria-expanded={false}
                aria-label={t('board.column.expandAria', { title: column.title, n: items.length })}
                title={t('board.column.expand')}
                onClick={() => changeDoneCollapsed(false)}
                {...dropProps}
              >
                <span className="col-head">
                  <span className="dot" aria-hidden />
                  <span className="count">{items.length}</span>
                  <span className="vtitle">{column.title}</span>
                </span>
              </button>
            )
          }
          const ready = items.filter((t) => kindOf(t.status) === 'ready')
          const groups: { label?: string; items: Task[] }[] =
            stageInfo
              ? splitByStage(items, stageInfo)
              : merged && ready.length > 0 && ready.length < items.length
              ? [
                  { label: t('board.column.ready', { n: ready.length }), items: ready },
                  { label: t('board.column.waitingDeps', { n: items.length - ready.length }), items: items.filter((task) => kindOf(task.status) !== 'ready') }
                ]
              : [{ items }]
          return (
            <section
              key={status}
              className={`column ${dragOver === status ? 'drag-over' : ''}`}
              style={colStyle}
              aria-label={`${column.title}, ${items.length}`}
              {...dropProps}
            >
              <div className="col-head" title={merged ? t('board.column.mergedTitle') : undefined}>
                <span>{column.title}</span>
                <span className="count">{items.length}</span>
                <span className="grow" />
                {column.kind === 'needs_input' && items.length > 0 && <span className="flag">{t('board.column.waitingFlag')}</span>}
                {column.kind === 'done' && (
                  <button
                    type="button"
                    className="lb-tool"
                    aria-expanded
                    aria-label={t('board.column.collapseAria', { title: column.title })}
                    title={t('board.column.collapse')}
                    onClick={() => changeDoneCollapsed(true)}
                  >
                    <span className="chev-left"><Icon.chevron /></span>
                  </button>
                )}
              </div>
              <div className="col-body">
                {dragOver === status && dragging && !statuses.includes(byId.get(dragging)?.status ?? status) && (
                  <div className="placeholder" />
                )}
                {items.length === 0 && dragOver !== status && (
                  <div className="empty">{hidden > 0 ? t('board.column.hidden', { n: hidden }) : emptyText ?? t('board.column.empty')}</div>
                )}
                {groups.map((g) => (
                  <div key={g.label ?? 'all'} className="card-group">
                    {g.label && <div className="group-label" title={stageInfo ? t('board.stage.groupTitle') : undefined}>{g.label}</div>}
                    {g.items.map((task) => {
                      const ci = info.get(task.id)
                      if (!ci) return null
                      const kind = ci.input.kind
                      const stateLabel = cardStateLabel(ci.state)
                      return (
                        <BoardCard
                          key={task.id}
                          task={task}
                          state={ci.state}
                          isDone={kind === 'done'}
                          role={roleOf(task)}
                          stage={stageLabel(task, stageTitles, (id) => byId.get(id)?.title)}
                          deps={depsLabel(task.deps, (d) => { const s = byId.get(d)?.status; return s !== undefined && kindOf(s) === 'done' }, (d) => byId.get(d)?.title)}
                          essence={ci.essence}
                          ariaLabel={[task.title, stateLabel && t('board.card.stateAria', { state: stateLabel }), ci.essence?.text].filter(Boolean).join('. ')}
                          run={task.runId ? runById.get(task.runId) : undefined}
                          runs={runs}
                          showUpdated={sort === 'updated'}
                          selected={task.id === selectedId}
                          tabStop={task.id === tabStopId}
                          terminalOpen={runningTaskIds.has(task.id)}
                          canStart={canStart(task)}
                          showFeedback={kind !== 'review'}
                          revealable={!!onRevealInFeed && ci.waits}
                          onOpen={() => open(task)}
                          onStart={() => onStart(task)}
                          onRemove={() => remove(task)}
                          onReveal={() => onRevealInFeed?.(task.id)}
                          onMenu={(card) => openMenu(task, card)}
                          onFocus={() => {
                            pendingFocus.current = null
                            setFocusedId(task.id)
                          }}
                          onDragStart={(e) => {
                            e.dataTransfer.setData('text/task-id', task.id)
                            setDragging(task.id)
                          }}
                          onDragEnd={() => setDragging(null)}
                        />
                      )
                    })}
                  </div>
                ))}
              </div>
            </section>
          )
        })}
      </div>
      <div className="kbd-hint" aria-hidden="true">
        <span><kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> {t('board.kbd.arrows')}</span>
        <span><kbd>Enter</kbd> {t('board.kbd.open')}</span>
        <span><kbd>M</kbd> {t('board.kbd.move')}</span>
        <span><kbd>S</kbd> {t('board.kbd.start')}</span>
        {onRevealInFeed && waitingTaskIds.size > 0 && <span><kbd>G</kbd> {t('board.kbd.feed')}</span>}
        <span><kbd>Esc</kbd> {t('board.kbd.globals')}</span>
      </div>
      {menu && menuTask && (
        <MoveMenu
          anchor={menu.anchor}
          targets={menuTargets}
          onPick={pickMove}
          onClose={(restoreFocus) => {
            setMenu(null)
            if (restoreFocus) focusCard(menu.taskId)
          }}
        />
      )}
    </div>
  )
}
