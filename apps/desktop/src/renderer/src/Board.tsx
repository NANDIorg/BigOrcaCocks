import type React from 'react'
import { useState } from 'react'
import { TASK_STATUSES, STATUS_TITLES, AGENT_TITLES, type Task, type TaskStatus, type AgentKind } from '@orca-board/core'
import { Icon } from './icons'

interface Props {
  tasks: Task[]
  selectedId?: string
  runningTaskIds: Set<string>
  onSelect(task: Task): void
  onMove(id: string, status: TaskStatus): void
  onStart(task: Task): void
  onRemove(id: string): void
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

export function Board({ tasks, selectedId, runningTaskIds, onSelect, onMove, onStart, onRemove }: Props): React.JSX.Element {
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const byId = new Map(tasks.map((t) => [t.id, t]))

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
              {items.map((task) => (
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
                    {task.deps.map((d) => (
                      <span key={d} className="chip" title={byId.get(d)?.title}>
                        ← {byId.get(d)?.title ?? d}
                      </span>
                    ))}
                    {runningTaskIds.has(task.id) && <span className="chip">● терминал</span>}
                  </div>
                  <div className="actions">
                    {(task.status === 'ready' || task.status === 'backlog') && (
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
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
