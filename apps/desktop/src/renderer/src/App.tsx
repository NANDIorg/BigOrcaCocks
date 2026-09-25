import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_COLUMNS, STORE_FORMAT_VERSION, assistantRole, globalBoardColumns, globalStoredColumns, toGlobalTasks,
  type Task, type StoreSnapshot, type AgentInfo, type Role, type GlobalTask, type HumanRequest, type RequestResolution,
  type TaskPriority
} from '@orca-board/core'
import type { GlobalTaskPatch, Project, ProjectGroup, TaskTypesState, TerminalInfo } from '../../shared/ipc'
import { Board } from './Board'
import { attentionTaskIds, buildAttention } from './attention'
import { revealInFeed } from './feedLink'
import { wfNodeTitles } from './cardState'
import { builtinText, displayColumns, displayRoles } from './defaultTitles'
import { Terminal } from './Terminal'
import { NewTaskModal } from './NewTaskModal'
import { CoordinatorModal } from './CoordinatorModal'
import { TaskModal } from './TaskModal'
import { Icon } from './icons'
import { AgentLogo } from './AgentLogo'
import { ipcErrorMessage } from './useAutoSave'
import { AboutProject } from './about/AboutProject'
import { SettingsModal } from './settings/SettingsModal'
import { UpdateBanner, UpdateToast } from './UpdateBanner'
import { needsAttention } from './updateState'
import { useUpdates } from './useUpdates'
import { useT } from './i18n'
import { DocsModal } from './DocsModal'
import { GlobalBoard, type GlobalTaskAttention } from './GlobalBoard'
import { GlobalTaskView } from './GlobalTaskView'
import { GlobalTaskModal } from './GlobalTaskModal'
import { changeTypeApi } from './globalTypeChange'
import { ReturnGlobalModal } from './ReturnGlobalModal'
import { ProjectTypeModal } from './ProjectTypeModal'
import { OnboardingModal, type OnboardingMode } from './OnboardingModal'
import { loadOnboarding, shouldShowOnboarding } from './onboarding'
import { branchBadge } from './projectBranch'
import { useProjectBranch } from './useProjectBranch'
import { startAddProject, type AddProjectStart } from './projectAdd'
import { ProjectList } from './ProjectList'
import { groupsFromList } from './projectGroups'
import { globalReviewApi, reviewErrorMessage } from './globalReview'
import { runsKnowPriority } from './taskPriority'
import { InboxPanel, pendingRequests } from './InboxPanel'
import { AssistantPanel } from './AssistantPanel'
import { StatsView } from './StatsView'
import type { StatsSnapshot } from './taskStatsFormat'
import { pickAssistant } from './assistantPty'
import { availableTypes, globalTypeTitle, libraryDefaultRoles, loadTaskTypes, projectDefaultTypeId, rolesForRun, workflowForRun } from './taskTypes'

type Tab = 'board' | 'terminals' | 'stats' | 'info'

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

const EMPTY: StoreSnapshot = { formatVersion: STORE_FORMAT_VERSION, tasks: [], dispatches: [], events: [], questions: [], runs: [], requests: [] }

/** Что открыто у проекта: вкладка, выбранный терминал и открытая глобальная задача. У каждого проекта своё. */
interface ProjectView {
  tab: Tab
  activePty: string | null
  /** Открытая глобальная задача (экран её подзадач); null — общая доска. Id может устареть — проверяется по снимку. */
  globalId: string | null
}

const TABS: Tab[] = ['board', 'terminals', 'stats', 'info']
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
  const t = useT()
  const [snap, setSnap] = useState<StoreSnapshot>(EMPTY)
  const [projects, setProjects] = useState<Project[]>([])
  /** Группы проектов в меню; со старым main (`list()` без `groups`) — пусто. */
  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([])
  const [active, setActive] = useState<Project | null>(null)
  const badge = branchBadge(useProjectBranch(active?.id))
  /** Задач в работе по id проекта — бейдж в сайдбаре «Проекты». */
  const [inProgress, setInProgress] = useState<Record<string, number>>({})
  const [socketPath, setSocketPath] = useState('')
  const [selected, setSelected] = useState<Task | undefined>()
  const [terminals, setTerminals] = useState<OpenTerminal[]>([])
  const [showNew, setShowNew] = useState(false)
  /** Модалка глобальной задачи: создание или правка (по id — берётся актуальная из снимка). */
  /** Выбор типа задач по умолчанию для только что выбранной папки (новый main с типами задач). */
  const [addPick, setAddPick] = useState<Extract<AddProjectStart, { kind: 'pick' }> | null>(null)
  const [globalModal, setGlobalModal] = useState<{ mode: 'create' } | { mode: 'edit'; id: string } | null>(null)
  /** Глобальная задача, которую возвращают с «Проверки» в работу (модалка уточнения). */
  const [returnGlobalId, setReturnGlobalId] = useState<string | null>(null)
  /** Глобальная задача, из которой вернулись на общую доску, — её карточке возвращается фокус. */
  const [lastGlobal, setLastGlobal] = useState<string | undefined>()
  const [showCoord, setShowCoord] = useState(false)
  const [showProjects, setShowProjects] = useState(storedShowProjects)
  /** Окно «Настройки» (шестерёнка в rail): общие настройки и дефолт для новых проектов. */
  const [showSettings, setShowSettings] = useState(false)
  /** Мастер первого запуска: `first` — при старте (статус pending), `rerun` — «Пройти заново» из настроек. */
  const [onboarding, setOnboarding] = useState<OnboardingMode | null>(null)
  /** Окно «Документы» (кнопка в rail): .md проекта и задач в работе. */
  const [showDocs, setShowDocs] = useState(false)
  /** Обновление приложения: плашка в сайдбаре, «Настройки → Обновления», тост после старта. */
  const updates = useUpdates()
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
  /** Панель ассистента (⌘K, кнопка в rail). Ассистент один на приложение — при смене проекта тот же PTY. */
  const [showAssistant, setShowAssistant] = useState(false)
  /**
   * PTY ассистента из ответа assistant.open/reset: terminals:changed может прийти позже.
   * После перезагрузки окна null — тогда ассистент находится по роли в списке терминалов (pickAssistant).
   */
  const [launchedAssistant, setLaunchedAssistant] = useState<string | null>(null)
  /**
   * Библиотека типов задач: по типу глобальной задачи берутся роли её подзадач и выбирается тип новой.
   * null — старый main/preload без типов (или ещё не загрузилась): роли проекта, как раньше.
   */
  const [taskTypes, setTaskTypes] = useState<TaskTypesState | null>(null)
  /** Запуск ассистента идёт / сорвался. */
  const [assistantState, setAssistantState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })
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
  // Ассистент приложения (без projectId) виден во вкладке «Терминалы» любого проекта.
  const projectTerminals = terminals.filter((t) => t.projectId === active?.id || (t.role === 'assistant' && !t.projectId))
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

  /** Перечитать библиотеку типов. Сбой (не «старый main») оставляет прежнюю: подписи ролей не прыгают на роли проекта. */
  function refreshTaskTypes(): void {
    loadTaskTypes(window.orca).then(setTaskTypes, () => {})
  }

  async function refreshProjects(): Promise<void> {
    refreshTaskTypes()
    const res = await window.orca.projects.list()
    setProjects(res.projects)
    setProjectGroups(groupsFromList(res))
    setActive(res.active)
    void refreshInProgress()
    setSnap(res.active ? await window.orca.board.get() : EMPTY)
    await refreshAgents()
  }

  /** Только список проектов и групп: после действий с группами доска и агенты не перечитываются. */
  async function reloadProjectList(): Promise<void> {
    const res = await window.orca.projects.list()
    setProjects(res.projects)
    setProjectGroups(groupsFromList(res))
  }

  async function refreshInProgress(): Promise<void> {
    setInProgress(await window.orca.projects.inProgressCounts())
  }

  /** Список агентов (установлен/включён в активном проекте); refresh — заново просканировать PATH. */
  async function refreshAgents(refresh = false): Promise<void> {
    setAgents(await window.orca.agents.list(refresh))
  }

  useEffect(() => {
    // Не показываем мастер при неизвестном состоянии (старый main/preload, сбой чтения) — см. `loadOnboarding`.
    void loadOnboarding(window.orca).then((state) => {
      if (shouldShowOnboarding(state)) setOnboarding((cur) => cur ?? 'first')
    })
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
      setShowAssistant(false)
    })
    // ⌘J / Ctrl+J — Инбокс, ⌘K / Ctrl+K — ассистент; в фазе захвата, чтобы сработало и из терминала (xterm).
    // Панели выезжают на одно место, поэтому открытие одной закрывает другую.
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      if (e.code !== 'KeyJ' && e.code !== 'KeyK') return
      e.preventDefault()
      e.stopPropagation()
      if (e.code === 'KeyJ') {
        setShowInbox((v) => !v)
        setShowAssistant(false)
      } else {
        setShowAssistant((v) => !v)
        setShowInbox(false)
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
    setReturnGlobalId(null)
    setLastGlobal(undefined)
  }, [active?.id])

  const runningTaskIds = new Set(terminals.filter((t) => t.taskId && !exited.has(t.ptyId)).map((t) => t.taskId!))

  // ---------- глобальные задачи (docs/nested-kanban.md) ----------
  // Для показа: встроенные названия колонок — на языке интерфейса (редактор колонок берёт их из проекта как есть).
  const columns = displayColumns(active?.columns ?? DEFAULT_COLUMNS)
  const kindById = new Map(columns.map((c) => [c.id, c.kind]))
  // Глобальный канбан — Бэклог / В работе / Нужен ответ / Проверка / Сделано; локальный канбан подзадач — все колонки.
  // «Нужен ответ» вычисляется (подзадачи ждут человека), поэтому в создание и перенос она не попадает.
  const globalColumns = displayColumns(globalBoardColumns(columns))
  // «Входящие» — служебная задача с встроенным названием из core: показываем на языке интерфейса.
  const globals: GlobalTask[] = toGlobalTasks(snap.runs, tasks, columns, snap.requests ?? []).map((g) => (g.inbox ? { ...g, title: builtinText(g.title) } : g))
  const globalKindById = new Map(globalColumns.map((c) => [c.id, c.kind]))
  // Открытая глобальная задача; устаревший id (удалена, другой проект, снимок ещё не пришёл) — общая доска.
  const openGlobal = view.globalId ? globals.find((g) => g.id === view.globalId) : undefined
  const subtasks = openGlobal ? tasks.filter((t) => t.runId === openGlobal.id) : []
  // Лента «Ждут вас» открытой глобальной задачи. Список один на ленту и на доску: фильтр «Ждут вас» и ссылки
  // «в ленте ↑» на карточках берут те же задачи (`attentionTaskIds`), а не считают состояние заново.
  const feedItems = openGlobal
    ? buildAttention({
        tasks: subtasks, requests: snap.requests ?? [], questions: snap.questions, dispatches: snap.dispatches,
        runId: openGlobal.id, running: runningTaskIds, kindOf: (status) => kindById.get(status)
      })
    : []
  /** Роли задач прогона — по типу его глобальной задачи; нет прогона — тип проекта по умолчанию. */
  const rolesFor = (runId: string | undefined): Role[] => displayRoles(rolesForRun(runId, snap.runs, active, taskTypes))
  const openGlobalRoles = rolesFor(openGlobal?.id)
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
  /** Для «Статистики» задач: ключ перечитывания и запасной расчёт времени при старом main. */
  const statsSnapshot: StatsSnapshot = { tasks, runs: snap.runs, dispatches: snap.dispatches, requests, questions: snap.questions, columns }

  // ---------- ассистент ----------
  /** Терминалы ассистента: по реестру (роль) плюс только что запущенный, которого там ещё нет. */
  const { terminals: assistantTerminals, ptyId: assistantPty } = pickAssistant(
    terminals.map((t) => ({ ptyId: t.ptyId, role: t.role, projectId: t.projectId, tail: tails[t.ptyId] })),
    launchedAssistant,
    killedRef.current,
    active?.id
  )

  /** Запустить (open) или перезапустить (reset) ассистента приложения. */
  async function launchAssistant(reset: boolean): Promise<void> {
    const old = assistantPty
    setAssistantState({ busy: true, error: null })
    try {
      const { ptyId } = reset ? await window.orca.assistant.reset(80, 30) : await window.orca.assistant.open(80, 30)
      // Старый PTY main закрыл сам; из списка его убираем сразу, чтобы не висел «завершившимся».
      if (old && old !== ptyId && reset) {
        killedRef.current.add(old)
        dropTerminal(old)
      }
      setLaunchedAssistant(ptyId)
      setAssistantState({ busy: false, error: null })
    } catch (e) {
      setAssistantState({ busy: false, error: t('shell.app.assistantError', { error: ipcErrorMessage(e) }) })
    }
  }

  // Панель открыта, а ассистента нет или он завершился — запустить (open вернёт живой, если есть).
  // active?.id в зависимостях — для старого main: там у каждого проекта свой ассистент.
  // Ошибка не перезапускает запуск в цикле: повтор — «Новый диалог» или повторное открытие панели.
  const assistantDead = !assistantPty || exited.has(assistantPty)
  useEffect(() => {
    if (!showAssistant || !assistantDead || assistantState.busy || assistantState.error) return
    void launchAssistant(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAssistant, active?.id, assistantDead])

  // Закрыли панель — ошибка запуска сбрасывается, чтобы следующее открытие попробовало снова.
  useEffect(() => {
    if (!showAssistant) setAssistantState((prev) => (prev.error ? { busy: false, error: null } : prev))
  }, [showAssistant])

  const inboxCount = pendingRequests(snap.requests).length

  const closeAssistant = useCallback(() => setShowAssistant(false), [])

  /** Открыть Инбокс на запросе (кнопка «Открыть во Входящих» на карточке). */
  function openInboxAt(requestId: string): void {
    setInboxFocus((prev) => ({ requestId, nonce: (prev?.nonce ?? 0) + 1 }))
    setShowInbox(true)
    setShowAssistant(false)
  }

  /** Решить запрос вне Инбокса (карточка, экран глобальной задачи, модалка задачи). Ошибка — на карточке. */
  async function resolveRequest(r: HumanRequest, resolution: RequestResolution): Promise<void> {
    const res = await window.orca.requests.resolve(r.id, resolution)
    if (res.startError) alert(t('shell.app.startError', { title: r.title, error: res.startError }))
  }
  const returningGlobal = returnGlobalId ? globals.find((g) => g.id === returnGlobalId) : undefined
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
      ? t('shell.app.coordinatorContinue', { count: g.progress.total })
      : t('shell.app.coordinatorSplit')
    if (!confirm(t('shell.app.confirmCoordinator', { title: g.title, note }))) return
    try {
      const ptyId = await window.orca.globalTasks.startCoordinator(g.id, 120, 30)
      showTerminal(ptyId, projectId)
    } catch (e) {
      alert(t('shell.app.coordinatorError', { error: ipcErrorMessage(e) }))
    }
  }

  /** «Подтвердить» на «Проверке»: результат принят, задача — в «Сделано». */
  async function acceptGlobalTask(g: GlobalTask): Promise<void> {
    try {
      await globalReviewApi(window.orca).accept(g.id)
    } catch (e) {
      alert(t('shell.app.acceptError', { error: reviewErrorMessage(e) }))
    }
  }

  /**
   * «Вернуть в работу» с уточнением: main переводит задачу в работу и запускает координатора — открываем
   * его терминал, как startGlobalCoordinator. Старый preload — ошибка остаётся в модалке.
   */
  async function returnGlobalTask(id: string, text: string): Promise<void> {
    const projectId = active?.id
    const api = globalReviewApi(window.orca)
    try {
      const ptyId = await api.returnToWork(id, text, 120, 30)
      setReturnGlobalId(null)
      showTerminal(ptyId, projectId)
    } catch (e) {
      const message = reviewErrorMessage(e)
      // Задача могла уже уйти в работу, а упал запуск координатора: уточнение сохранено в ней, повторный
      // возврат не пройдёт — закрываем модалку, «Запустить координатора» подхватит уточнение.
      setReturnGlobalId(null)
      alert(t('shell.app.returnError', { error: message }))
    }
  }

  /** Перенос глобальной задачи в колонку: с общей доски (перетаскивание) и из степпера шапки. */
  async function moveGlobalTask(id: string, status: string): Promise<void> {
    try {
      await window.orca.globalTasks.move(id, status)
    } catch (e) {
      alert(t('shell.app.moveError', { error: ipcErrorMessage(e) }))
    }
  }

  async function removeGlobalTask(g: GlobalTask): Promise<void> {
    const n = g.progress.total
    const text = n
      ? t('shell.app.confirmRemoveCascade', { title: g.title, count: n })
      : t('shell.app.confirmRemove', { title: g.title })
    if (!confirm(text)) return
    try {
      await window.orca.globalTasks.remove(g.id, { cascade: n > 0 })
      if (view.globalId === g.id) updateView(viewKey, { globalId: null })
    } catch (e) {
      alert(t('shell.app.removeError', { error: ipcErrorMessage(e) }))
    }
  }

  async function saveGlobalTask(input: { title: string; description: string; status?: string; priority?: TaskPriority; typeId?: string }): Promise<void> {
    if (globalModal?.mode === 'edit') {
      const cur = globals.find((g) => g.id === globalModal.id)
      if (!cur) throw new Error(t('shell.app.globalNotFound'))
      const patch: GlobalTaskPatch = {}
      if (input.title !== cur.title) patch.title = input.title
      if (input.description !== cur.description.trim()) patch.description = input.description
      if (input.priority !== undefined && input.priority !== cur.priority) patch.priority = input.priority
      if (Object.keys(patch).length > 0) await window.orca.globalTasks.update(cur.id, patch)
      // Тип модалка присылает, только пока его можно сменить; неизменённый не трогаем.
      if (input.typeId !== undefined && input.typeId !== cur.typeId) await changeTypeApi(window.orca)(cur.id, input.typeId)
    } else {
      await window.orca.globalTasks.create({
        title: input.title || undefined,
        description: input.description || undefined,
        status: input.status,
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.typeId !== undefined ? { typeId: input.typeId } : {})
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

  /**
   * «Добавить репозиторий»: папка → подсказка типа → модалка «Тип задач по умолчанию». Уже добавленный
   * репозиторий открывается без модалки; со старым main/preload — прежний `projects.add()` без выбора.
   */
  async function addProject(): Promise<void> {
    const start = await startAddProject(window.orca, projects)
    if (start.kind === 'pick') return setAddPick(start)
    if (start.kind === 'cancel') return
    const p = start.kind === 'legacy' ? await window.orca.projects.add() : await window.orca.projects.add(undefined, start.path)
    if (p) await refreshProjects()
  }

  async function addProjectWithType(path: string, typeId: string): Promise<void> {
    const p = await window.orca.projects.add(typeId, path)
    setAddPick(null)
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
    const label = t('shell.term.shellLabel')
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
  function describeTerminal(term: OpenTerminal): { name: string; role: string; agent: string } {
    const project = projects.find((p) => p.id === term.projectId)
    const isActive = project !== undefined && project.id === active?.id
    // Роли — по типу прогона терминала; прогоны есть только у активного проекта, у чужого — тип по умолчанию.
    const rolesOf = (runId: string | undefined): Role[] =>
      isActive ? rolesFor(runId) : displayRoles(rolesForRun(undefined, [], project, taskTypes))
    if (term.role === 'coordinator') {
      const role = rolesOf(term.runId).find((r) => r.id === 'coordinator')
      const global = term.projectId === active?.id && term.runId ? globals.find((g) => g.id === term.runId) : undefined
      return { name: global?.title ?? t('shell.term.coordinatorName'), role: role?.title ?? t('shell.term.coordinatorRole'), agent: role?.agent ?? 'claude' }
    }
    if (term.role === 'assistant') {
      // Ассистент приложения запущен с ролями типа библиотеки по умолчанию; у старого main — проекта.
      const role = assistantRole(taskTypes && !term.projectId ? libraryDefaultRoles(taskTypes) : rolesOf(undefined))
      return { name: t('shell.term.assistantName'), role: role?.title ?? t('shell.term.assistantRole'), agent: role?.agent ?? 'claude' }
    }
    if (term.role === 'shell') return { name: term.label, role: t('shell.term.shellRole'), agent: 'shell' }
    const task = term.projectId === active?.id ? tasks.find((x) => x.id === term.taskId) : undefined
    const role = task && rolesFor(task.runId).find((r) => r.id === task.roleId)
    return { name: task?.title ?? term.label, role: role?.title ?? task?.roleId ?? t('shell.term.workerRole'), agent: task?.agent ?? 'shell' }
  }

  return (
    <div className={`app ${showProjects ? '' : 'no-sidebar'}`}>
      <aside className="rail">
        <button className={`icon ${showProjects ? 'active' : ''}`} title={t('shell.rail.projects')} onClick={toggleProjects}><Icon.folder /></button>
        <button
          className={`icon ${showSettings ? 'active' : ''}`}
          title={!showProjects && needsAttention(updates.state) ? t('shell.update.railHint') : t('shell.rail.settings')}
          onClick={() => setShowSettings(true)}
        >
          <Icon.gear />
          {/* Сайдбар скрыт — плашки обновления не видно, поэтому точка на шестерёнке. */}
          {!showProjects && needsAttention(updates.state) && <span className="rail-dot" />}
        </button>
        <button className={`icon ${showDocs ? 'active' : ''}`} title={t('shell.rail.docs')} onClick={() => setShowDocs(true)} disabled={!active}>
          <Icon.doc />
        </button>
        <button
          className={`icon ${showAssistant ? 'active' : ''}`}
          title={t('shell.rail.assistant')}
          onClick={() => {
            setShowAssistant((v) => !v)
            setShowInbox(false)
          }}
          disabled={!active}
        >
          <Icon.assistant />
        </button>
        <div className="grow" />
        <div className="avatar">🐋</div>
      </aside>

      {showProjects && (
        <aside className="sidebar">
          <ProjectList
            projects={projects}
            groups={projectGroups}
            inProgress={inProgress}
            activeId={active?.id}
            onSwitch={(p) => void switchProject(p)}
            onAdd={() => void addProject()}
            onReload={reloadProjectList}
            onGroupsChange={setProjectGroups}
          />
          <UpdateBanner updates={updates} />
        </aside>
      )}

      <main className="main">
        <div className="main-head">
          <div className="row">
            <div className="head-title">
              <h1>{active?.name ?? 'orca-board'}</h1>
              {badge && (
                <span className={`branch-badge ${badge.detached ? 'detached' : ''}`} title={badge.title}>
                  <Icon.branch />
                  <span className="branch-name">{badge.label}</span>
                  {badge.mark && <span className="branch-mark">{badge.mark}</span>}
                </span>
              )}
            </div>
            <button
              className={`inbox-badge ${inboxCount > 0 ? 'has' : ''} ${showInbox ? 'active' : ''}`}
              onClick={() => {
                setShowInbox((v) => !v)
                setShowAssistant(false)
              }}
              disabled={!active}
              title={t('shell.head.inboxHint')}
            >
              {t('shell.head.inbox')}{inboxCount > 0 && <><span className="dot" /> {inboxCount}</>}
            </button>
            <button className="round-btn" title={t('shell.head.newShell')} onClick={openShell} disabled={!active}><Icon.terminal /></button>
            {/* Создание через координатора доступно вне глобальной задачи; её координатор — в GlobalTaskView.
                Контекст задачи сохраняется и при переходе к терминалам. */}
            {!openGlobal && (
              <button className="btn-primary ghost" onClick={() => setShowCoord(true)} disabled={!active} title={t('shell.head.coordinatorHint')}>
                <Icon.users /> {t('shell.head.coordinator')}
              </button>
            )}
            {openGlobal ? (
              <button className="btn-primary" onClick={() => setShowNew(true)} disabled={!active}>
                <Icon.plus /> {t('shell.head.newSubtask')}
              </button>
            ) : (
              <button className="btn-primary" onClick={() => setGlobalModal({ mode: 'create' })} disabled={!active}>
                <Icon.plus /> {t('shell.head.newTask')}
              </button>
            )}
          </div>
          <div className="tabs">
            <button
              className={`tab ${tab === 'board' ? 'active' : ''}`}
              onClick={() => (tab === 'board' && openGlobal ? closeGlobalTask() : setTab('board'))}
              title={tab === 'board' && openGlobal ? t('shell.tab.boardBack') : undefined}
            >
              {t('shell.tab.board')}
            </button>
            <button className={`tab ${tab === 'terminals' ? 'active' : ''}`} onClick={() => setTab('terminals')}>
              {t('shell.tab.terminals')}
              {projectTerminals.length > 0 && <span className="tab-badge">{projectTerminals.length}</span>}
            </button>
            <button className={`tab ${tab === 'stats' ? 'active' : ''}`} onClick={() => setTab('stats')}>{t('shell.tab.stats')}</button>
            <button className={`tab ${tab === 'info' ? 'active' : ''}`} onClick={() => setTab('info')}>{t('shell.tab.info')}</button>
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
              onMove={(id, status) => moveGlobalTask(id, status)}
              onEdit={(g) => setGlobalModal({ mode: 'edit', id: g.id })}
              onRemove={(g) => void removeGlobalTask(g)}
              onStartCoordinator={(g) => void startGlobalCoordinator(g)}
              onAccept={(g) => void acceptGlobalTask(g)}
              onReturn={(g) => setReturnGlobalId(g.id)}
              typeTitle={(g) => globalTypeTitle(g, taskTypes)}
            />
          )}
          {tab === 'board' && openGlobal && (
            <GlobalTaskView
              projectId={active?.id ?? ''}
              statsSnapshot={statsSnapshot}
              global={openGlobal}
              statusKind={globalKindById.get(openGlobal.status)}
              coordinatorPty={coordinatorPtys.get(openGlobal.id)}
              coordinatorSessions={snap.runs.find((r) => r.id === openGlobal.id)?.coordinatorSessions}
              globalColumns={globalColumns}
              onBack={closeGlobalTask}
              onEdit={() => setGlobalModal({ mode: 'edit', id: openGlobal.id })}
              onMove={(status) => void moveGlobalTask(openGlobal.id, status)}
              onStopCoordinator={closeTerminal}
              onRemove={() => void removeGlobalTask(openGlobal)}
              onStartCoordinator={() => void startGlobalCoordinator(openGlobal)}
              onShowCoordinator={(ptyId) => showTerminal(ptyId)}
              onAccept={() => void acceptGlobalTask(openGlobal)}
              onReturn={() => setReturnGlobalId(openGlobal.id)}
              attention={feedItems}
              tasks={subtasks}
              columns={columns}
              dispatches={snap.dispatches}
              onResolveRequest={resolveRequest}
              onOpenTask={(taskId) => setOpenTaskId(taskId)}
              onOpenTerminal={openTerminalForTask}
              onAnswerQuestion={(qid, a) => window.orca.questions.answer(qid, a)}
              onAcceptTask={(id) => window.orca.review.accept(id)}
              onRejectTask={(id, fb) => window.orca.review.reject(id, fb)}
              onStartTask={startTask}
              typeTitle={globalTypeTitle(openGlobal, taskTypes)}
            >
              <Board
                columns={columns}
                roles={openGlobalRoles}
                stageTitles={wfNodeTitles(workflowForRun(openGlobal.id, snap.runs, active, taskTypes))}
                tasks={subtasks}
                emptyText={t('shell.noSubtasks')}
                questions={snap.questions}
                dispatches={snap.dispatches}
                selectedId={selected?.id}
                runningTaskIds={runningTaskIds}
                waitingTaskIds={attentionTaskIds(feedItems)}
                onRevealInFeed={revealInFeed}
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
          {tab === 'stats' && !active && <div className="empty">{t('shell.projects.none')}</div>}
          {tab === 'stats' && active && <StatsView key={active.id} projectId={active.id} columns={columns} />}
          {tab === 'info' && !active && <div className="empty">{t('shell.projects.none')}</div>}
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
              {projectTerminals.length === 0 && <div className="empty">{t('shell.term.none')}</div>}
              {projectTerminals.map((term) => {
                const info = describeTerminal(term)
                const alive = !exited.has(term.ptyId)
                const project = projects.find((p) => p.id === term.projectId)
                return (
                  <div
                    key={term.ptyId}
                    className={`term-item ${term.ptyId === activePty ? 'active' : ''}`}
                    onClick={() => setActivePty(term.ptyId)}
                    title={[info.name, info.role, project?.name].filter(Boolean).join(' · ')}
                  >
                    <span className={`dot ${alive ? 'alive' : 'dead'}`} title={alive ? t('shell.term.alive') : t('shell.term.exited')} />
                    <AgentLogo agent={info.agent} size={16} />
                    <span className="who">
                      <span className="name">{info.name}</span>
                      <span className="role">{info.role}</span>
                    </span>
                    <button
                      className="x"
                      title={t('shell.term.close')}
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTerminal(term.ptyId)
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
                <div className="empty">{t('shell.term.emptyHint')}</div>
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
          dispatches={snap.dispatches}
          workflowOf={(runId) => workflowForRun(runId, snap.runs, active, taskTypes)}
          focus={inboxFocus}
          onClose={() => setShowInbox(false)}
          onOpenTerminal={openTerminalForTask}
        />
      )}
      {active && (
        <AssistantPanel
          open={showAssistant}
          terminals={assistantTerminals}
          activePty={assistantPty}
          status={assistantState}
          onClose={closeAssistant}
          onReset={() => void launchAssistant(true)}
          onOpenInTerminals={() => {
            if (!assistantPty) return
            setShowAssistant(false)
            showTerminal(assistantPty, active.id)
          }}
        />
      )}
      {showSettings && (
        <SettingsModal
          agents={agents}
          updates={updates}
          onRefreshAgents={() => refreshAgents(true)}
          onProjectsChanged={refreshProjects}
          onRunOnboarding={() => {
            setShowSettings(false)
            refreshTaskTypes()
            setOnboarding('rerun')
          }}
          onClose={() => {
            setShowSettings(false)
            refreshTaskTypes()
          }}
        />
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
          projectId={active.id}
          statsSnapshot={statsSnapshot}
          task={openTask}
          tasks={tasks}
          columns={columns}
          roles={rolesFor(openTask.runId)}
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
          roles={openGlobalRoles}
          agents={agents}
          onClose={() => setShowNew(false)}
          onCreate={async (input) => {
            // Подзадача — только в открытую глобальную: runId ставит main (globalTasks:createTask).
            await window.orca.globalTasks.createTask(openGlobal.id, input)
            setShowNew(false)
          }}
        />
      )}
      {/* До ProjectTypeModal: выбор типа проекта из шага «Первый проект» открывается поверх мастера. */}
      {onboarding && (
        <OnboardingModal
          mode={onboarding}
          projects={projects}
          onAddProject={addProject}
          suspended={!!addPick}
          onClose={() => setOnboarding(null)}
        />
      )}
      {addPick && (
        <ProjectTypeModal
          key={addPick.detection.path}
          detection={addPick.detection}
          types={addPick.types}
          defaultTypeId={addPick.defaultTypeId}
          selected={addPick.selected}
          onClose={() => setAddPick(null)}
          onSubmit={(typeId) => addProjectWithType(addPick.detection.path, typeId)}
        />
      )}
      {globalModal && active && (globalModal.mode === 'create' || editingGlobal) && (
        <GlobalTaskModal
          key={globalModal.mode === 'edit' ? globalModal.id : 'create'}
          global={editingGlobal}
          columns={globalStoredColumns(columns)}
          types={taskTypes ? availableTypes(active, taskTypes) : undefined}
          defaultTypeId={taskTypes ? projectDefaultTypeId(active, taskTypes) : undefined}
          agents={agents}
          typeTitle={editingGlobal ? globalTypeTitle(editingGlobal, taskTypes) : undefined}
          priorityEditable={runsKnowPriority(snap.runs)}
          statusKind={editingGlobal ? globalKindById.get(editingGlobal.status) : undefined}
          live={editingGlobal ? coordinatorPtys.has(editingGlobal.id) : false}
          onAccept={editingGlobal ? () => { setGlobalModal(null); void acceptGlobalTask(editingGlobal) } : undefined}
          onReturn={editingGlobal ? () => { setGlobalModal(null); setReturnGlobalId(editingGlobal.id) } : undefined}
          onClose={() => setGlobalModal(null)}
          onSave={saveGlobalTask}
        />
      )}
      {returningGlobal && (
        <ReturnGlobalModal
          key={returningGlobal.id}
          global={returningGlobal}
          closesCoordinator={coordinatorPtys.has(returningGlobal.id)}
          onClose={() => setReturnGlobalId(null)}
          onSubmit={(text) => returnGlobalTask(returningGlobal.id, text)}
        />
      )}
      <UpdateToast />
    </div>
  )
}
