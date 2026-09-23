import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_COLUMNS, DEFAULT_ROLES, assistantRole, globalBoardColumns, globalStoredColumns, toGlobalTasks,
  type Task, type StoreSnapshot, type AgentInfo, type Role, type GlobalTask, type HumanRequest, type RequestResolution
} from '@orca-board/core'
import type { Project, TerminalInfo } from '../../shared/ipc'
import { Board } from './Board'
import { Terminal } from './Terminal'
import { NewTaskModal } from './NewTaskModal'
import { CoordinatorModal } from './CoordinatorModal'
import { TaskModal } from './TaskModal'
import { Icon } from './icons'
import { AgentLogo } from './AgentLogo'
import { ipcErrorMessage } from './useAutoSave'
import { AboutProject } from './about/AboutProject'
import { SettingsModal } from './settings/SettingsModal'
import { DocsModal } from './DocsModal'
import { GlobalBoard, type GlobalTaskAttention } from './GlobalBoard'
import { GlobalTaskView } from './GlobalTaskView'
import { GlobalTaskModal } from './GlobalTaskModal'
import { InboxPanel, pendingRequests } from './InboxPanel'

type Tab = 'board' | 'terminals' | 'info'

interface OpenTerminal {
  ptyId: string
  label: string
  taskId?: string
  projectId?: string
  role: TerminalInfo['role']
  /** Глобальная задача (прогон) координатора. */
  runId?: string
}

const toOpenTerminal = (t: TerminalInfo): OpenTerminal => ({
  ptyId: t.ptyId,
  label: t.label,
  role: t.role,
  taskId: t.taskId,
  projectId: t.projectId,
  runId: t.runId
})

const EMPTY: StoreSnapshot = { tasks: [], dispatches: [], events: [], questions: [], runs: [], requests: [] }

/** Что открыто у проекта: вкладка, выбранный терминал и открытая глобальная задача. У каждого проекта своё. */
interface ProjectView {
  tab: Tab
  activePty: string | null
  /** Открытая глобальная задача (экран её подзадач); null — общая доска. Id может устареть — проверяется по снимку. */
  globalId: string | null
}

const TABS: Tab[] = ['board', 'terminals', 'info']
const tabKey = (projectId: string): string => `orca.tab.${projectId}`
const globalKey = (projectId: string): string => `orca.global.${projectId}`

/** Начальная запись проекта: вкладка и глобальная задача из localStorage (переживают перезапуск). */
function storedView(projectId: string): ProjectView {
  return { tab: storedTab(projectId), activePty: null, globalId: storedGlobal(projectId) }
}

function storedGlobal(projectId: string): string | null {
  if (!projectId) return null
  try {
    return localStorage.getItem(globalKey(projectId))
  } catch {
    return null
  }
}

function storeGlobal(projectId: string, id: string | null): void {
  if (!projectId) return
  try {
    if (id) localStorage.setItem(globalKey(projectId), id)
    else localStorage.removeItem(globalKey(projectId))
  } catch {
    // localStorage недоступен — открытая задача просто не переживёт перезапуск
  }
}

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
  /** Задач в работе по id проекта — бейдж в сайдбаре «Проекты». */
  const [inProgress, setInProgress] = useState<Record<string, number>>({})
  const [socketPath, setSocketPath] = useState('')
  const [selected, setSelected] = useState<Task | undefined>()
  const [terminals, setTerminals] = useState<OpenTerminal[]>([])
  const [showNew, setShowNew] = useState(false)
  /** Модалка глобальной задачи: создание или правка (по id — берётся актуальная из снимка). */
  const [globalModal, setGlobalModal] = useState<{ mode: 'create' } | { mode: 'edit'; id: string } | null>(null)
  /** Глобальная задача, из которой вернулись на общую доску, — её карточке возвращается фокус. */
  const [lastGlobal, setLastGlobal] = useState<string | undefined>()
  const [showCoord, setShowCoord] = useState(false)
  const [showProjects, setShowProjects] = useState(storedShowProjects)
  /** Окно «Настройки» (шестерёнка в rail): общие настройки и дефолт для новых проектов. */
  const [showSettings, setShowSettings] = useState(false)
  /** Окно «Документы» (кнопка в rail): .md проекта и задач в работе. */
  const [showDocs, setShowDocs] = useState(false)
  /** Задача, открытая в модалке; сама задача берётся из снимка по id, чтобы показывать актуальную. */
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  /** Вкладка и активный терминал по projectId; для активного проекта ниже — производные tab/activePty. */
  const [views, setViews] = useState<Record<string, ProjectView>>({})
  /** PTY, которые уже завершились (pty:exit); терминал остаётся в списке, пока его не закроют. */
  const [exited, setExited] = useState<Set<string>>(() => new Set())
  /**
   * Те же завершившиеся PTY, но синхронно: main шлёт pty:exit раньше terminals:changed, и сверке
   * списка нужно знать о выходе до перерисовки.
   */
  const exitedRef = useRef<Set<string>>(new Set())
  /** Закрытые пользователем PTY: их вкладка уже убрана, запоздалый terminals:changed не должен её вернуть. */
  const killedRef = useRef<Set<string>>(new Set())
  /** Хвост вывода из terminals:list по ptyId — начальное содержимое xterm после перезагрузки окна. */
  const [tails, setTails] = useState<Record<string, string>>({})
  const [agents, setAgents] = useState<AgentInfo[]>([])
  /** Инбокс — панель запросов к человеку (⌘J, бейдж «Входящие» в шапке, клик по уведомлению). */
  const [showInbox, setShowInbox] = useState(false)
  /** Запрос, на котором открыть Инбокс (уведомление); nonce — повторный клик по тому же уведомлению. */
  const [inboxFocus, setInboxFocus] = useState<{ requestId: string; nonce: number } | null>(null)
  const tasks = snap.tasks
  const openTask = openTaskId ? tasks.find((t) => t.id === openTaskId) : undefined

  /** Записать вкладку/активный терминал в запись проекта (функционально — безопасно из обработчиков событий). */
  function updateView(projectId: string, patch: Partial<ProjectView>): void {
    if (patch.tab) storeTab(projectId, patch.tab)
    if (patch.globalId !== undefined) storeGlobal(projectId, patch.globalId)
    setViews((prev) => {
      const cur = prev[projectId] ?? storedView(projectId)
      return { ...prev, [projectId]: { ...cur, ...patch } }
    })
  }

  /** Терминалы активного проекта: только их показываем в списке, бейдже и «О проекте». */
  const projectTerminals = terminals.filter((t) => t.projectId === active?.id)
  // Без проекта ключ '' — вкладки («О проекте» со списком агентов) работают, но не сохраняются.
  const viewKey = active?.id ?? ''
  const view: ProjectView = views[viewKey] ?? storedView(viewKey)
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
    void refreshInProgress()
    setSnap(res.active ? await window.orca.board.get() : EMPTY)
    await refreshAgents()
  }

  async function refreshInProgress(): Promise<void> {
    setInProgress(await window.orca.projects.inProgressCounts())
  }

  /** Список агентов (установлен/включён в активном проекте); refresh — заново просканировать PATH. */
  async function refreshAgents(refresh = false): Promise<void> {
    setAgents(await window.orca.agents.list(refresh))
  }

  useEffect(() => {
    window.orca.app.info().then((i) => setSocketPath(i.socketPath))
    void refreshProjects()
    const offBoard = window.orca.board.onChange(({ projectId, snapshot }) => {
      setActive((cur) => {
        if (cur?.id === projectId) setSnap(snapshot)
        return cur
      })
      void refreshInProgress()
    })
    // Источник правды — реестр PTY в main. Подписка раньше list(), чтобы не пропустить изменения между ними.
    const offTerminals = window.orca.terminals.onChanged(syncTerminals)
    window.orca.terminals.list().then((list) => {
      setTails((prev) => {
        const next = { ...prev }
        for (const t of list) if (t.tail) next[t.ptyId] = t.tail
        return next
      })
      syncTerminals(list)
    })
    const offFocus = window.orca.projects.onFocus(async (projectId) => {
      await window.orca.projects.setActive(projectId)
      await refreshProjects()
    })
    // Клик по уведомлению о запросе: проект переключает projects:focus, здесь — открыть Инбокс на запросе.
    const offRequestFocus = window.orca.requests.onFocus(({ requestId }) => {
      setInboxFocus((prev) => ({ requestId, nonce: (prev?.nonce ?? 0) + 1 }))
      setShowInbox(true)
    })
    // ⌘J / Ctrl+J — Инбокс; в фазе захвата, чтобы сработало и из терминала (xterm).
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.code === 'KeyJ') {
        e.preventDefault()
        e.stopPropagation()
        setShowInbox((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      offBoard()
      offTerminals()
      offFocus()
      offRequestFocus()
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])

  // Состояние «жив/завершился» для точки в списке терминалов.
  const ptyKey = terminals.map((t) => t.ptyId).join('\n')
  useEffect(() => {
    const offs = terminals.map((t) =>
      window.orca.pty.onExit(t.ptyId, () => {
        exitedRef.current.add(t.ptyId)
        setExited((prev) => (prev.has(t.ptyId) ? prev : new Set(prev).add(t.ptyId)))
      })
    )
    return () => offs.forEach((off) => off())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyKey])

  // Смена активного проекта (сайдбар или projects:focus): выбор и модалка задачи чужого проекта не остаются.
  useEffect(() => {
    setSelected(undefined)
    setOpenTaskId(null)
    setShowNew(false)
    setGlobalModal(null)
    setLastGlobal(undefined)
  }, [active?.id])

  const runningTaskIds = new Set(terminals.filter((t) => t.taskId && !exited.has(t.ptyId)).map((t) => t.taskId!))

  // ---------- глобальные задачи (docs/nested-kanban.md) ----------
  const columns = active?.columns ?? DEFAULT_COLUMNS
  const kindById = new Map(columns.map((c) => [c.id, c.kind]))
  // Глобальный канбан — Бэклог / В работе / Нужен ответ / Сделано; локальный канбан подзадач — все колонки.
  // «Нужен ответ» вычисляется (подзадачи ждут человека), поэтому в создание и перенос она не попадает.
  const globalColumns = globalBoardColumns(columns)
  const globals: GlobalTask[] = toGlobalTasks(snap.runs, tasks, columns, snap.requests ?? [])
  // Открытая глобальная задача; устаревший id (удалена, другой проект, снимок ещё не пришёл) — общая доска.
  const openGlobal = view.globalId ? globals.find((g) => g.id === view.globalId) : undefined
  const subtasks = openGlobal ? tasks.filter((t) => t.runId === openGlobal.id) : []
  /** Живой координатор глобальной задачи → его PTY (реестр терминалов, runId). */
  const coordinatorPtys = new Map<string, string>()
  for (const t of projectTerminals) {
    if (t.role === 'coordinator' && t.runId && !exited.has(t.ptyId)) coordinatorPtys.set(t.runId, t.ptyId)
  }
  // Что ждёт человека, считается в GlobalTask.waiting (pending-запросы); здесь — только ревью кода.
  const attention = new Map<string, GlobalTaskAttention>()
  for (const t of tasks) {
    if (!t.runId || kindById.get(t.status) !== 'review' || t.answerFor) continue
    attention.set(t.runId, { review: (attention.get(t.runId)?.review ?? 0) + 1 })
  }
  const requests = snap.requests ?? []
  const inboxCount = pendingRequests(snap.requests).length

  /** Открыть Инбокс на запросе (кнопка «Открыть во Входящих» на карточке). */
  function openInboxAt(requestId: string): void {
    setInboxFocus((prev) => ({ requestId, nonce: (prev?.nonce ?? 0) + 1 }))
    setShowInbox(true)
  }

  /** Решить запрос вне Инбокса (карточка, экран глобальной задачи, модалка задачи). Ошибка — на карточке. */
  async function resolveRequest(r: HumanRequest, resolution: RequestResolution): Promise<void> {
    const res = await window.orca.requests.resolve(r.id, resolution)
    if (res.startError) alert(`«${r.title}»: решение принято, но воркер не запустился — ${res.startError}. Координатор получил эскалацию.`)
  }
  const editingGlobal = globalModal?.mode === 'edit' ? globals.find((g) => g.id === globalModal.id) : undefined

  function openGlobalTask(g: GlobalTask): void {
    setSelected(undefined)
    updateView(viewKey, { globalId: g.id })
  }

  function closeGlobalTask(): void {
    if (view.globalId) setLastGlobal(view.globalId)
    setSelected(undefined)
    updateView(viewKey, { globalId: null })
  }

  async function startGlobalCoordinator(g: GlobalTask): Promise<void> {
    if (g.inbox) return
    const projectId = active?.id
    const livePty = coordinatorPtys.get(g.id)
    if (livePty) {
      showTerminal(livePty, projectId)
      return
    }
    const note = g.progress.total
      ? `Координатор продолжит работу, учитывая ${g.progress.total} уже созданных подзадач.`
      : 'Координатор разобьёт описание на подзадачи.'
    if (!confirm(`Запустить координатора на «${g.title}»?\n\n${note}`)) return
    try {
      const ptyId = await window.orca.globalTasks.startCoordinator(g.id, 120, 30)
      showTerminal(ptyId, projectId)
    } catch (e) {
      alert(`Не удалось запустить координатора: ${ipcErrorMessage(e)}`)
    }
  }

  async function removeGlobalTask(g: GlobalTask): Promise<void> {
    const n = g.progress.total
    const text = n
      ? `Удалить глобальную задачу «${g.title}» вместе с подзадачами (${n})?`
      : `Удалить глобальную задачу «${g.title}»?`
    if (!confirm(text)) return
    try {
      await window.orca.globalTasks.remove(g.id, { cascade: n > 0 })
      if (view.globalId === g.id) updateView(viewKey, { globalId: null })
    } catch (e) {
      alert(`Не удалось удалить: ${ipcErrorMessage(e)}`)
    }
  }

  async function saveGlobalTask(input: { title: string; description: string; status?: string }): Promise<void> {
    if (globalModal?.mode === 'edit') {
      const cur = globals.find((g) => g.id === globalModal.id)
      if (!cur) throw new Error('глобальная задача не найдена — возможно, её удалили')
      const patch: { title?: string; description?: string } = {}
      if (input.title !== cur.title) patch.title = input.title
      if (input.description !== cur.description.trim()) patch.description = input.description
      if (patch.title !== undefined || patch.description !== undefined) await window.orca.globalTasks.update(cur.id, patch)
    } else {
      await window.orca.globalTasks.create({
        title: input.title || undefined,
        description: input.description || undefined,
        status: input.status
      })
    }
    setGlobalModal(null)
  }

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
   * Проект берётся из списка терминалов, иначе projectId (терминал только что создан и terminals:changed
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
    const label = 'терминал'
    const ptyId = await window.orca.pty.spawn({ cols: 120, rows: 30, projectId, label })
    // terminals:changed мог прийти раньше ответа spawn — тогда запись уже есть.
    setTerminals((prev) => (prev.some((t) => t.ptyId === ptyId) ? prev : [...prev, { ptyId, label, projectId, role: 'shell' }]))
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
   * Сверить вкладки с реестром main (полный список): новые добавить, пропавшие убрать. Пропавший после
   * pty:exit остаётся с пометкой «завершился», пока его не закроют. Новый терминал вкладку не переключает:
   * при запуске из UI это делает обработчик кнопки (startTask / startCoordinator / openShell), а CLI-запуск
   * не должен выдёргивать пользователя с доски. Активным становится, только если в проекте ничего не выбрано.
   */
  function syncTerminals(list: TerminalInfo[]): void {
    const listed = new Set(list.map((t) => t.ptyId))
    // Закрытый пользователем PTY пропал из реестра — помнить его больше не нужно.
    for (const id of killedRef.current) if (!listed.has(id)) killedRef.current.delete(id)
    const live = list.filter((t) => !killedRef.current.has(t.ptyId))
    const liveIds = new Set(live.map((t) => t.ptyId))
    const keep = (ptyId: string): boolean => liveIds.has(ptyId) || exitedRef.current.has(ptyId)
    setTerminals((prev) => {
      const known = new Set(prev.map((t) => t.ptyId))
      const added = live.filter((t) => !known.has(t.ptyId)).map(toOpenTerminal)
      for (const t of added) {
        if (!t.projectId) continue
        const pid = t.projectId
        setViews((v) => (v[pid]?.activePty ? v : { ...v, [pid]: { ...(v[pid] ?? storedView(pid)), activePty: t.ptyId } }))
      }
      let next = prev
      for (const t of prev) if (!keep(t.ptyId)) next = withoutTerminal(next, t.ptyId)
      return added.length ? [...next, ...added] : next
    })
    setTails((prev) => {
      const gone = Object.keys(prev).filter((id) => !keep(id))
      if (!gone.length) return prev
      const next = { ...prev }
      for (const id of gone) delete next[id]
      return next
    })
  }

  /**
   * Список без терминала; если он был активным в своём проекте — выбрать соседний терминал того же проекта.
   * Вызывается из функциональных апдейтеров: terminals:changed может прийти пачкой до перерисовки,
   * и обычное состояние/ref в обработчике было бы устаревшим.
   */
  function withoutTerminal(prev: OpenTerminal[], ptyId: string): OpenTerminal[] {
    const idx = prev.findIndex((t) => t.ptyId === ptyId)
    if (idx < 0) return prev
    const pid = prev[idx].projectId
    if (pid) {
      const same = prev.filter((t) => t.projectId === pid)
      const pos = same.findIndex((t) => t.ptyId === ptyId)
      const rest = same.filter((t) => t.ptyId !== ptyId)
      const neighbor = (rest[pos] ?? rest[pos - 1])?.ptyId ?? null
      setViews((v) => (v[pid]?.activePty === ptyId ? { ...v, [pid]: { ...v[pid], activePty: neighbor } } : v))
    }
    return prev.filter((t) => t.ptyId !== ptyId)
  }

  /** Убрать терминал, закрытый пользователем, вместе с пометкой «завершился» и хвостом. Повторный вызов — no-op. */
  function dropTerminal(ptyId: string): void {
    setTerminals((prev) => withoutTerminal(prev, ptyId))
    setExited((prev) => {
      if (!prev.has(ptyId)) return prev
      const next = new Set(prev)
      next.delete(ptyId)
      return next
    })
    exitedRef.current.delete(ptyId)
    setTails((prev) => {
      if (!(ptyId in prev)) return prev
      const next = { ...prev }
      delete next[ptyId]
      return next
    })
  }

  function closeTerminal(ptyId: string): void {
    // Убираем сразу: у уже завершившегося PTY kill ничего не изменит и terminals:changed не придёт.
    killedRef.current.add(ptyId)
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
      const global = t.projectId === active?.id && t.runId ? globals.find((g) => g.id === t.runId) : undefined
      return { name: global?.title ?? 'координатор', role: role?.title ?? 'Координатор', agent: role?.agent ?? 'claude' }
    }
    if (t.role === 'assistant') {
      const role = assistantRole(roles)
      return { name: 'ассистент', role: role?.title ?? 'Ассистент', agent: role?.agent ?? 'claude' }
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
        <button
          className={`icon ${showSettings ? 'active' : ''}`}
          title="Настройки"
          onClick={() => setShowSettings(true)}
        >
          <Icon.gear />
        </button>
        <button className={`icon ${showDocs ? 'active' : ''}`} title="Документы" onClick={() => setShowDocs(true)} disabled={!active}>
          <Icon.doc />
        </button>
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
                <div className="name-row">
                  <div className="name">{p.name}</div>
                  {(inProgress[p.id] ?? 0) > 0 && (
                    <span className="tab-badge" title={`Задач в работе: ${inProgress[p.id]}`}>{inProgress[p.id]}</span>
                  )}
                </div>
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
            <button
              className={`inbox-badge ${inboxCount > 0 ? 'has' : ''} ${showInbox ? 'active' : ''}`}
              onClick={() => setShowInbox((v) => !v)}
              disabled={!active}
              title="Запросы, которые ждут вашего ответа (⌘J)"
            >
              Входящие{inboxCount > 0 && <><span className="dot" /> {inboxCount}</>}
            </button>
            <button className="round-btn" title="Открыть новый терминал" onClick={openShell} disabled={!active}><Icon.terminal /></button>
            {/* Создание через координатора доступно вне глобальной задачи; её координатор — в GlobalTaskView.
                Контекст задачи сохраняется и при переходе к терминалам. */}
            {!openGlobal && (
              <button className="btn-primary ghost" onClick={() => setShowCoord(true)} disabled={!active} title="Новая глобальная задача через координатора">
                <Icon.users /> Координатор
              </button>
            )}
            {openGlobal ? (
              <button className="btn-primary" onClick={() => setShowNew(true)} disabled={!active}>
                <Icon.plus /> Новая подзадача
              </button>
            ) : (
              <button className="btn-primary" onClick={() => setGlobalModal({ mode: 'create' })} disabled={!active}>
                <Icon.plus /> Новая задача
              </button>
            )}
          </div>
          <div className="tabs">
            <button
              className={`tab ${tab === 'board' ? 'active' : ''}`}
              onClick={() => (tab === 'board' && openGlobal ? closeGlobalTask() : setTab('board'))}
              title={tab === 'board' && openGlobal ? 'К общей доске' : undefined}
            >
              Канбан
            </button>
            <button className={`tab ${tab === 'terminals' ? 'active' : ''}`} onClick={() => setTab('terminals')}>
              Терминалы
              {projectTerminals.length > 0 && <span className="tab-badge">{projectTerminals.length}</span>}
            </button>
            <button className={`tab ${tab === 'info' ? 'active' : ''}`} onClick={() => setTab('info')}>О проекте</button>
          </div>
        </div>

        <div className="content">
          {tab === 'board' && !openGlobal && (
            <GlobalBoard
              columns={globalColumns}
              globals={globals}
              liveCoordinators={new Set(coordinatorPtys.keys())}
              attention={attention}
              requests={requests}
              tasks={tasks}
              onResolveRequest={resolveRequest}
              onOpenInbox={openInboxAt}
              focusId={lastGlobal}
              onOpen={openGlobalTask}
              onMove={async (id, status) => {
                try {
                  await window.orca.globalTasks.move(id, status)
                } catch (e) {
                  alert(`Не удалось переместить: ${ipcErrorMessage(e)}`)
                }
              }}
              onEdit={(g) => setGlobalModal({ mode: 'edit', id: g.id })}
              onRemove={(g) => void removeGlobalTask(g)}
              onStartCoordinator={(g) => void startGlobalCoordinator(g)}
            />
          )}
          {tab === 'board' && openGlobal && (
            <GlobalTaskView
              global={openGlobal}
              coordinatorPty={coordinatorPtys.get(openGlobal.id)}
              onBack={closeGlobalTask}
              onEdit={() => setGlobalModal({ mode: 'edit', id: openGlobal.id })}
              onStartCoordinator={() => void startGlobalCoordinator(openGlobal)}
              onShowCoordinator={(ptyId) => showTerminal(ptyId)}
              requests={requests}
              tasks={subtasks}
              onResolveRequest={resolveRequest}
              onOpenTask={(taskId) => setOpenTaskId(taskId)}
              onOpenTerminal={openTerminalForTask}
            >
              <Board
                columns={columns}
                roles={active?.roles ?? DEFAULT_ROLES}
                tasks={subtasks}
                emptyText="Нет подзадач"
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
            </GlobalTaskView>
          )}
          {tab === 'info' && !active && <div className="empty">Нет активного проекта — добавьте git-репозиторий.</div>}
          {tab === 'info' && active && (
            <AboutProject
              project={active}
              agents={agents}
              tasks={tasks}
              runs={snap.runs}
              terminals={projectTerminals.length}
              socketPath={socketPath}
              onProjectChanged={refreshProjects}
              onRefreshAgents={() => refreshAgents(true)}
              onRemoveProject={removeProject}
            />
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
                  <Terminal ptyId={t.ptyId} initialTail={tails[t.ptyId]} visible={tab === 'terminals' && t.ptyId === activePty} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>

      {active && (
        <InboxPanel
          key={active.id}
          open={showInbox}
          requests={snap.requests ?? []}
          tasks={tasks}
          runs={snap.runs}
          focus={inboxFocus}
          onClose={() => setShowInbox(false)}
          onOpenTerminal={openTerminalForTask}
        />
      )}
      {showSettings && (
        <SettingsModal agents={agents} onRefreshAgents={() => refreshAgents(true)} onClose={() => setShowSettings(false)} />
      )}
      {showDocs && active && <DocsModal key={active.id} projectName={active.name} tasks={tasks} columns={columns} onClose={() => setShowDocs(false)} />}
      {showCoord && active && (
        <CoordinatorModal
          onClose={() => setShowCoord(false)}
          onStart={async (objective, images) => {
            const projectId = active.id
            const ptyId = await window.orca.coordinator.start(objective, 120, 30, images)
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
          agents={agents}
          dispatches={snap.dispatches}
          questions={snap.questions}
          requests={requests}
          running={runningTaskIds.has(openTask.id)}
          onClose={() => setOpenTaskId(null)}
          onUpdate={(id, patch) => window.orca.tasks.update(id, patch)}
          onStart={startTask}
          onOpenTerminal={openTerminalForTask}
          onRemove={(id) => window.orca.tasks.remove(id)}
          onResolveRequest={resolveRequest}
          onAccept={(id) => window.orca.review.accept(id)}
          onReject={(id, fb) => window.orca.review.reject(id, fb)}
        />
      )}
      {showNew && active && openGlobal && (
        <NewTaskModal
          key={openGlobal.id}
          globalTitle={openGlobal.title}
          tasks={subtasks}
          roles={active?.roles ?? DEFAULT_ROLES}
          agents={agents}
          onClose={() => setShowNew(false)}
          onCreate={async (input) => {
            // Подзадача — только в открытую глобальную: runId ставит main (globalTasks:createTask).
            await window.orca.globalTasks.createTask(openGlobal.id, input)
            setShowNew(false)
          }}
        />
      )}
      {globalModal && active && (globalModal.mode === 'create' || editingGlobal) && (
        <GlobalTaskModal
          key={globalModal.mode === 'edit' ? globalModal.id : 'create'}
          global={editingGlobal}
          columns={globalStoredColumns(columns)}
          onClose={() => setGlobalModal(null)}
          onSave={saveGlobalTask}
        />
      )}
    </div>
  )
}
