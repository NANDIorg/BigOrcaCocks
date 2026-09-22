import type React from 'react'
import { useEffect, useState } from 'react'
import { DEFAULT_COLUMNS, DEFAULT_ROLES, type Task, type StoreSnapshot, type AgentInfo, type AgentKind } from '@orca-board/core'
import { PERMISSION_MODES, type Project, type PermissionMode } from '../../shared/ipc'
import { Board } from './Board'
import { Terminal } from './Terminal'
import { NewTaskModal } from './NewTaskModal'
import { CoordinatorModal } from './CoordinatorModal'
import { RolesEditor } from './RolesEditor'
import { ColumnsEditor } from './ColumnsEditor'
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
  const [termVisible, setTermVisible] = useState(true)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const tasks = snap.tasks

  async function refreshProjects(): Promise<void> {
    const res = await window.orca.projects.list()
    setProjects(res.projects)
    setActive(res.active)
    setSnap(res.active ? await window.orca.board.get() : EMPTY)
    await refreshAgents()
  }

  /** Список агентов (установлен/включён в активном проекте); refresh — заново просканировать PATH. */
  async function refreshAgents(refresh = false): Promise<void> {
    setAgents(await window.orca.agents.list(refresh))
  }

  async function toggleAgent(id: AgentKind, enabled: boolean): Promise<void> {
    if (!active) return
    const next = agents.filter((a) => (a.id === id ? enabled : a.enabled)).map((a) => a.id)
    await window.orca.projects.setEnabledAgents(active.id, next)
    await refreshProjects()
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
      setTermVisible(true)
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
    setTermVisible(true)
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

  const hasTerm = terminals.length > 0 && termVisible

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
            <button className="round-btn" title="Открыть новый терминал" onClick={openShell} disabled={!active}><Icon.plus /></button>
            <button
              className={`round-btn ${hasTerm ? 'on' : ''}`}
              title={termVisible ? 'Скрыть панель терминалов' : 'Показать панель терминалов'}
              onClick={() => setTermVisible((v) => !v)}
              disabled={terminals.length === 0}
            >
              <Icon.terminal />
              {terminals.length > 0 && <span className="badge">{terminals.length}</span>}
            </button>
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
              columns={active?.columns ?? DEFAULT_COLUMNS}
              roles={active?.roles ?? DEFAULT_ROLES}
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
            <div className="info">
              <div className="agents-head">
                <h3>Агенты</h3>
                <button className="btn-text" onClick={() => void refreshAgents(true)}>Обновить</button>
              </div>
              <div style={{ marginBottom: 8 }}>
                {agents.map((a) => (
                  <label key={a.id} className={`agent-row ${a.installed ? '' : 'off'}`}>
                    <input
                      type="checkbox"
                      checked={a.enabled}
                      disabled={!active || !a.installed}
                      onChange={(e) => void toggleAgent(a.id, e.target.checked)}
                    />
                    <span>{a.title}</span>
                    {a.version && <span className="ver">{a.version}</span>}
                    {!a.installed && <span className="ver">не установлен</span>}
                  </label>
                ))}
              </div>
              <p style={{ fontSize: 12, margin: '0 0 24px' }}>
                Выключенные агенты нельзя выбрать для роли; координатор их тоже не предложит.
                Установленные агенты определяются по PATH.
              </p>
              {active && (
                <RolesEditor
                  active={active}
                  agents={agents}
                  onSave={async (roles) => {
                    await window.orca.projects.setRoles(active.id, roles)
                    await refreshProjects()
                  }}
                />
              )}
              {active && (
                <ColumnsEditor
                  active={active}
                  onSave={async (columns) => {
                    await window.orca.projects.setColumns(active.id, columns)
                    await refreshProjects()
                  }}
                />
              )}
              <h3 style={{ color: 'var(--text)', margin: '0 0 12px' }}>Разрешения агентов</h3>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 24 }}>
                Как Claude Code (координатор и воркеры) обращается с подтверждениями
                <select
                  value={active?.permissionMode ?? 'auto'}
                  disabled={!active}
                  onChange={async (e) => {
                    if (!active) return
                    await window.orca.projects.setPermissionMode(active.id, e.target.value as PermissionMode)
                    await refreshProjects()
                  }}
                >
                  {(Object.keys(PERMISSION_MODES) as PermissionMode[]).map((m) => (
                    <option key={m} value={m}>{PERMISSION_MODES[m]}</option>
                  ))}
                </select>
                <span style={{ fontSize: 12 }}>Команда <code>orca-board</code> разрешена всегда. Действует на новые терминалы.</span>
              </label>
              <h3 style={{ color: 'var(--text)', margin: '0 0 12px' }}>О проекте</h3>
              <p>Репозиторий: <code>{active?.root ?? '—'}</code></p>
              <p>Идентификатор проекта для CLI: <code>{active?.id ?? '—'}</code></p>
              <p>Задач: {tasks.length}. Открытых терминалов: {terminals.length}.</p>
              <p>Worktree создаются рядом с репозиторием в папке <code>.orca-worktrees</code>.</p>
              <p>Сокет CLI: <code>{socketPath}</code>. В терминалах доступна команда <code>orca-board --help</code>.</p>
            </div>
          )}

          {terminals.length > 0 && (
            <div className={`term-panel ${hasTerm ? '' : 'hidden'}`}>
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
          roles={active?.roles ?? DEFAULT_ROLES}
          agents={agents}
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
