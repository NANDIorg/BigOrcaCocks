import type { AgentKind } from './agents'
import type { WfStage, Workflow } from './workflow'
import type { TaskTypeSnapshot } from './task-types'
export type { AgentKind }

// ---------- роли ----------

/** Роль проекта: кто выполняет задачу (агент + модель). */
export interface Role {
  id: string
  title: string
  /**
   * Назначение роли: чем она занимается и когда её брать. Координатор видит его в `orca-board roles list`
   * и по нему выбирает `--role` для задач. Пусто — поля нет, координатор выбирает по id и названию.
   */
  description?: string
  agent: AgentKind
  /** Модель агента; пусто — по умолчанию. */
  model?: string
  /** Уровень рассуждений агента (см. effortOptions); пусто — по умолчанию. */
  effort?: string
  /**
   * Системный промпт роли: инструкции пользователя, которые дописываются к служебной инструкции Orca
   * (skills/worker.md или coordinator.md) при каждом запуске агента этой роли. Пусто — поля нет, поведение прежнее.
   */
  systemPrompt?: string
}

export const DEFAULT_ROLES: Role[] = [
  {
    id: 'coordinator', title: 'Координатор', agent: 'claude',
    description: 'Декомпозирует цель прогона на задачи и управляет воркерами. Задачам не назначается.'
  },
  {
    id: 'assistant', title: 'Ассистент', agent: 'claude',
    description: 'Ассистент доски: выполняет просьбы человека (создать, перенести, закрыть, перезапустить) через orca-board. Задачам не назначается.'
  },
  {
    id: 'developer', title: 'Программист', agent: 'claude',
    description: 'Пишет и меняет код: фичи, исправления, рефакторинг.'
  },
  {
    id: 'reviewer', title: 'Ревьюер', agent: 'claude',
    description: 'Проверяет ветку рабочей задачи после worker_done и принимает или отклоняет её.'
  },
  {
    id: 'qa', title: 'QA', agent: 'claude',
    description: 'Пишет и прогоняет тесты, проверяет поведение.'
  }
]

export const DEFAULT_ROLE_ID = 'developer'

/** Назначение системной роли (id из DEFAULT_ROLES) по умолчанию; у пользовательских ролей его нет. */
export function defaultRoleDescription(id: string): string | undefined {
  return DEFAULT_ROLES.find((r) => r.id === id)?.description
}

/**
 * Роли с назначением по умолчанию у системных ролей, где оно пустое (роли, созданные до появления поля,
 * или очищенное поле). Непустое назначение не трогается; возвращает новые объекты.
 */
export function withDefaultDescriptions(roles: Role[]): Role[] {
  return roles.map((r) => {
    if (r.description?.trim()) return r
    const description = defaultRoleDescription(r.id)
    return description ? { ...r, description } : r
  })
}

/**
 * Служебная инструкция Orca + системный промпт роли одним текстом. Блок роли идёт после служебной
 * инструкции и не заменяет её; текст роли вставляется как есть (переносы строк, кавычки), обрезаются
 * только пробелы по краям. Нет роли или промпт пустой — служебная инструкция без изменений.
 */
export function withRoleInstructions(system: string, role: Pick<Role, 'title' | 'systemPrompt'> | undefined): string {
  const own = role?.systemPrompt?.trim()
  if (!own) return system
  return `${system}\n\n# Инструкции роли «${role!.title}»\n\n${own}`
}

/**
 * Системный промпт агента, запущенного доской (воркер любой роли, координатор): служебная инструкция Orca,
 * затем блок `# Правила проекта` (`Project.agentRules`), затем инструкции роли (`withRoleInstructions`).
 * Правила проекта живут в конфиге доски, а не в CLAUDE.md/AGENTS.md, поэтому обычные сессии агентов их не видят.
 * Пустые правила — блока нет; текст вставляется как есть, обрезаются только пробелы по краям.
 */
export function withAgentRules(
  system: string,
  projectRules: string | undefined,
  role: Pick<Role, 'title' | 'systemPrompt'> | undefined
): string {
  const rules = projectRules?.trim()
  const base = rules ? `${system}\n\n# Правила проекта\n\n${rules}` : system
  return withRoleInstructions(base, role)
}

// ---------- колонки ----------

/** Системные виды колонок: по ним store переводит задачи автоматически. */
export type SystemColumnKind = 'backlog' | 'ready' | 'in_progress' | 'needs_input' | 'review' | 'done'

/** Вид колонки: системная или произвольная пользовательская. */
export type ColumnKind = SystemColumnKind | 'custom'

export const SYSTEM_COLUMN_KINDS: SystemColumnKind[] = [
  'backlog',
  'ready',
  'in_progress',
  'needs_input',
  'review',
  'done'
]

export interface BoardColumn {
  id: string
  title: string
  /** Цвет заголовка, hex. */
  color: string
  kind: ColumnKind
}

/** 8 предустановленных цветов заголовка колонки. */
export const COLUMN_COLORS: { value: string; title: string }[] = [
  { value: '#6b6f7c', title: 'Серый' },
  { value: '#7b86f5', title: 'Синий' },
  { value: '#f08a3a', title: 'Оранжевый' },
  { value: '#e8b04a', title: 'Жёлтый' },
  { value: '#b57bee', title: 'Фиолетовый' },
  { value: '#5ad1cc', title: 'Бирюзовый' },
  { value: '#e5484d', title: 'Красный' },
  { value: '#2ea043', title: 'Зелёный' }
]

/** Колонки по умолчанию: id === kind, цвета — первые шесть из COLUMN_COLORS. */
export const DEFAULT_COLUMNS: BoardColumn[] = [
  { id: 'backlog', title: 'Бэклог', color: COLUMN_COLORS[0].value, kind: 'backlog' },
  { id: 'ready', title: 'Готовы', color: COLUMN_COLORS[1].value, kind: 'ready' },
  { id: 'in_progress', title: 'В работе', color: COLUMN_COLORS[2].value, kind: 'in_progress' },
  { id: 'needs_input', title: 'Нужен ответ', color: COLUMN_COLORS[3].value, kind: 'needs_input' },
  { id: 'review', title: 'Ревью', color: COLUMN_COLORS[4].value, kind: 'review' },
  { id: 'done', title: 'Сделано', color: COLUMN_COLORS[5].value, kind: 'done' }
]

/** Статус задачи — id колонки доски (см. BoardColumn). */
export type TaskStatus = string

/**
 * Кто перевёл задачу в колонку: `human` — человек в UI (IPC renderer), `cli` — команда `orca-board` без
 * ORCA_DISPATCH_ID (координатор или человек в терминале — сокет их не различает), `worker` — команда воркера
 * (есть ORCA_DISPATCH_ID), `workflow` — исполнитель воркфлоу в main двигает задачу по графу, `app` — само
 * приложение: зависимости закрыты (backlog → ready), воркер умер, миграция, автозакрытие прогона.
 */
export type StatusSource = 'human' | 'cli' | 'worker' | 'workflow' | 'app'

export const STATUS_SOURCES: StatusSource[] = ['human', 'cli', 'worker', 'workflow', 'app']

/** Запись истории статусов задачи или глобальной задачи (`Task.statusHistory`, `Run.statusHistory`). */
export interface StatusChange {
  /** Колонка, в которую перешла задача (id колонки). */
  status: TaskStatus
  /** Момент перехода, epoch ms. */
  at: number
  by: StatusSource
  /** Нода воркфлоу (`WfStage.nodeId`), на которой стояла задача при переходе; у глобальных задач нет. */
  stage?: string
  /**
   * Стартовая запись миграции у задачи от кода до истории: реального перехода не было, это статус на момент
   * обновления, а `at` — последняя правка задачи (`updatedAt`), не точный момент входа в колонку.
   */
  migrated?: true
}

/** @deprecated Колонки берутся из настроек проекта, это только дефолт. */
export const TASK_STATUSES: TaskStatus[] = DEFAULT_COLUMNS.map((c) => c.id)

/** @deprecated Названия колонок берутся из настроек проекта, это только дефолт. */
export const STATUS_TITLES: Record<string, string> = Object.fromEntries(
  DEFAULT_COLUMNS.map((c) => [c.id, c.title])
)

// ---------- прогоны ----------

/**
 * Прогон = глобальная задача (верхний уровень двухуровневой доски, см. docs/nested-kanban.md):
 * карточка со своим статусом-колонкой, а её подзадачи — задачи с `Task.runId === run.id`.
 * Координатор, запущенный на глобальной задаче, работает в этом прогоне (ORCA_RUN_ID).
 */
export interface Run {
  id: string
  /** Описание глобальной задачи; для координатора — его цель. */
  objective: string
  /** Название карточки; нет — выводится из objective (`globalTaskTitle`). */
  title?: string
  /** Колонка доски глобальных задач (id колонки проекта). Нет только у старых снапшотов до миграции. */
  status?: TaskStatus
  /** Служебная «Входящие»: сюда попадают задачи без глобальной (старые и созданные без --run). */
  inbox?: boolean
  /**
   * Приоритет глобальной задачи — та же шкала, что у `Task.priority`. Store проставляет его всегда
   * (новым — normal, старым — `migrateRunPriority`); необязательное, потому что renderer строит карточки
   * из снапшота, который мог прислать main от кода до приоритетов, — `toGlobalTask` читает нет поля как normal.
   */
  priority?: TaskPriority
  createdAt: number
  /** Последняя правка карточки (название, описание, статус, запуск координатора). */
  updatedAt?: number
  /**
   * Прогон переоткрыт (новая подзадача в закрытой глобальной, повторный запуск координатора) и ещё
   * ни одна подзадача не дошла до done после этого: пока метка стоит, автозакрытия и run_done нет.
   * Снимается при первом входе подзадачи в done.
   */
  reopenedAt?: number
  /**
   * Все подзадачи дошли до kind=done при живом координаторе: run_done ему отправлен, но прогон не закрыт —
   * координатор решает, нужны ли новые задачи, карточка остаётся «В работе». Прогон закрывается (closedAt,
   * карточка — на «Проверку») по `runs finish` или смерти координатора (`settleIdleRuns`); новая подзадача
   * или подзадача, ушедшая из done, снимает метку (reopenRun). Без метки повторного run_done не было бы.
   */
  runDoneAt?: number
  /**
   * Прогон закрыт: карточка ушла на «Проверку»/в «Сделано» по итогам работы (`runs finish`, выход координатора
   * при всех подзадачах в done, автозакрытие без координатора) или прогон закрыт вручную.
   */
  closedAt?: number
  /** PTY координатора прогона. */
  coordinatorPtyId?: string
  /** Агент координатора: по нему решается, закрывать ли его терминал после run_done. */
  coordinatorAgent?: AgentKind
  /**
   * Координатор сообщил, что закончил работу по завершённому прогону (`orca-board runs finish`
   * последней командой, после run_done и сводки) — сигнал закрыть его терминал.
   */
  finishedAt?: number
  /**
   * Собственное время работы глобальной задачи: сумма закрытых отрезков, мс. Отрезок идёт, пока карточка
   * показана в колонке kind=in_progress — хранимый статус in_progress и нет pending-запросов к человеку
   * («Нужен ответ» — ожидание человека, время стоит). Считается в `TaskStore.commit` (`syncRunActiveTime`),
   * показывается через `GlobalTask.ownActiveMs`. Нет обоих полей — не бывала в работе или прогон от кода
   * до этих полей, не стоявший в работе при загрузке: своё время неизвестно.
   */
  activeMs?: number
  /** Начало текущего отрезка собственного времени; нет — время глобальной задачи стоит. */
  activeSince?: number
  /**
   * Глобальная задача впервые вошла в работу: карточка оказалась в колонке kind=in_progress (перенос, запуск
   * координатора) — ставится в `TaskStore.commit` вместе с открытием отрезка времени и больше не снимается.
   * Пока его нет (и нет координатора и подзадач), тип задачи можно сменить (`canChangeRunType`). У прогонов от кода
   * до поля проставляется миграцией `migrateRunStarted`.
   */
  startedAt?: number
  /**
   * Тип глобальной задачи (`TaskType.id`, task-types.ts): задаёт роли, правила агентов доски и разрешения
   * прогона — main берёт их по `resolveRunType` «вживую» из библиотеки. Нет — «Входящие» или прогон, ещё
   * не прошедший миграцию (`assignRunTypes`): используется тип проекта по умолчанию.
   */
  typeId?: string
  /**
   * Снимок типа на момент создания прогона (роли, правила, разрешения) — страховка, если тип удалят из
   * библиотеки. Живые роли берутся из типа по `typeId`, снимок — только когда типа уже нет.
   */
  taskType?: TaskTypeSnapshot
  /**
   * Снимок графа **типа** глобальной задачи на момент создания прогона (граф передаёт main, store в библиотеку
   * типов не ходит): правка графа посреди прогона не ломает переходы идущих задач. Нет — прогон от кода до
   * воркфлоу или «Входящие»: граф даёт вызывающий код (`TaskStore.runWorkflow`, граф типа по умолчанию).
   */
  workflow?: Workflow
  /**
   * Уточнения человека при возвратах с «Проверки» в работу (`TaskStore.returnGlobalTask`), по порядку.
   * Описание (`objective`) не трогают: уточнения попадают в цель повторного запуска координатора
   * (`resumeCoordinatorObjective`), в том числе при ручном «Запустить координатора», если старт упал.
   */
  returns?: Array<{ at: number; text: string }>
  /**
   * Итоговая сводка координатора «что сделано и что проверить» (`runs finish --summary`, markdown) — её
   * человек видит в блоке «Что сделал» на «Проверке». Хранится одна, последняя: новый `runs finish` со
   * сводкой заменяет прежнюю (координатор повторного запуска пишет итог целиком), без сводки — не трогает.
   * Нет — координатор сводку не передавал (старый код, ручной перенос): UI показывает сводки подзадач.
   */
  summary?: { at: number; text: string }
  /**
   * История смены колонки, от старых к новым (`recordStatus`, status-history.ts): не длиннее
   * `STATUS_HISTORY_LIMIT`, подряд одинаковых статусов нет. Нет — снапшот от кода до истории, ещё не прошедший
   * миграцию (renderer мог получить его от старого main).
   */
  statusHistory?: StatusChange[]
  /**
   * Запуски координатора на этой глобальной задаче, от старых к новым (статистика: время и токены координатора).
   * `coordinatorPtyId` — только последний, а глобальную задачу перезапускают («Вернуть в работу», повторный старт).
   * Нет — прогон от кода до статистики: время и токены координатора неизвестны.
   */
  coordinatorSessions?: AgentSession[]
}

/** Запуск агента вне dispatch (координатор): для статистики времени и токенов. */
export interface AgentSession {
  ptyId: string
  roleId: string
  agent: AgentKind
  model?: string
  /** Как `Dispatch.sessionId`. */
  sessionId?: string
  startedAt: number
  /** Выход PTY; нет — агент ещё работает (или приложение упало до выхода — тогда конец неизвестен). */
  endedAt?: number
}

// ---------- задачи ----------

/**
 * Кто читает ответ задачи-ответа: `human` — человек (глобальная задача ждёт его в колонке needs_input),
 * `coordinator` — координатор сам принимает ответ и использует его дальше.
 */
export type AnswerAudience = 'human' | 'coordinator'

export const ANSWER_AUDIENCES: AnswerAudience[] = ['human', 'coordinator']

/** Предел длины ответа (символов): ответ хранится в снапшоте доски. */
export const MAX_ANSWER_LENGTH = 200_000

/**
 * Показ человеку, который воркер сдал с `done` (нода «Работа» с `showcase`, workflow.ts): `text` — markdown
 * с описанием, `files` — пути файлов в ветке задачи от корня worktree (макеты, скриншоты). Сами файлы не
 * копируются: их читает main из worktree задачи.
 */
export interface DispatchShowcase {
  text?: string
  files: string[]
}

/** Предел длины текста показа (символов): он хранится в снапшоте доски, как ответ. */
export const MAX_SHOWCASE_LENGTH = MAX_ANSWER_LENGTH

/** Сколько файлов можно сдать на показ. */
export const MAX_SHOWCASE_FILES = 50

/**
 * Показ из `done` в сохраняемый вид: текст без пустоты, пути без пробелов по краям, без повторов, `\` → `/`.
 * Пустой показ — undefined. Путь должен быть относительным и не выходить из worktree (`..`): иначе ошибка
 * с подсказкой. Есть ли файл в ветке, core не знает — это проверяет main при чтении.
 */
export function normalizeShowcase(input: { text?: string; files?: readonly string[] } | undefined): DispatchShowcase | undefined {
  if (!input) return undefined
  const text = input.text?.trim() ? input.text : undefined
  if (text && text.length > MAX_SHOWCASE_LENGTH) throw new Error(`текст показа длиннее ${MAX_SHOWCASE_LENGTH} символов — сократи его`)
  const files: string[] = []
  for (const raw of input.files ?? []) {
    const file = raw.trim().replace(/\\/g, '/')
    if (!file) continue
    if (file.startsWith('/') || /^[a-zA-Z]:/.test(file)) {
      throw new Error(`файл показа «${raw}»: нужен путь от корня репозитория задачи, а не абсолютный`)
    }
    if (file.split('/').includes('..')) throw new Error(`файл показа «${raw}»: путь не должен выходить из репозитория задачи (..)`)
    if (!files.includes(file)) files.push(file)
  }
  if (files.length > MAX_SHOWCASE_FILES) throw new Error(`файлов показа больше ${MAX_SHOWCASE_FILES} — оставь главные`)
  if (!text && files.length === 0) return undefined
  return { ...(text ? { text } : {}), files }
}

/**
 * Приоритет задачи: влияет только на порядок показа и выбора, не на промпт воркера. Порядок в
 * `TASK_PRIORITIES` — от высшего к низшему, на нём держится `priorityRank`.
 */
export type TaskPriority = 'urgent' | 'high' | 'normal' | 'low'

export const TASK_PRIORITIES: TaskPriority[] = ['urgent', 'high', 'normal', 'low']

export const DEFAULT_TASK_PRIORITY: TaskPriority = 'normal'

export const PRIORITY_TITLES: Record<TaskPriority, string> = {
  urgent: 'срочный',
  high: 'высокий',
  normal: 'обычный',
  low: 'низкий'
}

export function isTaskPriority(v: unknown): v is TaskPriority {
  return typeof v === 'string' && (TASK_PRIORITIES as string[]).includes(v)
}

/**
 * Ранг для сортировки по возрастанию: urgent=0 … low=3. Нет поля или неизвестное значение (снапшот от
 * кода до приоритетов, ещё не прошедший миграцию) — как normal, чтобы такие задачи не всплывали наверх.
 */
export function priorityRank(p: TaskPriority | undefined): number {
  const i = p === undefined ? -1 : TASK_PRIORITIES.indexOf(p)
  return i === -1 ? TASK_PRIORITIES.indexOf(DEFAULT_TASK_PRIORITY) : i
}

export interface Task {
  id: string
  title: string
  spec: string
  /** Id колонки доски. */
  status: TaskStatus
  /** Приоритет; у задач из старых снапшотов проставляется при загрузке (`migrateTaskPriority`). */
  priority: TaskPriority
  deps: string[]
  /** Прогон, к которому относится задача; нет — задача создана из UI вне прогона. */
  runId?: string
  /** Роль проекта: агент и модель берутся из неё; `agent` — снимок на момент создания/запуска. */
  roleId: string
  agent: AgentKind
  worktree?: string
  branch?: string
  dispatchId?: string
  /** Замечания после ревью (у задачи-ответа — уточнение), попадут в промпт при перезапуске. */
  feedback?: string
  /**
   * Задача-ответ («посмотри», «разберись», «предложи»): результат — текст в markdown (`Dispatch.answer`),
   * а не изменения в коде; ревью кода не нужно. Значение — кто читает ответ. Нет поля — обычная задача.
   */
  answerFor?: AnswerAudience
  createdAt: number
  updatedAt: number
  /** Первый startDispatch. */
  startedAt?: number
  /**
   * Время работы: сумма закрытых отрезков в колонке kind=in_progress, мс. Нет — задача ещё не бывала
   * в работе. Считается в `TaskStore.setStatus` (`trackActiveTime`), показывается через `taskActiveTime`.
   */
  activeMs?: number
  /** Начало текущего отрезка работы: есть, только пока задача в kind=in_progress (время тикает). */
  activeSince?: number
  /** Момент попадания в колонку kind=done. */
  doneAt?: number
  /**
   * Позиция в воркфлоу прогона (`TaskStore.advanceStage`). Нет — задача вне воркфлоу: задача-ответ,
   * задача-гейт или ещё не вошедшая в граф.
   */
  stage?: WfStage
  /** Задача-гейт: чью ветку проверяет и на какой ноде `gate` рабочей задачи. */
  gateFor?: { taskId: string; nodeId: string }
  /**
   * История смены колонки, от старых к новым (`recordStatus`, status-history.ts): не длиннее
   * `STATUS_HISTORY_LIMIT`, подряд одинаковых статусов нет. Нет — снапшот от кода до истории, ещё не прошедший
   * миграцию (renderer мог получить его от старого main).
   */
  statusHistory?: StatusChange[]
}

export type DispatchOutcome = 'done' | 'failed' | 'unknown'

export interface Dispatch {
  id: string
  taskId: string
  ptyId: string
  startedAt: number
  endedAt?: number
  outcome?: DispatchOutcome
  summary?: string
  files?: string[]
  /** Ответ задачи-ответа (markdown), `orca-board done --answer-file`. */
  answer?: string
  /** Показ человеку (`normalizeShowcase`). Нет — воркер ничего не показывал или dispatch от кода до показа. */
  showcase?: DispatchShowcase
  /** Уже отправили эскалацию «нет вывода». */
  stuckNotified?: boolean
  /**
   * Снимок роли, агента и модели на момент запуска (статистика: разбивки по роли и модели). Роль задачи и её
   * модель могут перенастроить позже, а прогон агента уже потратил токены на ту модель. Нет — dispatch от кода
   * до статистики: берутся `Task.roleId` / `Task.agent`, модель — из транскрипта или неизвестна.
   */
  roleId?: string
  agent?: AgentKind
  model?: string
  /**
   * Id сессии агента: по нему main находит транскрипт с токенами (docs/architecture.md, «Статистика»).
   * Claude Code — uuid, который main генерирует и передаёт в `--session-id`; у агентов, которым id задать нельзя,
   * — найденный по cwd и времени (codex) или нет.
   */
  sessionId?: string
}

/** Вариант ответа на вопрос: кнопка в UI. `id` — что уходит в `resolution.optionId`. */
export interface RequestOption {
  id: string
  label: string
  /** Пояснение к варианту («проще, без сервера»). */
  hint?: string
  /** Вариант, который советует спросивший. */
  recommended?: boolean
}

/**
 * Варианты из старых данных и `--options a,b` — строки: превращаются в RequestOption с id по номеру
 * (`'1'`, `'2'`, …). Готовые RequestOption проверяются: непустая метка, уникальный id.
 */
export function normalizeOptions(options: readonly (string | RequestOption)[] | undefined): RequestOption[] {
  const out: RequestOption[] = []
  for (const [i, o] of (options ?? []).entries()) {
    const opt: RequestOption = typeof o === 'string' ? { id: String(i + 1), label: o } : { ...o, id: o.id?.trim() || String(i + 1) }
    opt.label = opt.label?.trim() ?? ''
    if (!opt.label) throw new Error(`вариант ${i + 1}: пустая метка`)
    if (out.some((x) => x.id === opt.id)) throw new Error(`вариант с id «${opt.id}» повторяется`)
    if (!opt.hint?.trim()) delete opt.hint
    if (!opt.recommended) delete opt.recommended
    out.push(opt)
  }
  return out
}

export interface Question {
  id: string
  taskId: string
  dispatchId?: string
  question: string
  options: RequestOption[]
  /** Контекст вопроса (markdown): почему спрашивает, что уже выяснил. */
  context?: string
  answer?: string
  /**
   * Вопрос адресован человеку: по нему создан HumanRequest (`questionId`). Ставится при создании
   * (координатора нет) или явным переходом — `forwardQuestion`, `escalateOpenQuestions`. Без метки вопрос
   * ждёт координатора.
   */
  forHuman?: boolean
  createdAt: number
  answeredAt?: number
}

// ---------- запросы к человеку ----------

/**
 * Что ждёт человека: `question` — вопрос воркера (адресован человеку сразу или передан координатором),
 * `answer` — сданный ответ задачи `answerFor: 'human'` («Принять» / «Уточнить»), `escalation` — воркер
 * вышел без `orca-board done` («Перезапустить» / «Скрыть»), `approval` — рабочая задача на ноде `human`
 * воркфлоу ждёт решения человека («Принять» / «Вернуть», docs/workflow.md).
 */
export type HumanRequestKind = 'question' | 'answer' | 'escalation' | 'approval'

export const HUMAN_REQUEST_KINDS: HumanRequestKind[] = ['question', 'answer', 'escalation', 'approval']

/** `pending` — единственный признак «ждёт человека» (колонка «Нужен ответ»). */
export type HumanRequestStatus = 'pending' | 'resolved' | 'cancelled'

export type ResolutionAction = 'answer' | 'accept' | 'clarify' | 'restart' | 'dismiss' | 'reject'

/** Какие решения допустимы для вида запроса. */
export const REQUEST_ACTIONS: Record<HumanRequestKind, ResolutionAction[]> = {
  question: ['answer'],
  answer: ['accept', 'clarify'],
  escalation: ['restart', 'dismiss'],
  approval: ['accept', 'reject']
}

export interface RequestResolution {
  action: ResolutionAction
  /** Выбранный вариант вопроса (RequestOption.id). */
  optionId?: string
  /** Свободный текст: ответ на вопрос, решение при «Принять», уточнение при «Уточнить», замечания при «Вернуть». */
  text?: string
}

/**
 * Запрос к человеку (docs/nested-kanban.md). Создаётся одним переходом store, закрывается одним —
 * `resolveRequest` (или `cancelled`, когда запрос потерял смысл: задача сделана, воркер перезапущен).
 * Адресат фиксируется при создании и не пересчитывается от состояния прогона.
 */
export interface HumanRequest {
  id: string
  runId: string
  taskId: string
  /** Dispatch, который спросил / сдал ответ / упал. */
  dispatchId?: string
  kind: HumanRequestKind
  status: HumanRequestStatus
  /** Вопрос / summary ответа / причина эскалации. */
  title: string
  /** Markdown: контекст вопроса (+ заметка координатора) или сам ответ задачи-ответа. */
  body?: string
  /** Варианты вопроса; у answer/escalation/approval пусто — их действия встроены (REQUEST_ACTIONS). */
  options: RequestOption[]
  /** Вопрос, из которого создан запрос (kind=question): сокет `ask` держится за него. */
  questionId?: string
  /** Нода `human` воркфлоу, на которой задача ждёт решения (kind=approval). */
  nodeId?: string
  resolution?: RequestResolution
  createdAt: number
  /** Решён или отменён. */
  resolvedAt?: number
}

export type EventType =
  | 'task_ready'
  | 'worker_done'
  | 'question'
  | 'escalation'
  | 'question_answered'
  /** Человек принял ответ задачи-ответа `answerFor: 'human'` — координатор решает, что делать дальше. */
  | 'answer_accepted'
  | 'run_done'
  /** Появился запрос к человеку (HumanRequest pending) — по нему уведомление. */
  | 'request_created'
  /** Эскалацию решил человек: `restart` (main стартует воркера) или `dismiss`. */
  | 'request_resolved'
  /** Человек уточнил ответ задачи-ответа: задача в ready с feedback, main стартует воркера. */
  | 'answer_clarified'
  /** Задача перешла на другой этап воркфлоу (`advanceStage`); в основном для UI. */
  | 'stage_changed'
  /** Воркфлоу не может вести задачу дальше (нет перехода, роль гейта удалена) — нужен координатор или человек. */
  | 'workflow_blocked'

export const EVENT_TYPES: EventType[] = [
  'task_ready',
  'worker_done',
  'question',
  'escalation',
  'question_answered',
  'answer_accepted',
  'run_done',
  'request_created',
  'request_resolved',
  'answer_clarified',
  'stage_changed',
  'workflow_blocked'
]

export interface OrcaEvent {
  id: string
  type: EventType
  taskId?: string
  dispatchId?: string
  payload: Record<string, unknown>
  createdAt: number
  consumedBy?: string
}

// ---------- статистика ----------

/**
 * Период статистики проекта: всё время или последние 7 / 30 суток от момента запроса (скользящее окно, а не
 * календарные недели). Границу считает `statsRangeStart` (stats.ts).
 */
export type StatsRange = 'all' | '7d' | '30d'

export const STATS_RANGES: StatsRange[] = ['all', '7d', '30d']

/**
 * Токены по видам — как их считает API Anthropic: `input` — только некэшированный вход, кэш отдельно.
 * У codex `input_tokens` включает кэш, при чтении из него вычитается `cached_input_tokens`. Рассуждения
 * (reasoning) входят в `output`: отдельно их даёт не каждый агент.
 */
export interface TokenUsage {
  input: number
  output: number
  /** Чтение из кэша промпта (`cache_read_input_tokens`, у codex — `cached_input_tokens`). */
  cacheRead: number
  /** Запись в кэш промпта (`cache_creation_input_tokens`); у codex — 0. */
  cacheWrite: number
}

/**
 * Цена модели, $ за миллион токенов. Таблица цен — одна, `MODEL_PRICES` в `packages/core/src/pricing.ts`
 * (docs/architecture.md, «Статистика → Стоимость»).
 */
export interface ModelPrice {
  /** Префиксы id модели из транскрипта (`claude-opus-5` покрывает `claude-opus-5-20260101`); самый длинный выигрывает. */
  match: string[]
  input: number
  output: number
  cacheRead: number
  /** Запись в кэш с TTL 5 минут. */
  cacheWrite5m: number
  /** Запись в кэш с TTL 1 час; транскрипт Claude Code делит запись по TTL (`usage.cache_creation`). */
  cacheWrite1h: number
}

/**
 * Расход за срез статистики (весь проект, роль, модель, задача, день). «Неизвестно» и «ноль» различаются:
 * `tokens` нет, если ни для одной сессии среза не нашлось данных (агент без транскриптов, транскрипт удалён,
 * dispatch от кода до статистики); тогда UI пишет «нет данных», а не 0.
 */
export interface StatsUsage {
  tokens?: TokenUsage
  /**
   * Стоимость токенов моделей из `MODEL_PRICES`, $. Нет — токенов нет или ни одна их модель не известна таблице.
   * Токены неизвестных моделей в неё не входят — см. `unpricedTokens`.
   */
  costUsd?: number
  /** Токены (все виды) моделей, которых нет в таблице цен: стоимость по ним неизвестна. */
  unpricedTokens: number
  /** Id таких моделей — чтобы UI подсказал, что дописать в таблицу. */
  unpricedModels: string[]
  /** Сессии агентов в срезе (dispatch + запуски координатора). */
  sessions: number
  /** Из них — с найденными данными о токенах. `sessions - sessionsWithUsage` — «неизвестно». */
  sessionsWithUsage: number
  /** Время работы агентов: сумма длительностей сессий, мс (идущая — до момента запроса). */
  agentMs: number
}

/** Строка разбивки: роль, модель, агент, глобальная задача или задача. */
export interface StatsRow extends StatsUsage {
  /** Id роли / модели / агента / глобальной задачи / задачи; `unknown` — модель неизвестна. */
  key: string
  /** Подпись для UI: название роли, задачи; для модели и агента — их id и название агента. */
  title: string
}

/** День в разбивке по дням (локальная дата main). Дни без активности в массив не попадают. */
export interface StatsDay extends StatsUsage {
  /** `YYYY-MM-DD`. */
  date: string
  /** Задач, вошедших в kind=done в этот день. */
  tasksDone: number
  /**
   * Расход дня по моделям — сегменты столбца графика «Стоимость» на вкладке «Статистика» (вариант B);
   * те же ключи, что в `ProjectStats.byModel`, порядок тот же. Сессии без данных о модели — строка `unknown`.
   */
  byModel: StatsRow[]
}

/** Счётчики задач или глобальных задач. */
export interface StatsCounts {
  /** Всего сейчас на доске (без учёта периода). */
  total: number
  /** Сейчас по колонкам: id колонки → число. */
  byStatus: Record<string, number>
  /** Созданы в периоде. */
  created: number
  /** Вошли в kind=done в периоде (по `StatusChange`; у записей без истории — `doneAt` / `closedAt`). */
  done: number
}

/**
 * Статистика проекта (`stats:project`). Период задаёт `range`: токены — по времени сообщений в транскрипте,
 * сессии и время агентов — по пересечению сессии с периодом, счётчики `created` / `done` — по моменту события.
 * Пустой проект или стаб main — `emptyProjectStats` (stats.ts).
 */
export interface ProjectStats {
  projectId: string
  range: StatsRange
  /** Начало периода, epoch ms; нет — всё время. */
  from?: number
  /** Момент расчёта: конец периода и «сейчас» для идущих сессий. */
  generatedAt: number
  /** Итог по проекту за период. */
  totals: StatsUsage
  tasks: StatsCounts
  globalTasks: StatsCounts
  /** Прогоны агентов на задачах (`Dispatch`) за период: по исходу и ещё идущие. */
  dispatches: { total: number; done: number; failed: number; unknown: number; running: number }
  /** Запуски координатора (`Run.coordinatorSessions`) за период. */
  coordinatorLaunches: number
  /**
   * Время задач, вошедших в done в периоде. `avgActiveMs` — среднее `Task.activeMs` (время в kind=in_progress);
   * `avgLeadMs` — среднее от первого входа в kind=in_progress до входа в done по истории статусов (записи
   * миграции `migrated` не считаются). Нет выборки — поля нет; `samples` — сколько задач вошло в среднее.
   */
  taskTime: { avgActiveMs?: number; avgLeadMs?: number; samples: number }
  /** Разбивки; строки отсортированы по стоимости, затем по токенам, затем по времени агентов — по убыванию. */
  byRole: StatsRow[]
  byModel: StatsRow[]
  byAgent: StatsRow[]
  byGlobalTask: StatsRow[]
  byTask: StatsRow[]
  /** По дням, от старых к новым. */
  byDay: StatsDay[]
}
