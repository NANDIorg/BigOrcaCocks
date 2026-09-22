import type React from 'react'
import { useEffect, useState } from 'react'
import type { Task, StoreSnapshot } from '@orca-board/core'
import type { Project } from '../../shared/ipc'
import { Board } from './Board'
import { Terminal } from './Terminal'
import { NewTaskModal } from './NewTaskModal'
import { CoordinatorModal } from './CoordinatorModal'
import { Icon } from './icons'

interface OpenTerminal {
  ptyId: string
  label: string
  taskId?: string
  projectId?: string
  color: string
}

const EMPTY: StoreSnapshot = { tasks: [], dispatches: [], events: [], questions: [] }

export function App(): React.JSX.Element {
  const [snap, setSnap] = useState<StoreSnapshot>(EMPTY)
  const [projects, setProjects] = useState<Project[]>([])
  const [active, setActive] = useState<Project | null>(null)
  const [socketPath, setSocketPath] = useState('')
  const [selected, setSelected] = useState<Task | undefined>()
  const [terminals, setTerminals] = useState<OpenTerminal[]>([])
  const [activePty, setActivePty] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [showCoord, setShowCoord] = useState(false)
  const [tab, setTab] = useState<'board' | 'info'>('board')
  const tasks = snap.tasks

  async function refreshProjects(): Promise<void> {
    const res = await window.orca.projects.list()
    setProjects(res.projects)
    setActive(res.active)
    setSnap(res.active ? await window.orca.board.get() : EMPTY)
  }

  useEffect(() => {
    window.orca.app.info().then((i) => setSocketPath(i.socketPath))
    void refreshProjects()
    const offBoard = window.orca.board.onChange(({ projectId, snapshot }) => {
      setActive((cur) => {
        if (cur?.id === projectId) setSnap(snapshot)
        return cur
      })
    })
    const offOpened = window.orca.worker.onOpened((t) => {
      const color = t.role === 'coordinator' ? 'var(--accent)' : 'var(--col-progress)'
      setTerminals((prev) =>
        prev.some((x) => x.ptyId === t.ptyId)
          ? prev
          : [...prev, { ptyId: t.ptyId, label: t.label, taskId: t.taskId, projectId: t.projectId, color }]
      )
      setActivePty(t.ptyId)
    })
    const offFocus = window.orca.projects.onFocus(async (projectId) => {
      await window.orca.projects.setActive(projectId)
      await refreshProjects()
    })
    return () => {
      offBoard()
      offOpened()
      offFocus()
    }
  }, [])

  const runningTaskIds = new Set(terminals.filter((t) => t.taskId).map((t) => t.taskId!))

  async function switchProject(p: Project): Promise<void> {
    await window.orca.projects.setActive(p.id)
    setSelected(undefined)
    await refreshProjects()
  }

  async function addProject(): Promise<void> {
    const p = await window.orca.projects.add()
    if (p) await refreshProjects()
  }

  async function removeProject(p: Project): Promise<void> {
    await window.orca.projects.remove(p.id)
    await refreshProjects()
  }

  async function openShell(): Promise<void> {
    const ptyId = await window.orca.pty.spawn({ cols: 120, rows: 30 })
    setTerminals((prev) => [...prev, { ptyId, label: 'терминал', projectId: active?.id, color: 'var(--muted)' }])
    setActivePty(ptyId)
  }

  async function startTask(task: Task): Promise<void> {
    await window.orca.worker.start(task.id, 120, 30)
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
        <button className={`icon ${tab === 'board' ? 'active' : ''}`} title="Доска" onClick={() => setTab('board')}><Icon.board /></button>
        <button className="icon" title="Координатор" onClick={() => setShowCoord(true)}><Icon.users /></button>
        <button className="icon" title="Терминал" onClick={openShell}><Icon.terminal /></button>
        <button className={`icon ${tab === 'info' ? 'active' : ''}`} title="О проекте" onClick={() => setTab('info')}><Icon.gear /></button>
        <div className="grow" />
        <div className="avatar">🐋</div>
      </aside>

      <aside className="sidebar">
        <div className="head">
          <h2>Проекты</h2>
          <button className="icon-btn fill" title="Добавить репозиторий" onClick={addProject}><Icon.plus /></button>
        </div>
        <div className="list">
          {projects.length === 0 && <div className="empty">Нажмите +, чтобы добавить git-репозиторий</div>}
          {projects.map((p) => (
            <div key={p.id} className={`item ${p.id === active?.id ? 'active' : ''}`} onClick={() => switchProject(p)}>
              <div className="name">{p.name}</div>
              <div className="sub" title={p.root}>{p.root.replace(/^\/Users\/[^/]+/, '~')}</div>
            </div>
          ))}
        </div>
        <div className="foot">
          {active && (
            <button className="btn-ghost" onClick={() => removeProject(active)}>Убрать из списка</button>
          )}
        </div>
      </aside>

      <main className="main">
        <div className="main-head">
          <div className="row">
            <h1>{active?.name ?? 'orca-board'}</h1>
            <button className="round-btn" title="Открыть терминал" onClick={openShell} disabled={!active}><Icon.terminal /></button>
            <button className="btn-primary ghost" onClick={() => setShowCoord(true)} disabled={!active}>
              <Icon.users /> Координатор
            </button>
            <button className="btn-primary" onClick={() => setShowNew(true)} disabled={!active}>
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
              questions={snap.questions}
              dispatches={snap.dispatches}
              selectedId={selected?.id}
              runningTaskIds={runningTaskIds}
              onSelect={selectTask}
              onMove={(id, status) => window.orca.tasks.move(id, status)}
              onStart={startTask}
              onRemove={(id) => window.orca.tasks.remove(id)}
              onAnswer={(qid, a) => window.orca.questions.answer(qid, a)}
              onAccept={(id) => window.orca.review.accept(id)}
              onReject={(id, fb) => window.orca.review.reject(id, fb)}
            />
          ) : (
            <div style={{ padding: '28px 32px', color: 'var(--muted)' }}>
              <p>Репозиторий: <code>{active?.root ?? '—'}</code></p>
              <p>Идентификатор проекта для CLI: <code>{active?.id ?? '—'}</code></p>
              <p>Задач: {tasks.length}. Открытых терминалов: {terminals.length}.</p>
              <p>Worktree создаются рядом с репозиторием в папке <code>.orca-worktrees</code>.</p>
              <p>Сокет CLI: <code>{socketPath}</code>. В терминалах доступна команда <code>orca-board --help</code>.</p>
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
                    title={projects.find((p) => p.id === t.projectId)?.name}
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

      {showCoord && active && (
        <CoordinatorModal
          onClose={() => setShowCoord(false)}
          onStart={async (objective) => {
            await window.orca.coordinator.start(objective, 120, 30)
            setShowCoord(false)
          }}
        />
      )}
      {showNew && active && (
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
