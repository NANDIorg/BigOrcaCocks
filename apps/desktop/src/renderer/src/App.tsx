import type React from 'react'
import { useEffect, useState } from 'react'
import type { Task } from '@orca-board/core'
import { Board } from './Board'
import { Terminal } from './Terminal'
import { NewTaskModal } from './NewTaskModal'
import { Icon } from './icons'

interface OpenTerminal {
  ptyId: string
  label: string
  taskId?: string
  color: string
}

export function App(): React.JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([])
  const [selected, setSelected] = useState<Task | undefined>()
  const [terminals, setTerminals] = useState<OpenTerminal[]>([])
  const [activePty, setActivePty] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [tab, setTab] = useState<'board' | 'info'>('board')
  const [repo, setRepo] = useState<{ repoRoot: string; repoName: string }>({ repoRoot: '', repoName: '…' })

  useEffect(() => {
    window.orca.tasks.list().then(setTasks)
    window.orca.app.info().then(setRepo)
    return window.orca.tasks.onChange(setTasks)
  }, [])

  const runningTaskIds = new Set(terminals.filter((t) => t.taskId).map((t) => t.taskId!))

  function addTerminal(t: OpenTerminal): void {
    setTerminals((prev) => [...prev, t])
    setActivePty(t.ptyId)
  }

  async function openShell(): Promise<void> {
    const ptyId = await window.orca.pty.spawn({ cols: 120, rows: 30, cwd: repo.repoRoot || undefined })
    addTerminal({ ptyId, label: 'координатор', color: 'var(--accent)' })
  }

  async function startTask(task: Task): Promise<void> {
    const { ptyId } = await window.orca.worker.start(task.id, 120, 30)
    addTerminal({ ptyId, label: task.title, taskId: task.id, color: 'var(--col-progress)' })
    setSelected(task)
  }

  function closeTerminal(ptyId: string): void {
    window.orca.pty.kill(ptyId)
    setTerminals((prev) => {
      const next = prev.filter((t) => t.ptyId !== ptyId)
      if (activePty === ptyId) setActivePty(next[next.length - 1]?.ptyId ?? null)
      return next
    })
  }

  function selectTask(task: Task): void {
    setSelected(task)
    const t = terminals.find((x) => x.taskId === task.id)
    if (t) setActivePty(t.ptyId)
  }

  const hasTerm = terminals.length > 0

  return (
    <div className="app">
      <aside className="rail">
        <button className="icon"><Icon.menu /></button>
        <div style={{ height: 40 }} />
        <button className="icon active" title="Доска"><Icon.board /></button>
        <button className="icon" title="Агенты"><Icon.users /></button>
        <button className="icon" title="Уведомления"><Icon.bell /></button>
        <button className="icon" title="Настройки"><Icon.gear /></button>
        <div className="grow" />
        <div className="avatar">🐋</div>
      </aside>

      <aside className="sidebar">
        <div className="head">
          <h2>Проекты</h2>
          <button className="icon-btn" title="Поиск"><Icon.search /></button>
          <button className="icon-btn fill" title="Добавить проект"><Icon.plus /></button>
        </div>
        <div className="list">
          <div className="item active">
            <div className="name">{repo.repoName}</div>
            <div className="sub" title={repo.repoRoot}>{repo.repoRoot}</div>
          </div>
        </div>
        <div className="foot">
          <button className="btn-ghost">Управление проектами</button>
        </div>
      </aside>

      <main className="main">
        <div className="main-head">
          <div className="row">
            <h1>{repo.repoName}</h1>
            <button className="round-btn" title="Открыть терминал" onClick={openShell}><Icon.terminal /></button>
            <button className="round-btn" title="Настройки проекта"><Icon.edit /></button>
            <button className="btn-primary" onClick={() => setShowNew(true)}>
              <Icon.plus /> Новая задача
            </button>
          </div>
          <div className="tabs">
            <button className={`tab ${tab === 'board' ? 'active' : ''}`} onClick={() => setTab('board')}>Канбан</button>
            <button className={`tab ${tab === 'info' ? 'active' : ''}`} onClick={() => setTab('info')}>О проекте</button>
          </div>
        </div>

        <div className={`content ${hasTerm ? '' : 'no-term'}`}>
          {tab === 'board' ? (
            <Board
              tasks={tasks}
              selectedId={selected?.id}
              runningTaskIds={runningTaskIds}
              onSelect={selectTask}
              onMove={(id, status) => window.orca.tasks.move(id, status)}
              onStart={startTask}
              onRemove={(id) => window.orca.tasks.remove(id)}
            />
          ) : (
            <div style={{ padding: '28px 32px', color: 'var(--muted)' }}>
              <p>Репозиторий: <code>{repo.repoRoot}</code></p>
              <p>Задач: {tasks.length}. Открытых терминалов: {terminals.length}.</p>
              <p>Worktree создаются рядом с репозиторием в папке <code>.orca-worktrees</code>.</p>
            </div>
          )}

          {hasTerm && (
            <div className="term-panel">
              <div className="term-tabs">
                {terminals.map((t) => (
                  <button
                    key={t.ptyId}
                    className={`term-tab ${t.ptyId === activePty ? 'active' : ''}`}
                    onClick={() => setActivePty(t.ptyId)}
                  >
                    <span className="dot" style={{ background: t.color }} />
                    {t.label}
                    <span
                      className="x"
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTerminal(t.ptyId)
                      }}
                    >
                      <Icon.close />
                    </span>
                  </button>
                ))}
                <div className="grow" />
              </div>
              <div className="term-body">
                {terminals.map((t) => (
                  <div key={t.ptyId} className={`term ${t.ptyId === activePty ? '' : 'hidden'}`}>
                    <Terminal ptyId={t.ptyId} visible={t.ptyId === activePty} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>

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
