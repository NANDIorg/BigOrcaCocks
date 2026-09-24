import type { Task, ImageAttachmentInput, AgentKind, AgentInfo, StoreSnapshot, Role, BoardColumn, Run, GlobalTask, BuiltinPrompts, AnswerAudience, TaskPriority, HumanRequest, RequestResolution, Workflow, TaskType, TaskTypeSettings } from '@orca-board/core'
import type { NotificationSettings, NotificationSettingsPatch } from './notifications'

export interface PtySpawnOptions {
  cwd?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cols: number
  rows: number
  /** Проект терминала из UI: регистрируется в реестре как role=shell с этим проектом. */
  projectId?: string
  /** Подпись вкладки терминала из UI. */
  label?: string
}

export type TerminalRole = 'coordinator' | 'worker' | 'assistant' | 'shell'

/** Живой PTY в реестре main (src/main/pty.ts). Источник правды для вкладок «Терминалы». */
export interface TerminalInfo {
  ptyId: string
  label: string
  role: TerminalRole
  taskId?: string
  projectId?: string
  /** Прогон, который открыл этого координатора. */
  runId?: string
  createdAt: number
}

/** Элемент terminals:list: реестр + хвост вывода (последние ~200 строк без ANSI) для восстановления вкладки после перезагрузки окна. */
export interface TerminalSnapshot extends TerminalInfo {
  tail: string
}

/** Глобальные настройки приложения (не проекта). */
export interface AppSettings {
  /** Закрытие окна не завершает приложение: PTY живут, иконка в трее. По умолчанию true. */
  keepInBackground: boolean
  /** Системные уведомления: фильтры по ролям, видам событий, тихие часы. */
  notifications: NotificationSettings
}

/** Патч настроек приложения: notifications мержится по полям. */
export interface AppSettingsPatch {
  keepInBackground?: boolean
  notifications?: NotificationSettingsPatch
}

/** Правка задачи из UI/CLI: название, описание, приоритет (приоритет — в любой колонке). */
export interface TaskPatch {
  title?: string
  spec?: string
  priority?: TaskPriority
}

/**
 * Новая глобальная задача: нужно название или описание; status — id колонки (по умолчанию kind=backlog),
 * priority — по умолчанию normal.
 */
export interface GlobalTaskInput {
  title?: string
  description?: string
  status?: string
  priority?: TaskPriority
  /**
   * Тип задачи (`TaskType.id`): задаёт роли, воркфлоу, правила агентов и разрешения глобальной задачи. Нет —
   * тип проекта по умолчанию; тип, недоступный проекту (`Project.taskTypeIds`), — ошибка.
   */
  typeId?: string
}

/** Правка глобальной задачи: название (непустое), описание и/или приоритет (в любой колонке). */
export interface GlobalTaskPatch {
  title?: string
  description?: string
  priority?: TaskPriority
}

/** Подзадача внутри глобальной задачи. Без roleId — единственная роль типа задачи, иначе ошибка. */
export interface SubtaskInput {
  title: string
  spec?: string
  /** Только подзадачи той же глобальной задачи, иначе ошибка. */
  deps?: string[]
  roleId?: string
  /** Задача-ответ: результат — ответ в markdown, а не код (из UI — всегда для человека). */
  answerFor?: AnswerAudience
  /** Нет — normal. */
  priority?: TaskPriority
}

export type PermissionMode = 'auto' | 'bypassPermissions' | 'acceptEdits'

export const PERMISSION_MODES: Record<PermissionMode, string> = {
  auto: 'Авто — Claude сам решает, опасное спросит',
  bypassPermissions: 'Без подтверждений — полностью автономно',
  acceptEdits: 'Только правки файлов — остальное спросит в терминале'
}

/**
 * Проект в renderer. Свои у проекта только колонки, агенты и типы задач; роли, воркфлоу, правила агентов
 * и разрешения — у типа задачи (`TaskType`, «Настройки → Типы задач»).
 */
export interface Project {
  id: string
  root: string
  name: string
  /** Включённые агенты. undefined — все установленные. */
  enabledAgents?: AgentKind[]
  /** Колонки доски в порядке показа. undefined — DEFAULT_COLUMNS. */
  columns?: BoardColumn[]
  /** Типы задач, доступные в проекте. undefined — все типы библиотеки. */
  taskTypeIds?: string[]
  /**
   * Тип по умолчанию: глобальные задачи и координатор без выбранного типа, «Входящие». Нет или тип удалён —
   * тип библиотеки по умолчанию (`TaskTypesState.defaultTaskTypeId`).
   */
  defaultTaskTypeId?: string
  /** Тип, в который миграция перенесла настройки проекта; его получают старые прогоны доски. */
  legacyTypeId?: string
}

/** Создать (без `id`) или целиком заменить тип задачи. */
export interface TaskTypeInput {
  id?: string
  title: string
  description?: string
  settings: TaskTypeSettings
}

/** Вся библиотека типов (встроенные, затем пользовательские) и тип библиотеки по умолчанию. */
export interface TaskTypesState {
  taskTypes: TaskType[]
  defaultTaskTypeId: string
}

/** Типы проекта: какие доступны и какой по умолчанию. */
export interface ProjectTaskTypesInput {
  /** null или нет — доступны все типы библиотеки; иначе — непустой список id. */
  typeIds?: string[] | null
  /** Должен быть среди доступных. */
  defaultTypeId: string
}

/** Подсказка типа для выбранной папки: предвыбор в выборе типа нового проекта. */
export interface TaskTypeDetection {
  /** Выбранная папка — её передают в `projects.add(typeId, path)`. */
  path: string
  /** Угаданный тип; признаков нет — тип библиотеки по умолчанию. */
  typeId: string
  /** Почему угадан («package.json: react»); пусто — признаков нет. */
  reason: string
}

export interface ReviewInfo {
  base: string
  branch: string
  stat: string
  commits: string[]
  dirty: boolean
}

/**
 * Файлы правил проекта в корне репозитория — единственные, которые UI может записать (раздел «Правила»).
 * Белый список: имя от renderer сверяется с ним в main, произвольных путей нет.
 */
export const RULE_FILE_NAMES = ['CLAUDE.md', 'AGENTS.md'] as const
export type RuleFileName = (typeof RULE_FILE_NAMES)[number]

export function isRuleFileName(v: unknown): v is RuleFileName {
  return typeof v === 'string' && (RULE_FILE_NAMES as readonly string[]).includes(v)
}

/** Файл правил в корне проекта. */
export interface RuleFile {
  name: RuleFileName
  exists: boolean
  /** Содержимое с переводами строк `\n` (textarea всё равно их нормализует); нет файла — ''. */
  text: string
  /** Перевод строк файла на диске — main вернёт его при записи. Новый файл — 'lf'. */
  eol: 'lf' | 'crlf'
}

/** Markdown-файл в просмотрщике «Документы». */
export interface DocFile {
  /** Относительно корня источника (проекта или worktree задачи), через `/`. */
  path: string
  size: number
  mtime: number
  /** Не отслеживается git'ом — новый файл. */
  untracked: boolean
}

/** Группа документов: проект (`source: 'project'`) или worktree задачи в работе (`source` — id задачи). */
export interface DocGroup {
  source: string
  title: string
  branch?: string
  files: DocFile[]
}

/** Фильтр списка запросов к человеку активного проекта. */
export interface RequestListOptions {
  /** Только запросы этой глобальной задачи (прогона). */
  runId?: string
  /** Только ждущие человека (`status === 'pending'`). */
  pending?: boolean
}

/** Итог requests:resolve. */
export interface RequestResolveResult {
  request: HumanRequest
  /** «Уточнить» / «Перезапустить»: запущенный воркер. */
  worker?: { ptyId: string; dispatchId: string }
  /** Запрос решён, но воркер не стартовал — координатору ушла escalation с этой причиной. */
  startError?: string
}

/** Клик по уведомлению о запросе: открыть Инбокс на нём. */
export interface RequestFocus {
  projectId: string
  requestId: string
}

/** Контракт между renderer и main. Реализуется в preload как window.orca. */
export interface OrcaApi {
  app: {
    info(): Promise<{ socketPath: string; active: Project | null; projects: Project[] }>
    getSettings(): Promise<AppSettings>
    /** Мерж патча в глобальные настройки; возвращает итоговые. */
    setSettings(patch: AppSettingsPatch): Promise<AppSettings>
    /** Показать тестовое уведомление в обход фильтров (кроме звука и превью). */
    testNotification(): Promise<void>
  }
  projects: {
    list(): Promise<{ active: Project | null; projects: Project[] }>
    /** Задачи в колонках kind=in_progress по id проекта — для бейджа в списке проектов. */
    inProgressCounts(): Promise<Record<string, number>>
    /**
     * Добавить репозиторий с типом по умолчанию `typeId` (нет — тип библиотеки по умолчанию; id встроенных типов
     * совпадают с id старых шаблонов). Без `path` — диалог выбора папки (отмена — null); с `path` (из
     * `detectTaskType`) — без диалога. Уже добавленный возвращается как есть.
     */
    add(typeId?: string, path?: string): Promise<Project | null>
    /**
     * Без `path` — диалог выбора папки (отмена — null), затем подсказка типа по файлам репозитория;
     * с `path` — только подсказка. Проект не добавляется.
     */
    detectTaskType(path?: string): Promise<TaskTypeDetection | null>
    /** Доступные проекту типы и тип по умолчанию; неизвестный тип или тип по умолчанию вне списка — ошибка. */
    setTaskTypes(id: string, input: ProjectTaskTypesInput): Promise<Project>
    remove(id: string): Promise<void>
    setActive(id: string): Promise<Project>
    setEnabledAgents(id: string, agents: AgentKind[]): Promise<Project>
    /** Задачи из удалённых колонок переезжают в backlog. */
    setColumns(id: string, columns: BoardColumn[]): Promise<Project>
    /** Клик по уведомлению: показать этот проект. */
    onFocus(cb: (projectId: string) => void): () => void
  }
  /**
   * Типы задач (docs/architecture.md → «Типы задач»): тип выбирается у глобальной задачи и задаёт её роли,
   * воркфлоу, правила агентов и разрешения. Встроенный правится целиком: сохраняется «изменённый встроенный»
   * с тем же id (`builtinBase`), удаление которого — «Сбросить к системному».
   */
  taskTypes: {
    list(): Promise<TaskTypesState>
    /** Создать или заменить тип; настройки валидируются (граф — по ролям типа, колонки не проверяются). */
    save(input: TaskTypeInput): Promise<TaskType>
    /**
     * Удалить пользовательский тип. Изменённый встроенный — сбросить к системному (id тот же, проекты остаются на
     * нём); встроенный без правок — ошибка. Прогоны удалённого типа дорабатывают по своему снимку, проекты с ним по
     * умолчанию — на типе библиотеки по умолчанию.
     */
    delete(id: string): Promise<TaskTypesState>
    /** Копия типа (в том числе встроенного) под новым id. */
    duplicate(id: string): Promise<TaskType>
    setDefault(id: string): Promise<TaskTypesState>
  }
  agents: {
    /** Агенты реестра с признаками «установлен»/«включён» для активного проекта. refresh — пересканировать PATH. */
    list(refresh?: boolean): Promise<AgentInfo[]>
  }
  prompts: {
    /** Служебные инструкции Orca (skills/*.md) — тот же текст, что агенты получают при запуске. */
    builtin(): Promise<BuiltinPrompts>
  }
  board: {
    get(): Promise<StoreSnapshot>
    onChange(cb: (p: { projectId: string; snapshot: StoreSnapshot }) => void): () => void
  }
  /** Прогоны активного проекта. Изменения приходят в board.onChange (snapshot.runs). */
  runs: {
    list(): Promise<Run[]>
    /** Закрыть прогон вручную (closedAt). */
    close(id: string): Promise<Run>
  }
  /**
   * Глобальные задачи активного проекта — верхний уровень доски (docs/nested-kanban.md).
   * Глобальная задача = прогон (Run), подзадачи — задачи с `runId === id`. Изменения — в board.onChange
   * (snapshot.runs + snapshot.tasks; карточки из снапшота строит `toGlobalTasks` из core).
   */
  globalTasks: {
    /** Карточки с прогрессом подзадач, в порядке создания. Нет проекта — []. */
    list(): Promise<GlobalTask[]>
    get(id: string): Promise<GlobalTask>
    create(input: GlobalTaskInput): Promise<GlobalTask>
    update(id: string, patch: GlobalTaskPatch): Promise<GlobalTask>
    /** status — id колонки проекта. Подзадачи не трогает. */
    move(id: string, status: string): Promise<GlobalTask>
    /**
     * С подзадачами — только `cascade: true` (удаляются вместе с ней). Ошибка, если жив координатор
     * или у подзадачи идёт воркер.
     */
    remove(id: string, opts?: { cascade?: boolean }): Promise<{ deleted: string; tasks: string[] }>
    /** Подзадачи только этой глобальной задачи. */
    tasks(id: string): Promise<Task[]>
    createTask(id: string, input: SubtaskInput): Promise<Task>
    /**
     * Запуск координатора на существующей глобальной задаче (цель — её описание и список подзадач).
     * Новые подзадачи координатора попадают в неё же. Второй живой координатор — ошибка.
     */
    startCoordinator(id: string, cols: number, rows: number, images?: ImageAttachmentInput[]): Promise<string>
    /** «Подтвердить» на «Проверке»: из колонки kind=review в done, событий нет. Не на проверке — ошибка. */
    accept(id: string): Promise<GlobalTask>
    /**
     * «Вернуть в работу» с «Проверки» с уточнением (`text` обязателен): задача — в работу, координатор
     * запускается повторно и получает уточнение в цели. Возвращает ptyId координатора.
     */
    returnToWork(id: string, text: string, cols: number, rows: number): Promise<string>
  }
  tasks: {
    /** Без roleId — единственная роль типа проекта по умолчанию, иначе ошибка. Задача попадает во «Входящие» (см. globalTasks). */
    create(input: { title: string; spec?: string; deps?: string[]; roleId?: string; priority?: TaskPriority }): Promise<Task>
    /** status — id колонки. */
    move(id: string, status: string): Promise<Task>
    /** Название/описание/приоритет. Название и описание задачи в колонке kind=in_progress править нельзя — ошибка. */
    update(id: string, patch: TaskPatch): Promise<Task>
    remove(id: string): Promise<void>
  }
  questions: {
    answer(id: string, answer: string): Promise<void>
  }
  /**
   * Запросы к человеку активного проекта (HumanRequest). Изменения приходят в board.onChange
   * (snapshot.requests).
   */
  requests: {
    list(opts?: RequestListOptions): Promise<HumanRequest[]>
    /**
     * Решить запрос одним вызовом: вариант/текст вопроса, «Принять» (с git-частью, `text` — решение),
     * «Уточнить» и «Перезапустить» (сразу стартует воркера), «Скрыть». Уже решённый — ошибка.
     */
    resolve(id: string, resolution: RequestResolution): Promise<RequestResolveResult>
    /** Клик по системному уведомлению о запросе: открыть Инбокс на этом запросе. */
    onFocus(cb: (p: RequestFocus) => void): () => void
  }
  pty: {
    spawn(opts: PtySpawnOptions): Promise<string>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): void
    onData(id: string, cb: (data: string) => void): () => void
    onExit(id: string, cb: (code: number) => void): () => void
  }
  /** Реестр живых PTY в main — источник правды для вкладок «Терминалы». */
  terminals: {
    /** Текущий реестр с хвостами вывода — для восстановления вкладок после перезагрузки окна. */
    list(): Promise<TerminalSnapshot[]>
    /** Реестр изменился (открыт/закрыт PTY). Всегда полный список. */
    onChanged(cb: (list: TerminalInfo[]) => void): () => void
  }
  worker: {
    start(taskId: string, cols: number, rows: number): Promise<{ ptyId: string; dispatchId: string }>
  }
  coordinator: {
    /**
     * Запуск координатора. `images` — вставленные из буфера изображения: main проверяет их
     * (`validateImageAttachments`), сохраняет файлами на время прогона и передаёт агенту пути.
     * Пустая цель допустима только с изображениями (тогда цель — `DEFAULT_IMAGE_OBJECTIVE`).
     */
    start(objective: string, cols: number, rows: number, images?: ImageAttachmentInput[]): Promise<string>
  }
  /** Ассистент доски активного проекта (skills/assistant.md): интерактивный агент, действует через orca-board. */
  assistant: {
    /** Терминал ассистента: живой — тот же, иначе запускается новый. */
    open(cols: number, rows: number): Promise<{ ptyId: string }>
    /** Закрыть терминал ассистента (если жив) и запустить новый — чистый контекст. */
    reset(cols: number, rows: number): Promise<{ ptyId: string }>
  }
  /** .md-файлы активного проекта и worktree его задач в работе. Путь — только относительный, внутри источника. */
  docs: {
    list(): Promise<DocGroup[]>
    /** Содержимое .md (не больше 2 МБ); путь вне источника, симлинк наружу, не-.md — ошибка. */
    read(source: string, path: string): Promise<string>
    /** Открыть файл в приложении системы по умолчанию. */
    open(source: string, path: string): Promise<void>
    /** Показать файл в Finder/Проводнике. */
    reveal(source: string, path: string): Promise<void>
  }
  /** Правила активного проекта: CLAUDE.md и AGENTS.md в его корне (не в worktree задач). */
  rules: {
    /** Оба файла в порядке RULE_FILE_NAMES; отсутствующий — `exists: false`. */
    list(): Promise<RuleFile[]>
    /** Записать файл (создать, если нет) атомарно; имя не из белого списка — ошибка. */
    save(name: RuleFileName, text: string): Promise<RuleFile>
  }
  review: {
    info(taskId: string): Promise<ReviewInfo>
    /** `decision` — решение человека по задаче-ответу, уходит координатору в answer_accepted. */
    accept(taskId: string, decision?: string): Promise<void>
    reject(taskId: string, feedback: string): Promise<void>
  }
}
