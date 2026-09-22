import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { DEFAULT_COLUMNS, DEFAULT_ROLES, type Task, type StoreSnapshot, type AgentInfo, type AgentKind, type Role } from '@orca-board/core'
import { PERMISSION_MODES, type Project, type PermissionMode } from '../../shared/ipc'
import { Board } from './Board'
import { Terminal } from './Terminal'
import { NewTaskModal } from './NewTaskModal'
import { CoordinatorModal } from './CoordinatorModal'
import { TaskModal } from './TaskModal'
import { RolesEditor } from './RolesEditor'
import { ColumnsEditor } from './ColumnsEditor'
import { DefaultsModal } from './DefaultsModal'
import { Icon } from './icons'
import { AgentLogo } from './AgentLogo'
import { ipcErrorMessage } from './useAutoSave'
import { RunsSection, type RunFilter } from './runs'

type Tab = 'board' | 'terminals' | 'info'

interface OpenTerminal {
  ptyId: string
  label: string
  taskId?: string
  projectId?: string
  role: 'coordinator' | 'worker' | 'shell'
}

const EMPTY: StoreSnapshot = { tasks: [], dispatches: [], events: [], questions: [], runs: [] }

/** Что открыто у проекта: вкладка и выбранный терминал. У каждого проекта своё. */
interface ProjectView {
  tab: Tab
  activePty: string | null
}

const TABS: Tab[] = ['board', 'terminals', 'info']
const tabKey = (projectId: string): string => `orca.tab.${projectId}`

/** Вкладка проекта из localStorage (переживает перезапуск); activePty хранится только в памяти. */
function storedTab(projectId: string): Tab {
  if (!projectId) return 'board'
  try {
    const v = localStorage.getItem(tabKey(projectId)) as Tab | null
    return v && TABS.includes(v) ? v : 'board'
  } catch {
    return 'board'
  }
}

const SHOW_PROJECTS_KEY = 'orca.showProjects'

/** Виден ли сайдбар проектов (по умолчанию да). */
function storedShowProjects(): boolean {
  try {
    return localStorage.getItem(SHOW_PROJECTS_KEY) !== 'false'
  } catch {
    return true
  }
}

function storeTab(projectId: string, tab: Tab): void {
  if (!projectId) return
  try {
    localStorage.setItem(tabKey(projectId), tab)
  } catch {
    // localStorage недоступен — вкладка просто не переживёт перезапуск
  }
}

export function App(): React.JSX.Element {
  const [snap, setSnap] = useState<StoreSnapshot>(EMPTY)
  const [projects, setProjects] = useState<Project[]>([])
  const [active, setActive] = useState<Project | null>(null)
  const [socketPath, setSocketPath] = useState('')
  const [selected, setSelected] = useState<Task | undefined>()
  const [terminals, setTerminals] = useState<OpenTerminal[]>([])
  const [showNew, setShowNew] = useState(false)
  const [showCoord, setShowCoord] = useState(false)
  const [showDefaults, setShowDefaults] = useState(false)
  const [showProjects, setShowProjects] = useState(storedShowProjects)
  /** Растёт после «Применить дефолт»: пересоздаёт редакторы ролей/колонок, чтобы черновик взял новые значения. */
  const [settingsRev, setSettingsRev] = useState(0)
  /** Задача, открытая в модалке; сама задача берётся из снимка по id, чтобы показывать актуальную. */
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  /** Вкладка и активный терминал по projectId; для активного проекта ниже — производные tab/activePty. */
  const [views, setViews] = useState<Record<string, ProjectView>>({})
  /** PTY, которые уже завершились (pty:exit); терминал остаётся в списке, пока его не закроют. */
  const [exited, setExited] = useState<Set<string>>(() => new Set())
  const [agents, setAgents] = useState<AgentInfo[]>([])
  /** Фильтр доски по прогону, свой у каждого проекта; только в памяти. */
  const [runFilters, setRunFilters] = useState<Record<string, RunFilter>>({})
  const tasks = snap.tasks
  const openTask = openTaskId ? tasks.find((t) => t.id === openTaskId) : undefined

  /** Записать вкладку/активный терминал в запись проекта (функционально — безопасно из обработчиков событий). */
  function updateView(projectId: string, patch: Partial<ProjectView>): void {
    if (patch.tab) storeTab(projectId, patch.tab)
    setViews((prev) => {
      const cur = prev[projectId] ?? { tab: storedTab(projectId), activePty: null }
      return { ...prev, [projectId]: { ...cur, ...patch } }
    })
  }

  /** Терминалы активного проекта: только их показываем в списке, бейдже и «О проекте». */
  const projectTerminals = terminals.filter((t) => t.projectId === active?.id)
  // Без проекта ключ '' — вкладки («О проекте» со списком агентов) работают, но не сохраняются.
  const viewKey = active?.id ?? ''
  const view: ProjectView = views[viewKey] ?? { tab: storedTab(viewKey), activePty: null }
  const tab = view.tab
  // activePty указывает на закрытый терминал (или не выбран) — берём первый оставшийся терминал проекта.
  const activePty = projectTerminals.some((t) => t.ptyId === view.activePty)
    ? view.activePty
    : projectTerminals[0]?.ptyId ?? null

  function setTab(next: Tab): void {
    updateView(viewKey, { tab: next })
  }

  function setActivePty(ptyId: string): void {
    updateView(viewKey, { activePty: ptyId })
  }

  /** id активного проекта для async-обработчиков, которым после await нужно текущее, а не замкнутое значение. */
  const activeIdRef = useRef(active?.id)
  activeIdRef.current = active?.id

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
      if (t.projectId) {
        const pid = t.projectId
        setViews((prev) =>
          prev[pid]?.activePty ? prev : { ...prev, [pid]: { tab: prev[pid]?.tab ?? storedTab(pid), activePty: t.ptyId } }
        )
      }
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

  // Смена активного проекта (сайдбар или projects:focus): выбор и модалка задачи чужого проекта не остаются.
  useEffect(() => {
    setSelected(undefined)
    setOpenTaskId(null)
  }, [active?.id])

  const runningTaskIds = new Set(terminals.filter((t) => t.taskId && !exited.has(t.ptyId)).map((t) => t.taskId!))

  async function switchProject(p: Project): Promise<void> {
    await window.orca.projects.setActive(p.id)
    setSelected(undefined)
    setOpenTaskId(null)
    await refreshProjects()
  }

  async function addProject(): Promise<void> {
    const p = await window.orca.projects.add()
    if (p) await refreshProjects()
  }

  /** Текущие настройки активного проекта → глобальный дефолт для новых проектов. */
  async function saveAsDefaults(p: Project): Promise<void> {
    if (!confirm(`Сохранить настройки проекта «${p.name}» (агенты, роли, колонки, разрешения) как дефолт для новых проектов?`)) return
    try {
      await window.orca.projects.setDefaults({
        permissionMode: p.permissionMode,
        enabledAgents: p.enabledAgents,
        roles: p.roles ?? DEFAULT_ROLES,
        columns: p.columns ?? DEFAULT_COLUMNS
      })
    } catch (e) {
      alert(ipcErrorMessage(e))
    }
  }

  /** Переписать настройки проекта дефолтом; задачи из исчезнувших колонок уезжают в бэклог. */
  async function applyDefaults(p: Project): Promise<void> {
    const ok = confirm(
      `Заменить агентов, роли, колонки и разрешения проекта «${p.name}» настройками по умолчанию?\n\n` +
        'Задачи из колонок, которых нет в дефолте, переедут в бэклог.'
    )
    if (!ok) return
    try {
      await window.orca.projects.applyDefaults(p.id)
    } catch (e) {
      alert(ipcErrorMessage(e))
    }
    await refreshProjects()
    setSettingsRev((r) => r + 1)
  }

  function toggleProjects(): void {
    const next = !showProjects
    setShowProjects(next)
    try {
      localStorage.setItem(SHOW_PROJECTS_KEY, String(next))
    } catch {
      // localStorage недоступен — состояние просто не переживёт перезапуск
    }
  }

  async function removeProject(p: Project): Promise<void> {
    await window.orca.projects.remove(p.id)
    await refreshProjects()
  }

  /**
   * Показать вкладку «Терминалы» у проекта, которому принадлежит терминал, и выбрать его.
   * Проект берётся из списка терминалов, иначе projectId (терминал только что создан и worker:opened
   * ещё не пришёл), иначе активный. Активный проект не переключается — у чужого проекта вкладка и
   * терминал просто запоминаются до перехода на него.
   */
  function showTerminal(ptyId?: string, projectId = active?.id): void {
    const pid = (ptyId && terminals.find((t) => t.ptyId === ptyId)?.projectId) || projectId
    if (!pid) return
    updateView(pid, ptyId ? { tab: 'terminals', activePty: ptyId } : { tab: 'terminals' })
  }

  /**
   * Открыть терминал задачи: вкладка «Терминалы» + PTY активного dispatch'а
   * (task.dispatchId → dispatch.ptyId). Нет открытого терминала — просто переключить вкладку.
   * Board кнопки «Терминал» на карточке не имеет; вызывается из модалки задачи.
   */
  function openTerminalForTask(taskId: string): void {
    const task = tasks.find((t) => t.id === taskId)
    const dispatch = snap.dispatches.find((d) => d.id === task?.dispatchId)
    const byDispatch = dispatch && terminals.find((t) => t.ptyId === dispatch.ptyId)
    const byTask = terminals.find((t) => t.taskId === taskId)
    showTerminal((byDispatch ?? byTask)?.ptyId)
  }

  async function openShell(): Promise<void> {
    const projectId = active?.id
    const ptyId = await window.orca.pty.spawn({ cols: 120, rows: 30 })
    setTerminals((prev) => [...prev, { ptyId, label: 'терминал', projectId, role: 'shell' }])
    showTerminal(ptyId, projectId)
  }

  /** Запуск из UI (кнопка «Запустить»): в отличие от CLI-запуска, сразу показываем терминал. */
  async function startTask(task: Task): Promise<void> {
    const projectId = active?.id
    const res = await window.orca.worker.start(task.id, 120, 30)
    if (projectId === activeIdRef.current) setSelected(task)
    showTerminal(res.ptyId, projectId)
  }

  /**
   * Убрать терминал из списка; если он был активным в своём проекте — выбрать соседний терминал того же проекта.
   * Только функциональные апдейтеры: worker:closed может прийти пачкой (main закрывает воркеры циклом)
   * до перерисовки, и обычное состояние/ref в обработчике было бы устаревшим. Повторный вызов
   * с тем же ptyId — no-op.
   */
  function dropTerminal(ptyId: string): void {
    setTerminals((prev) => {
      const idx = prev.findIndex((t) => t.ptyId === ptyId)
      if (idx < 0) return prev
      const pid = prev[idx].projectId
      const next = prev.filter((t) => t.ptyId !== ptyId)
      if (pid) {
        const same = prev.filter((t) => t.projectId === pid)
        const pos = same.findIndex((t) => t.ptyId === ptyId)
        const rest = same.filter((t) => t.ptyId !== ptyId)
        const neighbor = (rest[pos] ?? rest[pos - 1])?.ptyId ?? null
        setViews((v) => (v[pid]?.activePty === ptyId ? { ...v, [pid]: { ...v[pid], activePty: neighbor } } : v))
      }
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
    <div className={`app ${showProjects ? '' : 'no-sidebar'}`}>
      <aside className="rail">
        <button className={`icon ${showProjects ? 'active' : ''}`} title="Проекты" onClick={toggleProjects}><Icon.folder /></button>
        <button className={`icon ${showDefaults ? 'active' : ''}`} title="Основные настройки" onClick={() => setShowDefaults(true)}><Icon.gear /></button>
        <div className="grow" />
        <div className="avatar">🐋</div>
      </aside>

      {showProjects && (
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
        </aside>
      )}

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
              {projectTerminals.length > 0 && <span className="tab-badge">{projectTerminals.length}</span>}
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
              runs={snap.runs}
              runFilter={runFilters[viewKey] ?? 'all'}
              onRunFilter={(f) => setRunFilters((prev) => ({ ...prev, [viewKey]: f }))}
              questions={snap.questions}
              dispatches={snap.dispatches}
              selectedId={selected?.id}
              runningTaskIds={runningTaskIds}
              onSelect={selectTask}
              onOpenTask={(task) => setOpenTaskId(task.id)}
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
                  key={`${active.id}:${settingsRev}`}
                  storageKey={active.id}
                  roles={active.roles ?? DEFAULT_ROLES}
                  agents={agents}
                  onSave={async (roles) => {
                    await window.orca.projects.setRoles(active.id, roles)
                    await refreshProjects()
                  }}
                />
              )}
              {active && (
                <ColumnsEditor
                  key={`${active.id}:${settingsRev}`}
                  storageKey={active.id}
                  columns={active.columns ?? DEFAULT_COLUMNS}
                  onSave={async (columns) => {
                    await window.orca.projects.setColumns(active.id, columns)
                    await refreshProjects()
                  }}
                />
              )}
              {active && (
                <RunsSection
                  runs={snap.runs}
                  tasks={tasks}
                  columns={active.columns ?? DEFAULT_COLUMNS}
                  onClose={async (id) => {
                    try {
                      await window.orca.runs.close(id)
                    } catch (e) {
                      alert(ipcErrorMessage(e))
                    }
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
              {active && (
                <>
                  <h3 style={{ color: 'var(--text)', margin: '0 0 12px' }}>Основные настройки</h3>
                  <div className="defaults-actions">
                    <button className="btn-sm" onClick={() => void saveAsDefaults(active)}>Сохранить настройки этого проекта как дефолт</button>
                    <button className="btn-sm" onClick={() => void applyDefaults(active)}>Применить дефолт к этому проекту</button>
                    <button className="btn-text" onClick={() => setShowDefaults(true)}>Открыть основные настройки</button>
                  </div>
                  <p style={{ fontSize: 12, margin: '0 0 24px' }}>
                    Дефолт автоматически применяется к новым проектам. Применение к этому проекту заменит агентов,
                    роли, колонки и разрешения; задачи из удалённых колонок переедут в бэклог.
                  </p>
                </>
              )}
              <h3 style={{ color: 'var(--text)', margin: '0 0 12px' }}>О проекте</h3>
              <p>Репозиторий: <code>{active?.root ?? '—'}</code></p>
              <p>Идентификатор проекта для CLI: <code>{active?.id ?? '—'}</code></p>
              <p>Задач: {tasks.length}. Открытых терминалов: {projectTerminals.length}.</p>
              <p>Worktree создаются рядом с репозиторием в папке <code>.orca-worktrees</code>.</p>
              <p>Сокет CLI: <code>{socketPath}</code>. В терминалах доступна команда <code>orca-board --help</code>.</p>
              {active && (
                <button className="btn-ghost" style={{ width: 'auto', padding: '10px 18px' }} onClick={() => removeProject(active)}>Убрать из списка</button>
              )}
            </div>
          )}

          <div className={`term-page ${tab === 'terminals' ? '' : 'hidden'}`}>
            <div className="term-list">
              {projectTerminals.length === 0 && <div className="empty">Нет открытых терминалов</div>}
              {projectTerminals.map((t) => {
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
              {projectTerminals.length === 0 && (
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

      {showDefaults && <DefaultsModal agents={agents} onClose={() => setShowDefaults(false)} />}
      {showCoord && active && (
        <CoordinatorModal
          onClose={() => setShowCoord(false)}
          onStart={async (objective) => {
            const projectId = active.id
            const ptyId = await window.orca.coordinator.start(objective, 120, 30)
            setShowCoord(false)
            showTerminal(ptyId, projectId)
          }}
        />
      )}
      {openTask && active && (
        <TaskModal
          task={openTask}
          tasks={tasks}
          columns={active.columns ?? DEFAULT_COLUMNS}
          roles={active.roles ?? DEFAULT_ROLES}
          dispatches={snap.dispatches}
          questions={snap.questions}
          running={runningTaskIds.has(openTask.id)}
          onClose={() => setOpenTaskId(null)}
          onUpdate={(id, patch) => window.orca.tasks.update(id, patch)}
          onStart={startTask}
          onOpenTerminal={openTerminalForTask}
          onRemove={(id) => window.orca.tasks.remove(id)}
          onAnswer={(qid, a) => window.orca.questions.answer(qid, a)}
          onAccept={(id) => window.orca.review.accept(id)}
          onReject={(id, fb) => window.orca.review.reject(id, fb)}
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
