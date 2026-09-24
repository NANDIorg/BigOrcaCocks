import { AGENT_TITLES, type AgentSession, type BoardColumn, type ColumnKind } from '@orca-board/core'
import { formatDuration } from './duration'
import { globalTaskActions } from './globalReview'

/** Вкладки экрана глобальной задачи (`GlobalTaskView`), в порядке показа: номер вкладки = клавиша 1–5. */
export type GlobalTabId = 'board' | 'overview' | 'coordinator' | 'history' | 'stats'

export const GLOBAL_TAB_IDS: readonly GlobalTabId[] = ['board', 'overview', 'coordinator', 'history', 'stats']

export function isGlobalTabId(value: unknown): value is GlobalTabId {
  return typeof value === 'string' && (GLOBAL_TAB_IDS as readonly string[]).includes(value)
}

/** «Проверка» и «Сделано»: работа закончена, человеку нужен итог, а не доска. */
function isFinished(kind: ColumnKind | undefined): boolean {
  return kind === 'review' || kind === 'done'
}

/**
 * Вкладка по умолчанию по состоянию. Черновик (бэклог, «Готово к запуску») — «Цель и детали»: доска пуста,
 * подсказывать надо, что делать. Работа и «Нужен ответ» — доска. «Проверка» и «Сделано» — «Итог и цель»: сводка
 * видна целиком и не пропадает после «Подтвердить». Колонка неизвестна (пользовательская, старый main) — доска.
 */
export function defaultTab(kind: ColumnKind | undefined): GlobalTabId {
  if (kind === 'backlog' || kind === 'ready' || isFinished(kind)) return 'overview'
  return 'board'
}

/** Заголовок вкладки: «Итог и цель» там, где есть итог, иначе «Цель и детали». */
export function tabTitle(id: GlobalTabId, kind: ColumnKind | undefined): string {
  switch (id) {
    case 'board': return 'Доска'
    case 'overview': return isFinished(kind) ? 'Итог и цель' : 'Цель и детали'
    case 'coordinator': return 'Координатор'
    case 'history': return 'История'
    case 'stats': return 'Статистика'
  }
}

/**
 * Какие вкладки показывать. «Входящие» — не задача, а корзина подзадач без глобальной: ни цели, ни координатора,
 * ни итога, — у них одна доска и вкладок нет.
 */
export function visibleTabs(g: { inbox?: boolean }): GlobalTabId[] {
  return g.inbox ? ['board'] : [...GLOBAL_TAB_IDS]
}

/** Выбор человека: вкладка и то, какой была вкладка по умолчанию в тот момент. */
export interface TabChoice {
  tab: GlobalTabId
  base: GlobalTabId
}

/**
 * Вкладка при открытии задачи. Выбор человека действует, пока вкладка по умолчанию та же, что была при выборе:
 * выбрал «Историю» в работе — она и останется на «Нужен ответ» (там тоже доска), но когда задача ушла на «Проверку»,
 * выбор устарел и показывается итог. Иначе «запомнили доску» навсегда прятало бы сводку. Вкладки нет среди
 * видимых (например, «Входящие») — по умолчанию.
 */
export function resolveTab(choice: TabChoice | undefined, kind: ColumnKind | undefined, visible: readonly GlobalTabId[]): GlobalTabId {
  const base = defaultTab(kind)
  const wanted = choice && choice.base === base ? choice.tab : base
  return visible.includes(wanted) ? wanted : (visible[0] ?? 'board')
}

/** Минимум от Storage — чтобы тестировать без окна. */
export interface TabStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const STORAGE_PREFIX = 'orca.gtab.'

/** Прочитать запомненный выбор; битое значение и недоступное хранилище — «не выбирал». */
export function readTabChoice(storage: TabStorage | undefined, globalId: string): TabChoice | undefined {
  try {
    const raw = storage?.getItem(STORAGE_PREFIX + globalId)
    if (!raw) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { tab, base } = parsed as { tab?: unknown; base?: unknown }
    return isGlobalTabId(tab) && isGlobalTabId(base) ? { tab, base } : undefined
  } catch {
    return undefined
  }
}

/** Запомнить выбор человека по id задачи; хранилище недоступно — выбор просто не переживёт перезапуск. */
export function writeTabChoice(storage: TabStorage | undefined, globalId: string, choice: TabChoice): void {
  try {
    storage?.setItem(STORAGE_PREFIX + globalId, JSON.stringify(choice))
  } catch {
    // хранилище недоступно
  }
}

/** Пункт подсказки «Перед запуском» в черновике. `ok` — уже готово, иначе «ещё впереди/нужно». */
export interface LaunchCheck {
  ok: boolean
  text: string
}

/**
 * Что проверить перед запуском координатора. Подзадач в черновике обычно ещё нет — их создаёт координатор,
 * это не упрёк, а ожидание, поэтому пункт «не готово» нейтральный.
 */
export function launchChecklist(g: { description: string; title: string; progress: { total: number } }, typeTitle: string | undefined): LaunchCheck[] {
  const goal = g.description.trim()
  return [
    typeTitle
      ? { ok: true, text: `Тип «${typeTitle}» — роли и воркфлоу заданы` }
      : { ok: false, text: 'Тип не выбран — возьмётся тип проекта по умолчанию' },
    goal !== '' && goal !== g.title.trim()
      ? { ok: true, text: 'Цель описана' }
      : { ok: false, text: 'Цель — только название: опишите, что должно получиться («Изменить»)' },
    g.progress.total > 0
      ? { ok: true, text: `Подзадач уже ${g.progress.total} — координатор продолжит с них` }
      : { ok: false, text: 'Подзадачи — их создаст координатор' }
  ]
}

/**
 * Показывать ли на вкладке «Итог и цель» блок сводки: на «Проверке» и в «Сделано». Кнопки решения под ним —
 * только на «Проверке» (`GlobalTaskActions.accept`), в «Сделано» решать уже нечего.
 */
export function showsSummary(kind: ColumnKind | undefined, inbox?: boolean): boolean {
  return !inbox && isFinished(kind)
}

/** Показывать ли подсказку и кнопку запуска черновика. */
export function showsLaunchHint(kind: ColumnKind | undefined, inbox?: boolean): boolean {
  return !inbox && (kind === 'backlog' || kind === 'ready')
}

/** Индекс вкладки по нажатой цифре (0-based среди видимых) или `undefined`, если такой вкладки нет. */
export function tabAt(visible: readonly GlobalTabId[], index: number): GlobalTabId | undefined {
  return visible[index]
}

/** Соседняя вкладка стрелками ←/→ (по кругу), Home/End — крайние. */
export function stepTab(visible: readonly GlobalTabId[], current: GlobalTabId, key: string): GlobalTabId | undefined {
  const i = visible.indexOf(current)
  if (i < 0 || visible.length === 0) return undefined
  if (key === 'ArrowRight') return visible[(i + 1) % visible.length]
  if (key === 'ArrowLeft') return visible[(i - 1 + visible.length) % visible.length]
  if (key === 'Home') return visible[0]
  if (key === 'End') return visible[visible.length - 1]
  return undefined
}

// ---------- шапка: степпер статуса, главное действие, пилюля координатора ----------

/** Шаг степпера статуса: колонка глобального канбана (`globalBoardColumns`) и её положение относительно текущей. */
export interface StatusStep {
  id: string
  title: string
  kind: ColumnKind
  /** Цвет колонки (hex) — им подсвечивается текущий шаг. */
  color: string
  /** `past` — левее текущей, `now` — текущая, `next` — правее. Текущая неизвестна (старый main) — все `next`. */
  state: 'past' | 'now' | 'next'
  /**
   * Клик переносит задачу сюда (`globalTasks.move`). «Нужен ответ» вычисляется по запросам человеку, а не хранится,
   * поэтому в неё не переносят — как и на общей доске, куда её колонку не берут целью перетаскивания.
   */
  movable: boolean
}

/**
 * Шаги степпера: колонки глобального канбана в порядке проекта, как на общей доске. `columns` — уже
 * `globalBoardColumns(...)`; `status` — `GlobalTask.status` (для карточки в «Нужен ответ» это id её колонки).
 */
export function statusSteps(columns: readonly Pick<BoardColumn, 'id' | 'title' | 'kind' | 'color'>[], status: string): StatusStep[] {
  const current = columns.findIndex((c) => c.id === status)
  return columns.map((c, i) => ({
    id: c.id,
    title: c.title,
    kind: c.kind,
    color: c.color,
    state: current < 0 ? 'next' : i < current ? 'past' : i === current ? 'now' : 'next',
    movable: i !== current && c.kind !== 'needs_input'
  }))
}

/** Текущий шаг степпера — для чипа «Проверка ▾» в узком окне. */
export function currentStep(steps: readonly StatusStep[]): StatusStep | undefined {
  return steps.find((s) => s.state === 'now')
}

/** Главное действие шапки: акцентная кнопка, одна на состояние. */
export type HeaderPrimary =
  | { kind: 'start'; label: string }
  /** «Ответить · N (G)»: N — пункты ленты «Ждут вас»; клик переводит фокус в ленту (как клавиша G). */
  | { kind: 'answer'; label: string; count: number }
  | { kind: 'accept'; label: string }

export interface HeaderActions {
  primary?: HeaderPrimary
  /** «Вернуть в работу…» рядом с «Подтвердить» (только «Проверка»). */
  returnToWork: boolean
  /** Запуск координатора без акцента: «Сделано» — решать нечего, но запуск и раньше был доступен. */
  quietStart: boolean
}

/**
 * Что показать в шапке. «Проверка» — «Подтвердить» + «Вернуть в работу…». «Нужен ответ» — «Ответить · N», N берётся
 * из ленты «Ждут вас» (`attentionCount`), а нет её — из `GlobalTask.waiting`; нечего отвечать (запрос успели
 * закрыть) — как обычное состояние. Координатор не запущен — «Запустить координатора»; живой координатор работает сам,
 * поэтому кнопки нет — он в пилюле меты. Условия «можно ли» — `globalTaskActions`, чтобы шапка и доска не расходились.
 */
export function headerActions(
  g: { inbox?: boolean; waiting?: number },
  kind: ColumnKind | undefined,
  live: boolean,
  attentionCount?: number
): HeaderActions {
  const actions = globalTaskActions(g, kind, live)
  if (actions.accept) return { primary: { kind: 'accept', label: 'Подтвердить' }, returnToWork: actions.returnToWork, quietStart: false }
  const waiting = attentionCount ?? g.waiting ?? 0
  if (!g.inbox && kind === 'needs_input' && waiting > 0) {
    return { primary: { kind: 'answer', label: `Ответить · ${waiting}`, count: waiting }, returnToWork: false, quietStart: actions.startCoordinator }
  }
  if (actions.startCoordinator) {
    return kind === 'done'
      ? { returnToWork: false, quietStart: true }
      : { primary: { kind: 'start', label: 'Запустить координатора' }, returnToWork: false, quietStart: false }
  }
  return { returnToWork: false, quietStart: false }
}

/** Состояние координатора для пилюли меты. */
export type CoordinatorState = 'working' | 'waiting' | 'finished' | 'idle'

export interface CoordinatorPillInfo {
  state: CoordinatorState
  /** «Координатор работает» / «ждёт вас» / «завершил» / «не запущен». */
  title: string
  /** Уточнения после заголовка, по порядку: модель, «N-й запуск», время. Что неизвестно — пропущено. */
  parts: string[]
  /** Есть живой терминал: можно «Терминал →» и «Остановить». */
  live: boolean
}

export interface CoordinatorPillInput {
  live: boolean
  /** Ждёт человека: карточка в «Нужен ответ». */
  waiting: boolean
  /** `Run.coordinatorSessions`; со старым main поля нет. */
  sessions?: readonly AgentSession[]
  /** Агент последнего запуска (`GlobalTask.coordinatorAgent`) — если запусков не прислали. */
  agent?: AgentSession['agent']
  /** Живой терминал (`coordinatorPty`): по нему находится текущий запуск среди `sessions`. */
  ptyId?: string
}

/**
 * Пилюля координатора: «● Координатор работает · Claude Opus · 2-й запуск · 1 ч 12 мин». Запуск текущий — с ptyId
 * живого терминала, иначе последний. Живой — время идёт с его начала; завершённый — сколько он работал.
 * Запусков нет и координатор не жив — «не запущен» без подробностей (в «Сделано» без сессий — тоже: они неизвестны).
 */
export function coordinatorPill(input: CoordinatorPillInput, now: number): CoordinatorPillInfo {
  const { live, waiting, sessions, agent, ptyId } = input
  const list = sessions ?? []
  const last = list.length > 0 ? list[list.length - 1] : undefined
  const session = (live && ptyId ? list.find((s) => s.ptyId === ptyId) : undefined) ?? last
  const model = session?.model ?? (session ? AGENT_TITLES[session.agent] : agent ? AGENT_TITLES[agent] : undefined)
  const parts: string[] = []
  if (model) parts.push(model)
  if (list.length > 0 && session) parts.push(`${list.indexOf(session) + 1}-й запуск`)
  if (session) {
    const end = live ? now : session.endedAt
    if (end !== undefined && end >= session.startedAt) parts.push(formatDuration(end - session.startedAt))
  }
  if (live) return { state: waiting ? 'waiting' : 'working', title: waiting ? 'Координатор ждёт вас' : 'Координатор работает', parts, live }
  if (session) return { state: 'finished', title: 'Координатор завершил', parts, live }
  return { state: 'idle', title: 'Координатор не запущен', parts: [], live }
}
