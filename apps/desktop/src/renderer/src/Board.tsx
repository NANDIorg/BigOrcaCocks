import type React from 'react'
import { useState } from 'react'
import {
  TASK_STATUSES, STATUS_TITLES, AGENT_TITLES,
  type Task, type TaskStatus, type AgentKind, type Question, type Dispatch
} from '@orca-board/core'
import { Icon } from './icons'

interface Props {
  tasks: Task[]
  questions: Question[]
  dispatches: Dispatch[]
  selectedId?: string
  runningTaskIds: Set<string>
  onSelect(task: Task): void
  onMove(id: string, status: TaskStatus): void
  onStart(task: Task): void
  onRemove(id: string): void
  onAnswer(questionId: string, answer: string): void
}

const COLUMN_STYLE: Record<TaskStatus, { color: string; icon: () => React.JSX.Element }> = {
  backlog: { color: 'var(--col-backlog)', icon: Icon.layers },
  ready: { color: 'var(--col-ready)', icon: Icon.star },
  in_progress: { color: 'var(--col-progress)', icon: Icon.spinner },
  needs_input: { color: 'var(--col-input)', icon: Icon.question },
  review: { color: 'var(--col-review)', icon: Icon.eye },
  done: { color: 'var(--col-done)', icon: Icon.done }
}

const AGENT_COLOR: Record<AgentKind, string> = {
  claude: '#d97757',
  codex: '#10a37f',
  opencode: '#8b5cf6',
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
  const { tasks, questions, dispatches, selectedId, runningTaskIds, onSelect, onMove, onStart, onRemove, onAnswer } = props
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const openQ = new Map<string, Question[]>()
  questions.filter((q) => !q.answeredAt).forEach((q) => openQ.set(q.taskId, [...(openQ.get(q.taskId) ?? []), q]))
  const lastDispatch = new Map<string, Dispatch>()
  dispatches.forEach((d) => lastDispatch.set(d.taskId, d))

  return (
    <div className="board">
      {TASK_STATUSES.map((status) => {
        const items = tasks.filter((t) => t.status === status)
        const style = COLUMN_STYLE[status]
        const ColIcon = style.icon
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
            <div className="col-head" style={{ background: style.color }}>
              <div className="label">
                <ColIcon />
                {STATUS_TITLES[status]}
              </div>
              <div className="count" style={{ background: 'rgba(0,0,0,.25)' }}>
                {items.length}/{tasks.length}
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
                        <div className="role">{AGENT_TITLES[task.agent]}</div>
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
                    </div>
                    {status === 'review' && d?.summary && <div className="summary">{d.summary}</div>}
                    {qs.map((q) => <QuestionBlock key={q.id} q={q} onAnswer={onAnswer} />)}
                    <div className="actions">
                      {(task.status === 'ready' || task.status === 'backlog' || d?.outcome === 'unknown' || d?.outcome === 'failed') &&
                        !runningTaskIds.has(task.id) && (
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
                      {task.status === 'review' && (
                        <button className="btn-sm" onClick={(e) => { e.stopPropagation(); onMove(task.id, 'done') }}>
                          Принять
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
