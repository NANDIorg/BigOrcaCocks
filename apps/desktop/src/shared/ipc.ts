import type { Task, ImageAttachmentInput, AgentKind, AgentInfo, StoreSnapshot, Role, BoardColumn, Run, GlobalTask, BuiltinPrompts, AnswerAudience, TaskPriority, HumanRequest, RequestResolution, Workflow, TaskType, TaskTypeSettings, ProjectStats, StatsRange, TaskStats, GlobalTaskStats, RunBranchSettings } from '@orca-board/core'
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

/** Язык интерфейса (renderer/src/i18n). */
export type AppLanguage = 'ru' | 'en'

/** Глобальные настройки приложения (не проекта). */
export interface AppSettings {
  /** Закрытие окна не завершает приложение: PTY живут, иконка в трее. По умолчанию true. */
  keepInBackground: boolean
  /** Язык интерфейса; не выбран — русский (язык системы не угадываем, см. `settingsLocale`). */
  language?: AppLanguage
  /** Системные уведомления: фильтры по ролям, видам событий, тихие часы. */
  notifications: NotificationSettings
  /** Автообновление приложения (docs/architecture.md → «Обновление»). */
  updates: UpdateSettings
}

/** Настройки автообновления. Дефолты — `DEFAULT_UPDATE_SETTINGS`. */
export interface UpdateSettings {
  /** Проверять наличие новой версии в фоне (при старте и раз в несколько часов). По умолчанию true. */
  autoCheck: boolean
  /** Скачивать найденную версию сразу, без клика. По умолчанию true. */
  autoDownload: boolean
  /**
   * Ставить скачанное обновление, когда у агентов не осталось живых сессий (а не только при выходе).
   * По умолчанию false: без явного решения человека приложение само не перезапускается.
   */
  installWhenIdle: boolean
}

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = { autoCheck: true, autoDownload: true, installWhenIdle: false }

/** Патч настроек приложения: notifications и updates мержатся по полям. */
export interface AppSettingsPatch {
  keepInBackground?: boolean
  language?: AppLanguage
  notifications?: NotificationSettingsPatch
  updates?: Partial<UpdateSettings>
}

/** Способ обновления на этой платформе. */
export type UpdateMode =
  /** Скачивание и установка внутри приложения (Windows NSIS — electron-updater, macOS — свой установщик). */
  | 'auto'
  /** Установить не можем (portable Windows): показываем версию и ссылку `releaseUrl`, человек скачивает сам. */
  | 'manual-download'

/** Почему обновление недоступно (`UpdateState.status === 'unsupported'`). */
export type UpdateUnsupportedReason =
  /** Запуск из исходников/`pnpm dev` (`!app.isPackaged`). */
  | 'dev'
  /** Portable-сборка Windows: заменить exe на ходу нельзя. Состояние — `unsupported`, `mode: 'manual-download'`. */
  | 'portable'
  /** macOS: приложение запущено не из /Applications (например, прямо из dmg или Загрузок). */
  | 'not-in-applications'
  /** macOS: у пользователя нет прав на запись в папку с приложением. */
  | 'no-write-access'
  /** macOS: App Translocation — система запустила копию из read-only образа, подменять нечего. */
  | 'translocated'
  /** Для этой платформы установщика нет (Linux). */
  | 'platform'

/** Что известно о новой версии; отдаёт `PlatformUpdater.check()`. */
export interface UpdateInfo {
  /** Версия без префикса `v` (semver), например `0.4.2`. */
  version: string
  /** Заметки релиза, markdown (тело GitHub Release); нет — пустая строка. */
  releaseNotes: string
  /** Страница релиза на GitHub — для «что нового» и для `manual-download`. */
  releaseUrl: string
}

/**
 * Состояние обновления — машина состояний в main (`main/updater.ts`), единственный источник правды.
 * Переходы: idle → checking → (idle | available | error); available → downloading → (ready | error);
 * ready → installing → перезапуск. `unsupported` — терминальное: проверки и загрузка ничего не делают.
 */
export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error'
  | 'unsupported'

export interface UpdateState {
  status: UpdateStatus
  /** Версия запущенного приложения (`app.getVersion()`). */
  currentVersion: string
  /** Найденная версия; null, пока проверка не нашла новой. Сохраняется в downloading/ready/installing/error после находки. */
  availableVersion: string | null
  /** Заметки найденной версии, markdown; null, если версии нет. */
  releaseNotes: string | null
  /** Страница релиза; null, если версии нет. */
  releaseUrl: string | null
  /** Прогресс скачивания 0–100; только при `downloading`, иначе null. */
  percent: number | null
  /**
   * Отложенная установка: `'quit'` — при выходе из приложения, `'idle'` — когда у агентов не останется живых сессий
   * (ставит `install({when})` или `settings.updates.installWhenIdle`); null — ничего не запланировано.
   */
  installPending: 'idle' | 'quit' | null
  /** Способ обновления на этой платформе. */
  mode: UpdateMode
  /** Причина, только при `status === 'unsupported'`. */
  unsupportedReason: UpdateUnsupportedReason | null
  /** Текст ошибки по-русски, только при `status === 'error'`; иначе null. */
  error: string | null
}

/** Когда ставить скачанное обновление (`updates.install`). */
export type UpdateInstallWhen =
  /** Выйти и установить сейчас (с обычным подтверждением выхода, если работают агенты). */
  | 'now'
  /** Когда у агентов не останется живых сессий. */
  | 'idle'
  /** При следующем выходе из приложения. */
  | 'quit'

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
 * Текущая git-ветка корня проекта (`projects:branch`). Ровно одно из состояний:
 * `isGitRepo: false` — не репозиторий (или git недоступен), `branch`/`detached` пусты;
 * `detached: true` — detached HEAD, `branch: null`, `sha` — короткий хеш коммита;
 * иначе `branch` — имя ветки (у репозитория без коммитов — имя будущей ветки).
 */
export interface ProjectBranchInfo {
  isGitRepo: boolean
  branch: string | null
  detached: boolean
  /** Короткий sha HEAD; только при `detached`. */
  sha?: string
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
  /** Ветки глобальных задач; нет — `DEFAULT_RUN_BRANCH_SETTINGS` (или main до этой настройки). */
  git?: RunBranchSettings
}

/** Создать (без `id`) или целиком заменить тип задачи. */
export interface TaskTypeInput {
  id?: string
  title: string
  description?: string
  settings: TaskTypeSettings
}

/** Вся библиотека типов в порядке хранения и тип библиотеки по умолчанию. */
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

/** Файл показа для превью (`showcase:read`): mime по расширению и содержимое. */
export interface ShowcaseFileData {
  mime: string
  bytes: Uint8Array
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

/** Текущая версия мастера первого запуска (main пишет её в projects.json, renderer сверяет). */
export const ONBOARDING_VERSION = 1

/** Состояние мастера первого запуска. Не входит в `AppSettings`: человек меняет его только через `onboarding:complete`. */
export interface OnboardingState {
  /** Мастер нужно показать при старте: статус `pending`. Новый main всегда отдаёт boolean. */
  required: boolean
  status: 'pending' | 'completed' | 'skipped'
  /** Версия мастера, с которой записан статус. */
  version: number
  /** Когда пройден/пропущен (мс); у `pending` нет. */
  at?: number
}

export interface OnboardingCompleteInput {
  /** true — «Пропустить» (status 'skipped'), иначе 'completed'. По умолчанию false. */
  skipped?: boolean
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
  /**
   * Мастер первого запуска (docs/architecture.md → «IPC»). Renderer читает `getState()` при старте и показывает
   * мастер, только если `required`. «Пройти заново» канала не требует — оно целиком на стороне renderer.
   */
  onboarding: {
    getState(): Promise<OnboardingState>
    /** Записать прохождение/пропуск. Повторный вызов на пройденном — идемпотентен (статус не понижается до pending). */
    complete(input?: OnboardingCompleteInput): Promise<OnboardingState>
  }
  /**
   * Обновление приложения (docs/architecture.md → «Обновление»). Состояние живёт в main; renderer читает
   * `getState()` при старте и дальше подписывается на `onChanged`. Все методы, кроме `getState`, возвращают
   * состояние после действия. В `unsupported` действия ничего не меняют (не бросают).
   */
  updates: {
    getState(): Promise<UpdateState>
    /** Проверить наличие новой версии сейчас (кнопка «Проверить»). Во время проверки/скачивания — no-op. */
    check(): Promise<UpdateState>
    /** Скачать найденную версию (нужна при `autoDownload: false`). Не в `available` — no-op. */
    download(): Promise<UpdateState>
    /** Установить скачанное: `now` — выйти и заменить, `idle` / `quit` — отложить (`installPending`). Не в `ready` — ошибка. */
    install(opts: { when: UpdateInstallWhen }): Promise<UpdateState>
    /** Снять отложенную установку (`installPending` → null). */
    cancelPending(): Promise<UpdateState>
    /**
     * Версия, с которой приложение только что обновилось, — чтобы показать «Обновлено до …»; null, если старт
     * обычный. Отдаётся один раз после старта: повторный вызов вернёт null.
     */
    getJustUpdated(): Promise<string | null>
    /** Состояние изменилось (в том числе прогресс скачивания). Всегда полное состояние. */
    onChanged(cb: (state: UpdateState) => void): () => void
  }
  projects: {
    list(): Promise<{ active: Project | null; projects: Project[] }>
    /** Задачи в колонках kind=in_progress по id проекта — для бейджа в списке проектов. */
    inProgressCounts(): Promise<Record<string, number>>
    /**
     * Текущая git-ветка корня проекта `id` (не обязательно активного). Не бросает для не-репозитория —
     * это `{isGitRepo: false}`; неизвестный id — ошибка. Читается по запросу: ветку меняют снаружи приложения,
     * поэтому renderer перезапрашивает её при смене проекта и фокусе окна.
     */
    branch(id: string): Promise<ProjectBranchInfo>
    /**
     * Добавить репозиторий с типом по умолчанию `typeId` (нет — тип библиотеки по умолчанию; id заготовок типов
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
    /**
     * Ветки глобальных задач: патч поверх текущих настроек. Ошибка шаблона, базы или remote — `OrcaError[git.badSettings]`.
     * Нет у старого preload — renderer показывает «перезапустите приложение».
     */
    setGit?(id: string, patch: Partial<RunBranchSettings>): Promise<Project>
    /** Клик по уведомлению: показать этот проект. */
    onFocus(cb: (projectId: string) => void): () => void
  }
  /**
   * Типы задач (docs/architecture.md → «Типы задач»): тип выбирается у глобальной задачи и задаёт её роли,
   * воркфлоу, правила агентов и разрешения. Все типы равны: заготовки из приложения кладутся в библиотеку один раз
   * и дальше правятся и удаляются, как созданные человеком.
   */
  taskTypes: {
    list(): Promise<TaskTypesState>
    /** Создать или заменить тип; настройки валидируются (граф — по ролям типа, колонки не проверяются). */
    save(input: TaskTypeInput): Promise<TaskType>
    /**
     * Удалить любой тип (последний — ошибка); после перезапуска он не вернётся. Прогоны удалённого типа дорабатывают
     * по своему снимку, проекты с ним по умолчанию — на типе библиотеки по умолчанию.
     */
    delete(id: string): Promise<TaskTypesState>
    /** Копия типа под новым id. */
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
    /**
     * Сменить тип задачи (`typeId` из типов проекта) — только до начала работы (`canChangeRunType` из core):
     * в бэклоге, ни разу не была «В работе», без координатора и подзадач; иначе и для «Входящих» — ошибка.
     */
    changeType(id: string, typeId: string): Promise<GlobalTask>
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
  /**
   * Файлы показа человеку (`Dispatch.showcase`, `HumanRequest.showcaseDispatchId`) из worktree задачи `taskId`
   * активного проекта. `path` — как в `showcase.files` (от корня репозитория). Путь вне worktree, симлинк наружу,
   * расширение не из `SHOWCASE_FILE_TYPES` (`shared/showcase.ts`), нет worktree — ошибка.
   */
  showcase: {
    /** Байты для превью: только `preview: 'image' | 'markdown'`, не больше `SHOWCASE_READ_MAX_BYTES`. */
    read(taskId: string, path: string): Promise<ShowcaseFileData>
    /** Открыть файл приложением системы по умолчанию (HTML — в браузере). */
    open(taskId: string, path: string): Promise<void>
    /** Показать файл в Finder/Проводнике. */
    reveal(taskId: string, path: string): Promise<void>
  }
  /** Правила активного проекта: CLAUDE.md и AGENTS.md в его корне (не в worktree задач). */
  rules: {
    /** Оба файла в порядке RULE_FILE_NAMES; отсутствующий — `exists: false`. */
    list(): Promise<RuleFile[]>
    /** Записать файл (создать, если нет) атомарно; имя не из белого списка — ошибка. */
    save(name: RuleFileName, text: string): Promise<RuleFile>
  }
  /** Статистика проекта (docs/architecture.md, «Статистика»): токены, стоимость, задачи, время агентов. */
  stats: {
    /**
     * Статистика проекта `projectId` (не обязательно активного) за период. Считается по запросу: снапшот store +
     * транскрипты агентов на диске. Неизвестный проект — ошибка. Токены, которых не нашли, — «неизвестно», не 0.
     */
    project(projectId: string, range: StatsRange): Promise<ProjectStats>
    /**
     * Статистика задачи за всё время жизни: время (колонки, этапы), расход сессий задачи и её проверок, ожидание
     * человека. Транскрипты других задач не читаются. Неизвестная задача — ошибка.
     */
    task(projectId: string, taskId: string): Promise<TaskStats>
    /** То же для глобальной задачи: подзадачи и координатор прогона раздельно. Неизвестный прогон — ошибка. */
    global(projectId: string, runId: string): Promise<GlobalTaskStats>
  }
  review: {
    info(taskId: string): Promise<ReviewInfo>
    /** `decision` — решение человека по задаче-ответу, уходит координатору в answer_accepted. */
    accept(taskId: string, decision?: string): Promise<void>
    reject(taskId: string, feedback: string): Promise<void>
  }
}
