import type React from 'react'
import { useState } from 'react'
import {
  AGENT_TITLES,
  type Task, type Question, type Dispatch, type BoardColumn, type ColumnKind, type Role, type Run
} from '@orca-board/core'
import { Icon } from './icons'
import { AgentLogo } from './AgentLogo'
import { RunBadge, runShortLabel, type RunFilter } from './runs'
import { BOARD_SORT_KEY, SORT_OPTIONS, compareTasks, formatStamp, readSort, writeSort, type BoardSort } from './boardSort'
import { formatDuration, taskDuration } from './duration'
import { useNow } from './useNow'

interface Props {
  /** Колонки доски в порядке показа; статус задачи — id колонки. */
  columns: BoardColumn[]
  /** Роли проекта — для подписи на карточке. */
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
}

/** Иконка заголовка по виду колонки; у пользовательских — нейтральная. */
const COLUMN_ICON: Record<ColumnKind, () => React.JSX.Element> = {
  backlog: Icon.layers,
  ready: Icon.star,
  in_progress: Icon.spinner,
  needs_input: Icon.question,
  review: Icon.eye,
  done: Icon.done,
  custom: Icon.board
}

/** «3 файла», «5 файлов», «21 файл». */
function filesLabel(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return `${n} файл`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} файла`
  return `${n} файлов`
}

/** Строка «роль · агент · модель» под заголовком карточки. */
function subtitle(task: Task, role: Role | undefined): string {
  const parts = [role?.title ?? task.roleId, AGENT_TITLES[task.agent]]
  if (role?.model) parts.push(role.model)
  return parts.join(' · ')
}

/** Живой счётчик задачи в работе: таймер только у таких карточек, доска целиком не перерисовывается. */
function LiveDuration({ startedAt }: { startedAt: number }): React.JSX.Element {
  const now = useNow()
  return <div className="stamp">⏱ {formatDuration(taskDuration({ startedAt }, now) ?? 0)}</div>
}

export function Board(props: Props): React.JSX.Element {
  const { columns, roles, runs = [], runFilter = 'all', onRunFilter, emptyText = 'Пусто', questions, dispatches, selectedId, runningTaskIds, onSelect, onMove, onStart, onRemove, onOpenTask } = props
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [sort, setSort] = useState<BoardSort>(() => readSort(BOARD_SORT_KEY))
  const changeSort = (next: BoardSort): void => {
    setSort(next)
    writeSort(BOARD_SORT_KEY, next)
  }
  const byId = new Map(props.tasks.map((t) => [t.id, t]))
  const runById = new Map(runs.map((r) => [r.id, r]))
  // Выбранный прогон исчез из снимка — показываем все.
  const filter: RunFilter = runFilter === 'all' || runFilter === 'none' || runById.has(runFilter) ? runFilter : 'all'
  const tasks = props.tasks.filter((t) =>
    filter === 'all' ? true : filter === 'none' ? !t.runId : t.runId === filter
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

  return (
    <div className="board-wrap">
      <div className="board-toolbar">
        {onRunFilter && (runs.length > 0 || filter !== 'all') && (
          <>
            <span className="board-sort-label">Прогон:</span>
            <select
              className="run-filter"
              value={filter}
              aria-label="Фильтр по прогону"
              onChange={(e) => onRunFilter(e.target.value)}
            >
              <option value="all">Все прогоны</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id} title={r.objective}>
                  {runShortLabel(r, 5, 40)}{r.closedAt !== undefined ? ' (закрыт)' : ''}
                </option>
              ))}
              <option value="none">Без прогона</option>
            </select>
          </>
        )}
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
      <div className="board">
        {columns.map((column) => {
          const status = column.id
          const items = tasks.filter((t) => t.status === status).sort((a, b) => compareTasks(sort, a, b))
          const ColIcon = COLUMN_ICON[column.kind]
          return (
            <div
              key={status}
              className={`column ${dragOver === status ? 'drag-over' : ''}`}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('text/task-id')) return
                e.preventDefault()
                setDragOver(status)
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => {
                e.preventDefault()
                const id = e.dataTransfer.getData('text/task-id')
                if (id && byId.get(id)?.status !== status) onMove(id, status)
                setDragOver(null)
                setDragging(null)
              }}
            >
              <div className="col-head" style={{ background: column.color }}>
                <div className="label">
                  <ColIcon />
                  {column.title}
                </div>
                <div className="count" style={{ background: 'rgba(0,0,0,.25)' }}>
                  {items.length}
                </div>
              </div>
              <div className="col-body">
                {dragOver === status && dragging && byId.get(dragging)?.status !== status && (
                  <div className="placeholder" />
                )}
                {items.length === 0 && dragOver !== status && <div className="empty">{emptyText}</div>}
                {items.map((task) => {
                  const qs = openQ.get(task.id) ?? []
                  const d = lastDispatch.get(task.id)
                  const kind = kindOf(task.status)
                  const canStart =
                    (kind === 'ready' || kind === 'backlog' || d?.outcome === 'unknown' || d?.outcome === 'failed') &&
                    !runningTaskIds.has(task.id)
                  return (
                    <div
                      key={task.id}
                      className={`card ${task.id === selectedId ? 'selected' : ''}`}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/task-id', task.id)
                        setDragging(task.id)
                      }}
                      onDragEnd={() => setDragging(null)}
                      onClick={() => open(task)}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.target === e.currentTarget && e.key === 'Enter') open(task)
                      }}
                    >
                      <div className="card-tools" onClick={(e) => e.stopPropagation()}>
                        {canStart && (
                          <button
                            type="button"
                            className="card-tool"
                            title="Запустить"
                            aria-label="Запустить"
                            onClick={() => onStart(task)}
                          >
                            <Icon.play />
                          </button>
                        )}
                        <button
                          type="button"
                          className="card-tool danger"
                          title="Удалить"
                          aria-label="Удалить"
                          onClick={() => remove(task)}
                        >
                          <Icon.trash />
                        </button>
                      </div>
                      <div className="top">
                        <AgentLogo agent={task.agent} size={28} />
                        <div className="who">
                          <div className="name" title={task.title}>{task.title}</div>
                          <div className="role">{subtitle(task, roleOf(task))}</div>
                        </div>
                      </div>
                      <div className="chips">
                        {task.runId && runById.has(task.runId) && <RunBadge run={runById.get(task.runId)!} runs={runs} />}
                        {task.answerFor && (
                          <span className="chip answer" title={task.answerFor === 'human' ? 'Результат — ответ для человека' : 'Результат — ответ для координатора'}>
                            {task.answerFor === 'human' ? 'ответ' : 'ответ координатору'}
                          </span>
                        )}
                        {task.branch && !task.answerFor && <span className="chip mono" title={task.branch}>{task.branch}</span>}
                        {task.deps.map((dep) => (
                          <span key={dep} className="chip" title={byId.get(dep)?.title}>
                            ← {byId.get(dep)?.title ?? dep}
                          </span>
                        ))}
                        {runningTaskIds.has(task.id) && <span className="chip live">● терминал</span>}
                        {kind !== 'done' && d?.outcome === 'unknown' && <span className="chip warn">вышел без done</span>}
                        {kind !== 'done' && d?.outcome === 'failed' && <span className="chip warn">упал</span>}
                        {kind !== 'done' && d?.stuckNotified && !d.endedAt && <span className="chip warn">молчит</span>}
                      </div>
                      {column.kind === 'done' && task.doneAt !== undefined ? (
                        <div className="stamp">
                          Завершено: {formatStamp(task.doneAt)}
                          {task.startedAt !== undefined && <> · за {formatDuration(taskDuration(task, task.doneAt) ?? 0)}</>}
                        </div>
                      ) : sort === 'updated' ? (
                        <div className="stamp">Обновлено: {formatStamp(task.updatedAt)}</div>
                      ) : null}
                      {task.startedAt !== undefined && task.doneAt === undefined && <LiveDuration startedAt={task.startedAt} />}
                      {task.feedback && column.kind !== 'review' && (
                        <div className="card-feedback" title={task.feedback}>↩ {task.feedback}</div>
                      )}
                      {(column.kind === 'review' || (column.kind === 'needs_input' && task.answerFor && d?.answer)) && (
                        <div className="card-brief review-brief">
                          <span className="brief-text" title={task.answerFor ? d?.summary : undefined}>
                            {task.answerFor
                              ? `Ответ готов${d?.summary ? `: ${d.summary}` : ''}`
                              : d?.files && d.files.length > 0 ? `Ждёт ревью: ${filesLabel(d.files.length)}` : 'Ждёт ревью'}
                          </span>
                          <button type="button" className="btn-sm" onClick={(e) => { e.stopPropagation(); open(task) }}>
                            Открыть
                          </button>
                        </div>
                      )}
                      {qs.map((q) => (
                        <div key={q.id} className="card-brief question-brief">
                          <span className="brief-text" title={q.question}>{q.question}</span>
                          <button type="button" className="btn-sm" onClick={(e) => { e.stopPropagation(); open(task) }}>
                            Открыть
                          </button>
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
