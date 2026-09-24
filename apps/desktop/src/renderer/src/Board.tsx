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
  CARD_STATE_LABEL, cardEssence, cardState, depsLabel, stageLabel, waitsForYou, type CardEssence, type CardState, type CardStateInput
} from './cardState'
import { BoardCard } from './BoardCard'
import { MoveMenu, type MoveTarget } from './MoveMenu'
import { Icon } from './icons'

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
   * Показать в ленте «Ждут вас» карточку этой задачи (ссылка «в ленте ↑»). Нет — ленты нет, ссылки на карточке
   * тоже: строка сути остаётся, вести ей некуда.
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

const FILTER_TITLES: Record<Exclude<BoardFilter, 'roles'>, string> = { all: 'Все', wait: 'Ждут вас', bad: 'Проблемы' }

export function Board(props: Props): React.JSX.Element {
  const { columns, roles, runs = [], runFilter = 'all', onRunFilter, emptyText = 'Пусто', questions, dispatches, selectedId, runningTaskIds, stageTitles, onSelect, onMove, onStart, onRemove, onOpenTask, onRevealInFeed } = props
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
    if (window.confirm(`Удалить задачу «${task.title}»?`)) onRemove(task.id)
  }
  const openQ = new Map<string, Question[]>()
  questions.filter((q) => !q.answeredAt).forEach((q) => openQ.set(q.taskId, [...(openQ.get(q.taskId) ?? []), q]))
  const lastDispatch = new Map<string, Dispatch>()
  dispatches.forEach((d) => lastDispatch.set(d.taskId, d))

  const info = new Map<string, CardInfo>()
  for (const t of tasks) {
    const kind = kindOf(t.status)
    const input: CardStateInput = {
      kind,
      task: t,
      dispatch: lastDispatch.get(t.id),
      questions: openQ.get(t.id) ?? [],
      running: runningTaskIds.has(t.id),
      waitingDeps: kind === 'backlog' ? pendingDeps(t, (dep) => byId.get(dep)?.status, kindOf) : 0
    }
    const state = cardState(input)
    info.set(t.id, { input, state, essence: cardEssence(input, state), waits: waitsForYou(input, state) })
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

  const views = localBoardColumns(columns)
  const columnItems = new Map<string, Task[]>()
  for (const view of views) {
    columnItems.set(
      view.column.id,
      tasks
        .filter((t) => view.statuses.includes(t.status) && visible(t))
        .sort(compareInColumn(kindOf, (a, b) => compareTasks(sort, a, b)))
    )
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
      title={value === 'wait' ? 'Оставить на доске задачи, которые ждут вашего ответа, показа или разбора сбоя' : undefined}
      onClick={() => changeFilter(value)}
    >
      {FILTER_TITLES[value]} <span className="n">{count}</span>
    </button>
  )

  return (
    <div className="board-wrap">
      <div className="lb-toolbar" role="toolbar" aria-label="Доска подзадач">
        <div className="lb-progress" role="img" aria-label={`Сделано ${progress.done} из ${progress.total}`} title={`Сделано ${progress.done} из ${progress.total}`}>
          <span><b>{progress.done}</b>/{progress.total}</span>
          <div className="bar" aria-hidden="true">
            {progress.parts.map((p) => (
              <span key={p.key} className={`seg-${p.key}`} style={{ width: `${(p.count / progress.total) * 100}%` }} />
            ))}
          </div>
        </div>
        <div className="filters" role="group" aria-label="Показать">
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
              title="Показать задачи только выбранных ролей"
              onClick={() => {
                if (filter !== 'roles') changeFilter('roles')
                setRolesOpen((v) => !v)
              }}
            >
              Мои роли{effectiveRoles.length > 0 && <> <span className="n">{effectiveRoles.length}</span></>} ▾
            </button>
            {rolesOpen && (
              <div className="roles-pop" role="group" aria-label="Роли на доске">
                {boardRoleIds.length === 0 && <div className="muted">Задач пока нет</div>}
                {boardRoleIds.map((id) => (
                  <label key={id} className="roles-pop-item">
                    <input type="checkbox" checked={myRoles.includes(id)} onChange={() => toggleRole(id)} />
                    <span>{roles.find((r) => r.id === id)?.title ?? id}</span>
                  </label>
                ))}
                {boardRoleIds.length > 0 && effectiveRoles.length === 0 && <div className="muted roles-pop-hint">Ничего не выбрано — показаны все роли</div>}
              </div>
            )}
          </div>
        </div>
        <span className="grow" />
        {onRunFilter && (runs.length > 0 || runSel !== 'all') && (
          <label className="lb-select">
            <span className="board-sort-label">Прогон</span>
            <select className="run-filter" value={runSel} aria-label="Фильтр по прогону" onChange={(e) => onRunFilter(e.target.value)}>
              <option value="all">Все прогоны</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id} title={r.objective}>
                  {runShortLabel(r, 5, 40)}{r.closedAt !== undefined ? ' (закрыт)' : ''}
                </option>
              ))}
              <option value="none">Без прогона</option>
            </select>
          </label>
        )}
        <label className="lb-select">
          <span className="board-sort-label">Сортировка</span>
          <select
            className="sort"
            value={sort}
            aria-label="Сортировка карточек"
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
                aria-label={`${column.title}, ${items.length} — развернуть`}
                title="Развернуть колонку"
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
            merged && ready.length > 0 && ready.length < items.length
              ? [
                  { label: `Готовы к запуску · ${ready.length}`, items: ready },
                  { label: `Ждут зависимостей · ${items.length - ready.length}`, items: items.filter((t) => kindOf(t.status) !== 'ready') }
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
              <div className="col-head" title={merged ? 'Вместе с «Готовы»: готовые к запуску — сверху, ждущие зависимостей — ниже' : undefined}>
                <span>{column.title}</span>
                <span className="count">{items.length}</span>
                <span className="grow" />
                {column.kind === 'needs_input' && items.length > 0 && <span className="flag">ждут вас</span>}
                {column.kind === 'done' && (
                  <button
                    type="button"
                    className="lb-tool"
                    aria-expanded
                    aria-label={`Свернуть колонку «${column.title}»`}
                    title="Свернуть колонку"
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
                  <div className="empty">{hidden > 0 ? `Скрыто фильтром: ${hidden}` : emptyText}</div>
                )}
                {groups.map((g) => (
                  <div key={g.label ?? 'all'} className="card-group">
                    {g.label && <div className="group-label">{g.label}</div>}
                    {g.items.map((task) => {
                      const ci = info.get(task.id)
                      if (!ci) return null
                      const kind = ci.input.kind
                      const stateLabel = CARD_STATE_LABEL[ci.state]
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
                          ariaLabel={[task.title, stateLabel && `Состояние: ${stateLabel}`, ci.essence?.text].filter(Boolean).join('. ')}
                          run={task.runId ? runById.get(task.runId) : undefined}
                          runs={runs}
                          showUpdated={sort === 'updated'}
                          selected={task.id === selectedId}
                          tabStop={task.id === tabStopId}
                          terminalOpen={runningTaskIds.has(task.id)}
                          canStart={canStart(task)}
                          showFeedback={kind !== 'review'}
                          revealable={!!onRevealInFeed}
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
        <span><kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> по карточкам</span>
        <span><kbd>Enter</kbd> открыть</span>
        <span><kbd>M</kbd> переместить</span>
        <span><kbd>S</kbd> запустить</span>
        <span><kbd>Esc</kbd> к глобальным</span>
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
