import type React from 'react'
import { useState } from 'react'
import {
  AGENT_TITLES,
  type Task, type AgentKind, type Question, type Dispatch, type BoardColumn, type ColumnKind, type Role
} from '@orca-board/core'
import { Icon } from './icons'
import { ReviewBlock } from './ReviewBlock'

interface Props {
  /** Колонки доски в порядке показа; статус задачи — id колонки. */
  columns: BoardColumn[]
  /** Роли проекта — для подписи на карточке. */
  roles: Role[]
  tasks: Task[]
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

const AGENT_COLOR: Record<AgentKind, string> = {
  claude: '#d97757',
  codex: '#10a37f',
  opencode: '#8b5cf6',
  gemini: '#4285f4',
  cursor: '#e5484d',
  amp: '#f59e0b',
  copilot: '#2ea043',
  goose: '#0ea5e9',
  shell: '#6b6f7c'
}

function agentInitial(agent: AgentKind): string {
  return agent === 'shell' ? '$' : agent[0].toUpperCase()
}

function QuestionBlock({ q, onAnswer }: { q: Question; onAnswer(id: string, a: string): void }): React.JSX.Element {
  const [text, setText] = useState('')
  return (
    <div className="question" onClick={(e) => e.stopPropagation()}>
      <div className="q-text">{q.question}</div>
      <div className="q-options">
        {q.options.map((o) => (
          <button key={o} className="btn-sm primary" onClick={() => onAnswer(q.id, o)}>{o}</button>
        ))}
      </div>
      <div className="q-free">
        <input
          value={text}
          placeholder="Свой ответ"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim()) onAnswer(q.id, text.trim())
          }}
        />
        <button className="btn-sm" disabled={!text.trim()} onClick={() => onAnswer(q.id, text.trim())}>Ответить</button>
      </div>
    </div>
  )
}

export function Board(props: Props): React.JSX.Element {
  const { columns, roles, tasks, questions, dispatches, selectedId, runningTaskIds, onSelect, onMove, onStart, onRemove, onAnswer, onAccept, onReject } = props
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  // Все проверки статуса — по виду колонки, а не по её id: id у кастомных колонок произвольные.
  const kindById = new Map(columns.map((c) => [c.id, c.kind]))
  const kindOf = (status: string): ColumnKind | undefined => kindById.get(status)
  const roleTitle = (task: Task): string => roles.find((r) => r.id === task.roleId)?.title ?? task.roleId
  const openQ = new Map<string, Question[]>()
  questions.filter((q) => !q.answeredAt).forEach((q) => openQ.set(q.taskId, [...(openQ.get(q.taskId) ?? []), q]))
  const lastDispatch = new Map<string, Dispatch>()
  dispatches.forEach((d) => lastDispatch.set(d.taskId, d))

  return (
    <div className="board">
      {columns.map((column) => {
        const status = column.id
        const items = tasks.filter((t) => t.status === status)
        const ColIcon = COLUMN_ICON[column.kind]
        return (
          <div
            key={status}
            className={`column ${dragOver === status ? 'drag-over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(status)
            }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(e) => {
              e.preventDefault()
              const id = e.dataTransfer.getData('text/task-id')
              if (id) onMove(id, status)
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
              {items.length === 0 && dragOver !== status && <div className="empty">Пусто</div>}
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
                    onClick={() => onSelect(task)}
                  >
                    <div className="top">
                      <div className="av" style={{ background: AGENT_COLOR[task.agent] }}>
                        {agentInitial(task.agent)}
                      </div>
                      <div className="who">
                        <div className="name" title={task.title}>{task.title}</div>
                        <div className="role">{roleTitle(task)} · {AGENT_TITLES[task.agent]}</div>
                      </div>
                      <span className="grip"><Icon.grip /></span>
                    </div>
                    <div className="chips">
                      {task.branch && <span className="chip mono">{task.branch}</span>}
                      {task.deps.map((dep) => (
                        <span key={dep} className="chip" title={byId.get(dep)?.title}>
                          ← {byId.get(dep)?.title ?? dep}
                        </span>
                      ))}
                      {runningTaskIds.has(task.id) && <span className="chip live">● терминал</span>}
                      {d?.outcome === 'unknown' && <span className="chip warn">вышел без done</span>}
                      {d?.outcome === 'failed' && <span className="chip warn">упал</span>}
                      {d?.stuckNotified && !d.endedAt && <span className="chip warn">молчит</span>}
                    </div>
                    {task.feedback && column.kind !== 'review' && <div className="summary">↩ {task.feedback}</div>}
                    {column.kind === 'review' && (
                      <ReviewBlock
                        taskId={task.id}
                        summary={d?.summary}
                        onAccept={() => onAccept(task.id)}
                        onReject={(fb) => onReject(task.id, fb)}
                      />
                    )}
                    {qs.map((q) => <QuestionBlock key={q.id} q={q} onAnswer={onAnswer} />)}
                    <div className="actions">
                      {canStart && (
                        <button
                          className="btn-sm primary"
                          onClick={(e) => {
                            e.stopPropagation()
                            onStart(task)
                          }}
                        >
                          <Icon.play /> Запустить
                        </button>
                      )}
                      <button
                        className="btn-sm danger"
                        onClick={(e) => {
                          e.stopPropagation()
                          onRemove(task.id)
                        }}
                      >
                        Удалить
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
