import type React from 'react'
import { useState } from 'react'
import { TASK_STATUSES, STATUS_TITLES, type Task, type TaskStatus } from '@orca-board/core'

interface Props {
  tasks: Task[]
  selectedId?: string
  onSelect(task: Task): void
  onMove(id: string, status: TaskStatus): void
  onStart(task: Task): void
  onRemove(id: string): void
}

export function Board({ tasks, selectedId, onSelect, onMove, onStart, onRemove }: Props): React.JSX.Element {
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null)

  return (
    <div className="board">
      {TASK_STATUSES.map((status) => {
        const items = tasks.filter((t) => t.status === status)
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
            }}
          >
            <h2>
              <span>{STATUS_TITLES[status]}</span>
              <span>{items.length}</span>
            </h2>
            <div className="cards">
              {items.map((task) => (
                <div
                  key={task.id}
                  className={`card ${task.id === selectedId ? 'selected' : ''}`}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/task-id', task.id)}
                  onClick={() => onSelect(task)}
                >
                  <div className="title">{task.title}</div>
                  <div className="meta">
                    <span className="agent">{task.agent}</span>
                    {task.branch && <span className="branch">{task.branch}</span>}
                    {task.deps.length > 0 && <span>deps: {task.deps.length}</span>}
                  </div>
                  <div className="actions">
                    {(task.status === 'ready' || task.status === 'backlog') && (
                      <button
                        className="small primary"
                        onClick={(e) => {
                          e.stopPropagation()
                          onStart(task)
                        }}
                      >
                        ▶ start
                      </button>
                    )}
                    <button
                      className="small"
                      onClick={(e) => {
                        e.stopPropagation()
                        onRemove(task.id)
                      }}
                    >
                      ✕
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
