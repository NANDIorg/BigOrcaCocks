import type React from 'react'
import { useEffect, useState } from 'react'
import type { Task } from '@orca-board/core'
import { Board } from './Board'
import { Terminal } from './Terminal'
import { NewTaskModal } from './NewTaskModal'

interface OpenTerminal {
  ptyId: string
  label: string
  taskId?: string
}

export function App(): React.JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([])
  const [selected, setSelected] = useState<Task | undefined>()
  const [terminal, setTerminal] = useState<OpenTerminal | null>(null)
  const [showNew, setShowNew] = useState(false)

  useEffect(() => {
    window.orca.tasks.list().then(setTasks)
    return window.orca.tasks.onChange(setTasks)
  }, [])

  // Карточка выбрана → показываем её терминал, если запущен.
  const ptyByTask = new Map<string, string>()
  if (terminal?.taskId) ptyByTask.set(terminal.taskId, terminal.ptyId)

  async function openCoordinator(): Promise<void> {
    const ptyId = await window.orca.pty.spawn({ cols: 120, rows: 30, cwd: undefined })
    setTerminal({ ptyId, label: 'coordinator (shell)' })
  }

  async function startTask(task: Task): Promise<void> {
    const { ptyId } = await window.orca.worker.start(task.id, 120, 30)
    setTerminal({ ptyId, label: `${task.agent} · ${task.title}`, taskId: task.id })
    setSelected(task)
  }

  return (
    <div className="app">
      <div className="topbar">
        <h1>orca-board</h1>
        <span style={{ color: 'var(--muted)' }}>{tasks.length} задач</span>
        <div className="spacer" />
        <button onClick={openCoordinator}>Терминал</button>
        <button className="primary" onClick={() => setShowNew(true)}>
          + Задача
        </button>
      </div>
      <div className={`main ${terminal ? '' : 'no-term'}`}>
        <Board
          tasks={tasks}
          selectedId={selected?.id}
          onSelect={setSelected}
          onMove={(id, status) => window.orca.tasks.move(id, status)}
          onStart={startTask}
          onRemove={(id) => window.orca.tasks.remove(id)}
        />
        {terminal && (
          <div className="terminal-pane">
            <div className="head">
              <span>{terminal.label}</span>
              <div className="spacer" />
              <button
                className="small"
                onClick={() => {
                  window.orca.pty.kill(terminal.ptyId)
                  setTerminal(null)
                }}
              >
                закрыть
              </button>
            </div>
            <div className="body">
              <Terminal key={terminal.ptyId} ptyId={terminal.ptyId} />
            </div>
          </div>
        )}
      </div>
      {showNew && (
        <NewTaskModal
          tasks={tasks}
          onClose={() => setShowNew(false)}
          onCreate={async (input) => {
            await window.orca.tasks.create(input)
            setShowNew(false)
          }}
        />
      )}
    </div>
  )
}
