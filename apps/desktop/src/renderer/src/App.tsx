import type React from 'react'
import { useEffect, useState } from 'react'
import { DEFAULT_COLUMNS, DEFAULT_ROLES, type Task, type StoreSnapshot, type AgentInfo, type AgentKind, type Role } from '@orca-board/core'
import { PERMISSION_MODES, type Project, type PermissionMode } from '../../shared/ipc'
import { Board } from './Board'
import { Terminal } from './Terminal'
import { NewTaskModal } from './NewTaskModal'
import { CoordinatorModal } from './CoordinatorModal'
import { RolesEditor } from './RolesEditor'
import { ColumnsEditor } from './ColumnsEditor'
import { Icon } from './icons'
import { AgentLogo } from './AgentLogo'

type Tab = 'board' | 'terminals' | 'info'

interface OpenTerminal {
  ptyId: string
  label: string
  taskId?: string
  projectId?: string
  role: 'coordinator' | 'worker' | 'shell'
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
  const [tab, setTab] = useState<Tab>('board')
  /** PTY, которые уже завершились (pty:exit); терминал остаётся в списке, пока его не закроют. */
  const [exited, setExited] = useState<Set<string>>(() => new Set())
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
    // Терминал открыт (из UI или координатором через CLI). Вкладку не переключаем: при запуске из UI
    // это делает сам обработчик кнопки (startTask / startCoordinator / openShell), а CLI-запуск не должен
    // выдёргивать пользователя с доски. Активным становится только если ничего не выбрано.
    const offOpened = window.orca.worker.onOpened((t) => {
      setTerminals((prev) =>
        prev.some((x) => x.ptyId === t.ptyId)
          ? prev
          : [...prev, { ptyId: t.ptyId, label: t.label, taskId: t.taskId, projectId: t.projectId, role: t.role ?? 'worker' }]
      )
      setActivePty((cur) => cur ?? t.ptyId)
    })
    // Приложение само закрыло терминал воркера (задача → done, перезапуск): убираем его из списка.
    const offClosed = window.orca.worker.onClosed(({ ptyId }) => dropTerminal(ptyId))
    const offFocus = window.orca.projects.onFocus(async (projectId) => {
      await window.orca.projects.setActive(projectId)
      await refreshProjects()
    })
    return () => {
      offBoard()
      offOpened()
      offClosed()
      offFocus()
    }
  }, [])

  // Состояние «жив/завершился» для точки в списке терминалов.
  const ptyKey = terminals.map((t) => t.ptyId).join('\n')
  useEffect(() => {
    const offs = terminals.map((t) =>
      window.orca.pty.onExit(t.ptyId, () => setExited((prev) => (prev.has(t.ptyId) ? prev : new Set(prev).add(t.ptyId))))
    )
    return () => offs.forEach((off) => off())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyKey])

  const runningTaskIds = new Set(terminals.filter((t) => t.taskId && !exited.has(t.ptyId)).map((t) => t.taskId!))

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

  /** Показать вкладку «Терминалы» и, если задан, выбрать терминал. */
  function showTerminal(ptyId?: string): void {
    setTab('terminals')
    if (ptyId) setActivePty(ptyId)
  }

  /**
   * Открыть терминал задачи: вкладка «Терминалы» + PTY активного dispatch'а
   * (task.dispatchId → dispatch.ptyId). Нет открытого терминала — просто переключить вкладку.
   * Board кнопки «Терминал» на карточке не имеет; функция для модалки задачи (следующая задача).
   */
  function openTerminalForTask(taskId: string): void {
    const task = tasks.find((t) => t.id === taskId)
    const dispatch = snap.dispatches.find((d) => d.id === task?.dispatchId)
    const byDispatch = dispatch && terminals.find((t) => t.ptyId === dispatch.ptyId)
    const byTask = terminals.find((t) => t.taskId === taskId)
    showTerminal((byDispatch ?? byTask)?.ptyId)
  }

  async function openShell(): Promise<void> {
    const ptyId = await window.orca.pty.spawn({ cols: 120, rows: 30 })
    setTerminals((prev) => [...prev, { ptyId, label: 'терминал', projectId: active?.id, role: 'shell' }])
    showTerminal(ptyId)
  }

  /** Запуск из UI (кнопка «Запустить»): в отличие от CLI-запуска, сразу показываем терминал. */
  async function startTask(task: Task): Promise<void> {
    const res = await window.orca.worker.start(task.id, 120, 30)
    setSelected(task)
    showTerminal(res.ptyId)
  }

  /**
   * Убрать терминал из списка; если он был активным — выбрать соседний.
   * Только функциональные апдейтеры: worker:closed может прийти пачкой (main закрывает воркеры циклом)
   * до перерисовки, и обычное состояние/ref в обработчике было бы устаревшим. Повторный вызов
   * с тем же ptyId — no-op.
   */
  function dropTerminal(ptyId: string): void {
    setTerminals((prev) => {
      const idx = prev.findIndex((t) => t.ptyId === ptyId)
      if (idx < 0) return prev
      const next = prev.filter((t) => t.ptyId !== ptyId)
      setActivePty((a) => (a === ptyId ? (next[idx] ?? next[idx - 1])?.ptyId ?? null : a))
      return next
    })
    setExited((prev) => {
      if (!prev.has(ptyId)) return prev
      const next = new Set(prev)
      next.delete(ptyId)
      return next
    })
  }

  function closeTerminal(ptyId: string): void {
    window.orca.pty.kill(ptyId)
    dropTerminal(ptyId)
  }

  function selectTask(task: Task): void {
    setSelected(task)
    const t = terminals.find((x) => x.taskId === task.id)
    if (t) setActivePty(t.ptyId)
  }

  /** Подпись терминала в списке: имя, роль и агент — по задаче из снимка или по роли координатора. */
  function describeTerminal(t: OpenTerminal): { name: string; role: string; agent: string } {
    const project = projects.find((p) => p.id === t.projectId)
    const roles: Role[] = (project?.id === active?.id ? active?.roles : project?.roles) ?? DEFAULT_ROLES
    if (t.role === 'coordinator') {
      const role = roles.find((r) => r.id === 'coordinator')
      return { name: 'координатор', role: role?.title ?? 'Координатор', agent: role?.agent ?? 'claude' }
    }
    if (t.role === 'shell') return { name: t.label, role: 'оболочка', agent: 'shell' }
    const task = t.projectId === active?.id ? tasks.find((x) => x.id === t.taskId) : undefined
    const role = task && roles.find((r) => r.id === task.roleId)
    return { name: task?.title ?? t.label, role: role?.title ?? task?.roleId ?? 'воркер', agent: task?.agent ?? 'shell' }
  }

  return (
    <div className="app">
      <aside className="rail">
        <button className="icon"><Icon.menu /></button>
        <div style={{ height: 40 }} />
        <button className={`icon ${tab === 'board' ? 'active' : ''}`} title="Доска" onClick={() => setTab('board')}><Icon.board /></button>
        <button className="icon" title="Координатор" onClick={() => setShowCoord(true)}><Icon.users /></button>
        <button className={`icon ${tab === 'terminals' ? 'active' : ''}`} title="Терминалы" onClick={() => setTab('terminals')}><Icon.terminal /></button>
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
            <button className="round-btn" title="Открыть новый терминал" onClick={openShell} disabled={!active}><Icon.terminal /></button>
            <button className="btn-primary ghost" onClick={() => setShowCoord(true)} disabled={!active}>
              <Icon.users /> Координатор
            </button>
            <button className="btn-primary" onClick={() => setShowNew(true)} disabled={!active}>
              <Icon.plus /> Новая задача
            </button>
          </div>
          <div className="tabs">
            <button className={`tab ${tab === 'board' ? 'active' : ''}`} onClick={() => setTab('board')}>Канбан</button>
            <button className={`tab ${tab === 'terminals' ? 'active' : ''}`} onClick={() => setTab('terminals')}>
              Терминалы
              {terminals.length > 0 && <span className="tab-badge">{terminals.length}</span>}
            </button>
            <button className={`tab ${tab === 'info' ? 'active' : ''}`} onClick={() => setTab('info')}>О проекте</button>
          </div>
        </div>

        <div className="content">
          {tab === 'board' && (
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
          )}
          {tab === 'info' && (
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
                    <AgentLogo agent={a.id} size={20} />
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

          <div className={`term-page ${tab === 'terminals' ? '' : 'hidden'}`}>
            <div className="term-list">
              {terminals.length === 0 && <div className="empty">Нет открытых терминалов</div>}
              {terminals.map((t) => {
                const info = describeTerminal(t)
                const alive = !exited.has(t.ptyId)
                const project = projects.find((p) => p.id === t.projectId)
                return (
                  <div
                    key={t.ptyId}
                    className={`term-item ${t.ptyId === activePty ? 'active' : ''}`}
                    onClick={() => setActivePty(t.ptyId)}
                    title={[info.name, info.role, project?.name].filter(Boolean).join(' · ')}
                  >
                    <span className={`dot ${alive ? 'alive' : 'dead'}`} title={alive ? 'работает' : 'завершился'} />
                    <AgentLogo agent={info.agent} size={16} />
                    <span className="who">
                      <span className="name">{info.name}</span>
                      <span className="role">{info.role}</span>
                    </span>
                    <button
                      className="x"
                      title="Закрыть терминал"
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTerminal(t.ptyId)
                      }}
                    >
                      <Icon.close />
                    </button>
                  </div>
                )
              })}
            </div>
            <div className="term-body">
              {terminals.length === 0 && (
                <div className="empty">Терминалы появятся при запуске задачи или координатора. Кнопка сверху открывает обычную оболочку.</div>
              )}
              {terminals.map((t) => (
                <div key={t.ptyId} className={`term ${t.ptyId === activePty ? '' : 'hidden'}`}>
                  <Terminal ptyId={t.ptyId} visible={tab === 'terminals' && t.ptyId === activePty} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>

      {showCoord && active && (
        <CoordinatorModal
          onClose={() => setShowCoord(false)}
          onStart={async (objective) => {
            const ptyId = await window.orca.coordinator.start(objective, 120, 30)
            setShowCoord(false)
            showTerminal(ptyId)
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
