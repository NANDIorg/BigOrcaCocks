import type { Task, ImageAttachmentInput, AgentKind, AgentInfo, StoreSnapshot, Role, BoardColumn, Run, GlobalTask, BuiltinPrompts, AnswerAudience, TaskPriority, HumanRequest, RequestResolution, Workflow } from '@orca-board/core'
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

/** Новая глобальная задача: нужно название или описание; status — id колонки (по умолчанию kind=backlog). */
export interface GlobalTaskInput {
  title?: string
  description?: string
  status?: string
}

/** Правка глобальной задачи: название (непустое) и/или описание. */
export interface GlobalTaskPatch {
  title?: string
  description?: string
}

/** Подзадача внутри глобальной задачи. Без roleId — единственная роль проекта, иначе ошибка. */
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

export interface Project {
  id: string
  root: string
  name: string
  permissionMode?: PermissionMode
  /** Включённые агенты. undefined — все установленные. */
  enabledAgents?: AgentKind[]
  /** Роли проекта. undefined — DEFAULT_ROLES. */
  roles?: Role[]
  /** Колонки доски в порядке показа. undefined — DEFAULT_COLUMNS. */
  columns?: BoardColumn[]
  /**
   * Правила проекта для агентов доски (markdown): блок «Правила проекта» в системном промпте воркеров всех ролей
   * и координатора (`withAgentRules`). Не попадают в CLAUDE.md/AGENTS.md и обычные сессии агентов.
   * Пусто — поля нет. Правила отдельной роли — её `systemPrompt`.
   */
  agentRules?: string
  /** Воркфлоу задач проекта. undefined — дефолтный граф по ролям проекта (`workflow.default(roles)`). */
  workflow?: Workflow
}

/** Настройки по умолчанию, копируемые в каждый новый проект. */
export interface ProjectDefaults {
  permissionMode: PermissionMode
  /** undefined — все установленные агенты. */
  enabledAgents?: AgentKind[]
  roles: Role[]
  columns: BoardColumn[]
  /** Правила проекта для агентов доски, копируются в новый проект; пусто — поля нет. */
  agentRules?: string
  /** Воркфлоу для новых проектов; нет — дефолтный граф по ролям проекта. В `setDefaults` null удаляет поле. */
  workflow?: Workflow
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
    add(): Promise<Project | null>
    remove(id: string): Promise<void>
    setActive(id: string): Promise<Project>
    setPermissionMode(id: string, mode: PermissionMode): Promise<Project>
    setEnabledAgents(id: string, agents: AgentKind[]): Promise<Project>
    setRoles(id: string, roles: Role[]): Promise<Project>
    /** Задачи из удалённых колонок переезжают в backlog. */
    setColumns(id: string, columns: BoardColumn[]): Promise<Project>
    /** Правила проекта для агентов доски (`Project.agentRules`); не заданы — ''. */
    getAgentRules(id: string): Promise<string>
    /** Сохранить правила проекта как введены; из одних пробелов — поле удаляется. Применяются при следующем запуске агента. */
    setAgentRules(id: string, text: string): Promise<Project>
    /**
     * Сохранить воркфлоу проекта (`Project.workflow`); null — вернуть дефолтный. Граф с ошибками
     * `validateWorkflow` отвергается с их текстом, предупреждения не мешают.
     */
    setWorkflow(id: string, wf: Workflow | null): Promise<Project>
    /** Глобальный дефолт для новых проектов (незаданное — встроенные значения). */
    getDefaults(): Promise<ProjectDefaults>
    /** Мерж патча в дефолт; роли/колонки валидируются, мусор — ошибка. enabledAgents: undefined — «все установленные». */
    setDefaults(patch: Partial<ProjectDefaults>): Promise<ProjectDefaults>
    /** Переписать настройки проекта дефолтом; задачи из исчезнувших колонок — в backlog. */
    applyDefaults(id: string): Promise<Project>
    /** Клик по уведомлению: показать этот проект. */
    onFocus(cb: (projectId: string) => void): () => void
  }
  workflow: {
    /** Дефолтный граф для этих ролей (`defaultWorkflow` в core): показать, когда `Project.workflow` не задан. */
    default(roles: Role[]): Promise<Workflow>
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
  }
  tasks: {
    /** Без roleId — единственная роль проекта, иначе ошибка. Задача попадает во «Входящие» (см. globalTasks). */
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
