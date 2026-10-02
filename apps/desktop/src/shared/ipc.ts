import type { PtySpawnOptions, TerminalRole, TerminalInfo, TerminalSnapshot, AppLanguage, PermissionMode, OnboardingState, OnboardingCompleteInput, ProjectGroup, ProjectBranchInfo, InitialCommitMode, ProjectLocalBranch, ProjectBranchUpstream, ProjectBranchList, ProjectGitResult, ProjectGitErrorCode, Project, TaskPatch, GlobalTaskInput, GlobalTaskPatch, SubtaskInput, TaskTypeInput, TaskTypePatch, NodeTemplateInput, TaskTypesState, ProjectTaskTypesInput, TaskTypeDetection, ReviewInfo, RequestListOptions, RequestResolveResult, RequestFocus, ProjectFileKind, ProjectFileEntry, ProjectFilesListing, ProjectFilesErrorCode, DocFile, ShowcaseFileData, ShowcasePreviewUrl, ShowcasePreviewOptions, DocGroup, DocStub, DocView, DocViewOptions, DocBytes, DocPreviewUrl, DocViewErrorCode, AttachmentCapabilities, RuleFileName, RuleFile, AssistantChatRole, AssistantChatStatus, AssistantChatToolCall, AssistantChatMessage, AssistantChatSnapshot, AssistantChatUpdate } from '@orca-board/contracts'
export * from '@orca-board/contracts'

import type { WorkflowAssistantContext, WorkflowAssistantSaved } from './assistant-workflow'
import type { Task, AttachmentInput, AgentKind, AssistantSettings, AgentInfo, StoreSnapshot, Role, BoardColumn, Run, GlobalTask, BuiltinPrompts, AnswerAudience, TaskPriority, HumanRequest, RequestResolution, Workflow, TaskType, TaskTypeSettings, ProjectStats, StatsRange, TaskStats, GlobalTaskStats, WfMigrationNote, WfNodeTemplate, WfTemplateNode } from '@orca-board/core'
import type { NotificationSettings, NotificationSettingsPatch } from './notifications'
import type { WindowChromeMode } from './window-chrome'
import type { AppearanceSettings } from './appearance'
import type { ConversationStatus, ConversationMessage, ConversationToolCall, ConversationInteraction, InteractionAnswer } from './assistant-conversation'
import type { DocViewKind } from './docs-view'
export type { ConversationInteraction, InteractionAnswer } from './assistant-conversation'

/** Глобальные настройки приложения (не проекта). */
export interface AppSettings {
  /** Закрытие окна не завершает приложение: PTY живут, иконка в трее. По умолчанию true. */
  keepInBackground: boolean
  /** Язык интерфейса; не выбран — русский (язык системы не угадываем, см. `settingsLocale`). */
  language?: AppLanguage
  /** Тема и движение; поле отсутствует у старого main. */
  appearance?: AppearanceSettings
  /** Системные уведомления: фильтры по ролям, видам событий, тихие часы. */
  notifications: NotificationSettings
  /** Автообновление приложения (docs/architecture.md → «Обновление»). */
  updates: UpdateSettings
  /**
   * Ассистент доски: агент, модель, effort, инструкции. Не роль типа задачи — ассистент один на приложение.
   * Применяется к следующему запуску («Новый диалог»), живой ассистент не перезапускается.
   */
  assistant: AssistantSettings
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

/** Патч настроек приложения: notifications, updates и assistant мержатся по полям. */
export interface AppSettingsPatch {
  keepInBackground?: boolean
  language?: AppLanguage
  appearance?: Partial<AppearanceSettings>
  notifications?: NotificationSettingsPatch
  updates?: Partial<UpdateSettings>
  /**
   * Пустая строка в model/effort/systemPrompt/extraArgs очищает поле; смена агента без model/effort/extraArgs
   * сбрасывает их. `extraArgs` — строка как введена, невалидную (`parseExtraArgs`) main отвергает.
   */
  assistant?: Partial<AssistantSettings>
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

export const PERMISSION_MODES: Record<PermissionMode, string> = {
  auto: 'Авто — агент работает самостоятельно, при необходимости спросит',
  bypassPermissions: 'Без подтверждений — полностью автономно',
  acceptEdits: 'Только правки файлов — остальное спросит в терминале'
}

/** Итог «Экспорта типа»: куда сохранён файл. Диалог закрыли — вместо результата null. */
export interface TaskTypeExportResult {
  path: string
}

/** Контракт между renderer и main. Реализуется в preload как window.orca. */
/** Команды системного меню; навигация выполняется в существующем интерфейсе. */
export type AppMenuAction = 'settings' | 'checkUpdates' | 'addProject'

/** Только данные меню: команды остаются в main, renderer не получает роли или внешние адреса для вызова. */
export interface AppMenuItem {
  id: string
  label: string
  hint?: string
  disabled?: boolean
  separatorBefore?: boolean
  children?: AppMenuItem[]
}

export interface OrcaApi {
  app: {
    /** Режим рамки этого окна; нет в старом preload. Read-only, без IPC управления окном. */
    readonly windowChrome?: WindowChromeMode
    info(): Promise<{ socketPath: string; active: Project | null; projects: Project[] }>
    getSettings(): Promise<AppSettings>
    /** Мерж патча в глобальные настройки; возвращает итоговые. */
    setSettings(patch: AppSettingsPatch): Promise<AppSettings>
    /** Показать тестовое уведомление в обход фильтров (кроме звука и превью). */
    testNotification(): Promise<void>
    /** Авторское меню Windows: локализованный снимок и вызов разрешённой команды; нет в старом preload. */
    getMenu?(): Promise<AppMenuItem[]>
    invokeMenu?(id: string): Promise<void>
    /** Закрывает режим меню и возвращает обработку нативных сочетаний. */
    dismissMenu?(): Promise<void>
    /** Текущее состояние и переходы fullscreen; WCO Windows сохраняет visible даже без caption-кнопок. */
    onWindowFullscreen?(cb: (fullscreen: boolean) => void): () => void
    /** Опционально для старого preload; подписка также сообщает main, что интерфейс готов к команде. */
    onMenuAction?(cb: (action: AppMenuAction) => void): () => void
    /**
     * Что-то в общих данных приложения изменилось: настройки, список/группы проектов, библиотека типов задач
     * и её роли, шаблоны нод — независимо от источника (это же окно через IPC, или CLI/ассистент через сокет).
     * Без payload — по получении перечитать своё (`projects.list`, `taskTypes.list`, `nodeTemplates.list`,
     * `app.getSettings`), как после собственного действия. Опциональный: нет у старого preload — renderer просто
     * не подписывается, правки из сокета отразятся после перезапуска (как раньше).
     */
    onChanged?(cb: () => void): () => void
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
    /** `groups` — группы проектов в порядке показа; групп нет — пустой массив. */
    list(): Promise<{ active: Project | null; projects: Project[]; groups: ProjectGroup[] }>
    /** Задачи в колонках kind=in_progress по id проекта — для бейджа в списке проектов. */
    inProgressCounts(): Promise<Record<string, number>>
    /**
     * Текущая git-ветка корня проекта `id` (не обязательно активного). Не бросает для не-репозитория —
     * это `{isGitRepo: false}`; неизвестный id — ошибка. Читается по запросу: ветку меняют снаружи приложения,
     * поэтому renderer перезапрашивает её при смене проекта и фокусе окна.
     */
    branch(id: string): Promise<ProjectBranchInfo>
    /**
     * Git корня проекта `id`: канал `projects:branches`. Ветки, текущая, upstream с ahead/behind и «грязное дерево» —
     * всё локально, без сети (remote-ветки — по последнему `fetch`). Не репозиторий — `isGitRepo: false`, не бросает;
     * неизвестный проект — ошибка. Нет у старого main/preload — renderer показывает «перезапустите приложение».
     */
    branches?(id: string): Promise<ProjectBranchList>
    /**
     * `git fetch --all --prune` в корне проекта: канал `projects:gitFetch`. Рабочее дерево и HEAD не меняет, поэтому
     * доступен и при живых воркерах и грязном дереве. Ошибки — `git.notRepo`, `git.opFailed` (нет сети, remote
     * не отвечает, таймаут). Нет у старого main/preload — «перезапустите приложение».
     */
    gitFetch?(id: string): Promise<ProjectGitResult>
    /**
     * `git pull --ff-only` текущей ветки корня: канал `projects:gitPull`. Ошибки — `git.notRepo`, `git.noUpstream`,
     * `git.notFastForward`, `git.opFailed` (в том числе когда правки в дереве мешают обновлению). Живых воркеров не
     * проверяет: ветку корня двигают вперёд, worktree'ы воркеров не затрагиваются. Нет у старого main/preload —
     * «перезапустите приложение».
     */
    gitPull?(id: string): Promise<ProjectGitResult>
    /**
     * Переключить корень проекта на ветку: канал `projects:checkoutBranch`. `branch` — локальная (`main`) или
     * удалённая из `ProjectBranchList.remote` (`origin/x`: создаётся локальная `x` с tracking; локальная `x` уже есть —
     * переключение на неё). Возвращает состояние HEAD после переключения. Ошибки — `git.notRepo`, `git.branchNotFound`,
     * `git.dirtyTree`, `git.branchBusy`, `git.workersActive`, `git.opFailed`. Ветка та же, что текущая, — не ошибка.
     * Нет у старого main/preload — «перезапустите приложение».
     */
    checkoutBranch?(id: string, branch: string): Promise<ProjectBranchInfo>
    /**
     * Создать начальный коммит в репозитории корня без коммитов (unborn HEAD): канал `projects:createInitialCommit`.
     * Вызывается только по согласию человека после ошибки запуска `git.noCommits`. Идемпотентен: коммиты уже есть —
     * возвращает актуальное состояние HEAD без изменений. Ошибки — `git.notRepo`, `git.opFailed`.
     * Нет у старого main/preload — «перезапустите приложение».
     */
    createInitialCommit?(id: string, mode: InitialCommitMode): Promise<ProjectBranchInfo>
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
     * Новая группа в конце списка. Имя обрезается по краям; пустое — `OrcaError` `projects.groupNameEmpty`.
     * Одинаковые имена допустимы: группа определяется по `id`.
     */
    createGroup(name: string): Promise<ProjectGroup>
    /** Переименовать группу. Пустое имя — `projects.groupNameEmpty`, неизвестный `id` — `projects.groupNotFound`. */
    renameGroup(id: string, name: string): Promise<ProjectGroup>
    /**
     * Удалить группу. Её проекты не удаляются — они становятся проектами без группы (`groupId` снимается).
     * Неизвестный `id` — `projects.groupNotFound`.
     */
    removeGroup(id: string): Promise<void>
    /** Свернуть или развернуть группу в меню; состояние переживает перезапуск. Неизвестный `id` — `projects.groupNotFound`. */
    setGroupCollapsed(id: string, collapsed: boolean): Promise<ProjectGroup>
    /**
     * Положить проект в группу; `null` — вынуть из группы (проект без группы). Неизвестный проект — обычная ошибка
     * «project not found», неизвестная группа — `projects.groupNotFound`. Возвращает обновлённый проект.
     */
    setProjectGroup(projectId: string, groupId: string | null): Promise<Project>
    /**
     * Задать порядок групп: `ids` — все id групп в новом порядке. Набор должен совпадать с существующим (лишний или
     * пропущенный id — `projects.groupNotFound`). Возвращает группы в новом порядке.
     */
    reorderGroups(ids: string[]): Promise<ProjectGroup[]>
    /** Клик по уведомлению: показать этот проект. */
    onFocus(cb: (projectId: string) => void): () => void
  }
  /**
   * Типы задач (docs/architecture.md → «Типы задач»): тип выбирается у глобальной задачи и задаёт её роли,
   * воркфлоу, правила агентов и разрешения. Все типы равны: заготовки из приложения кладутся в библиотеку один раз
   * и дальше правятся и удаляются, как созданные человеком.
   */
  taskTypes: {
    patch(id: string, patch: TaskTypePatch): Promise<TaskType>
    rename(id: string, title: string, description: string): Promise<TaskType>
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
    /** Диалог «Сохранить как» и запись файла типа целиком (формат — core/task-type-file.ts); закрыли диалог — null. */
    export(id: string): Promise<TaskTypeExportResult | null>
  }
  /**
   * Библиотека шаблонов нод (docs/architecture.md → «Шаблоны нод»): глобальная, общая для всех типов задач. Вставка
   * в граф — копия ноды с `templateId`, поэтому у прогонов ничего не меняется при правке или удалении шаблона.
   * Нет у старого preload — renderer показывает «перезапустите приложение».
   */
  nodeTemplates: {
    /** Все шаблоны в порядке хранения (битые записи файла при загрузке пропущены). */
    list(): Promise<WfNodeTemplate[]>
    /** Создать или заменить шаблон; негодный (`validateNodeTemplate`) — ошибка `nodeTemplate.notSaved`. */
    save(input: NodeTemplateInput): Promise<WfNodeTemplate>
    /** Удалить шаблон (нет такого — `nodeTemplate.notFound`); возвращает оставшиеся. */
    delete(id: string): Promise<WfNodeTemplate[]>
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
    /**
     * Создать глобальную задачу. `images` — вложения (картинки и любые файлы), приложенные человеком в `GlobalTaskModal`:
     * отдельным аргументом, а не полем `GlobalTaskInput`, чтобы байты не смешивались с JSON-описанием карточки (так же
     * устроен `coordinator:start`). Main проверяет их `validateAttachments` (любой тип, картинка — по сигнатуре;
     * `ATTACHMENT_LIMITS`: ≤ 8 шт., ≤ 25 МБ каждый, ≤ 50 МБ всего на задачу), сохраняет файлы и кладёт
     * метаданные в `Run.images`. Невалидное вложение — ошибка, задача при этом **не создаётся**.
     * Без `images` (и у старого renderer) поведение прежнее.
     */
    create(input: GlobalTaskInput, images?: AttachmentInput[]): Promise<GlobalTask>
    update(id: string, patch: GlobalTaskPatch): Promise<GlobalTask>
    /**
     * Сменить тип задачи (`typeId` из типов проекта) — только до начала работы (`canChangeRunType` из core):
     * в бэклоге, ни разу не была «В работе», без координатора и подзадач; иначе и для «Входящих» — ошибка.
     */
    changeType(id: string, typeId: string): Promise<GlobalTask>
    /**
     * Добавить вложения к существующей задаче. Лимиты `ATTACHMENT_LIMITS` действуют на задачу
     * **суммарно**: уже сохранённые (`GlobalTask.images`) плюс новые; превышение количества или общего размера,
     * пустой файл, пустой массив — ошибка, ничего не сохраняется (всё или ничего).
     * Править картинки можно только до начала работы — то же правило, что у `changeType` (`canChangeRunType` /
     * `runTypeLockReason` из core: бэклог, ни разу не «В работе», без координатора и подзадач); «Входящие» —
     * ошибка. Позже картинку можно приложить только при запуске координатора (`startCoordinator(..., images)`),
     * но в задаче она не сохранится. Возвращает обновлённую карточку.
     */
    addImages(id: string, images: AttachmentInput[]): Promise<GlobalTask>
    /**
     * Удалить картинку задачи (метаданные и файл). Правило то же, что у `addImages`; нет задачи или картинки
     * с таким `imageId` — ошибка. Возвращает обновлённую карточку.
     */
    removeImage(id: string, imageId: string): Promise<GlobalTask>
    /**
     * Байты картинки для превью в renderer (`blob:` URL, CSP `img-src 'self' blob:`). `mime` — из метаданных
     * (`RunImage.mime`). Доступно в любом статусе задачи, пока картинка есть; нет задачи, картинки или файла
     * на диске — ошибка.
     */
    image(id: string, imageId: string): Promise<{ mime: string; data: Uint8Array }>
    /**
     * Показать файл вложения задачи в папке системы (`shell.showItemInFolder`) — только вложение из метаданных
     * задачи (`GlobalTask.images`), путь строит main. Сам файл приложение не открывает и не запускает.
     * Пока main не принимает файлы (`attachments.capabilities().files === false`), вызов — ошибка; старый main —
     * «No handler registered»: renderer проверяет наличие метода и просит перезапустить приложение.
     */
    revealAttachment(id: string, imageId: string): Promise<void>
    /**
     * Открыть вложение задачи приложением системы (`shell.openPath`) — только расширения из белого списка
     * (`attachmentOpenable` в `shared/showcase.ts`: картинки, Markdown, PDF; без HTML и SVG). Остальное —
     * `global.attachmentNotOpenable`: исполняемый файл приложение не запускает. Старый main — «No handler registered».
     */
    openAttachment(id: string, imageId: string): Promise<void>
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
     *
     * Картинки: координатору передаются **сохранённые картинки задачи** (`GlobalTask.images`) и `images` этого
     * вызова (вставленные в момент запуска) — одним списком, сохранённые первыми, с абсолютными путями в промпте
     * (`coordinatorPrompt`, как в `coordinator:start`). Так же — при повторных запусках и в `returnToWork`, где
     * отдельного аргумента нет: там уходят только сохранённые. Суммарно те же `ATTACHMENT_LIMITS`;
     * превышение (сохранённые + пришедшие) — ошибка запуска до старта агента. Пришедшие в `images` в задачу
     * не сохраняются — для этого есть `addImages`.
     */
    startCoordinator(id: string, cols: number, rows: number, images?: AttachmentInput[]): Promise<string>
    /**
     * «Подтвердить» на «Проверке»: из колонки kind=review в done, событий нет. Не на проверке — ошибка.
     * У прогона с воркфлоу (`workflowScope: 'run'`) это решение по approval ноды `human`, а `decision` — поле
     * «Решение / что делать дальше» (получит координатор в следующем этапе); у прогона старого формата не используется.
     */
    accept(id: string, decision?: string): Promise<GlobalTask>
    /**
     * «Вернуть в работу» с «Проверки» с уточнением (`text` обязателен): задача — в работу, координатор
     * запускается повторно и получает уточнение в цели и сохранённые картинки задачи. Возвращает ptyId координатора.
     * `images` — картинки к уточнению (байты, как у `startCoordinator`): main проверяет их и сохраняет в cwd координатора.
     */
    returnToWork(id: string, text: string, cols: number, rows: number, images?: AttachmentInput[]): Promise<string>
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
     * `images` — картинки к «Уточнить»/«Вернуть» (байты): main проверяет их, сохраняет в cwd читателя и сам ставит
     * `resolution.images` (пути). `resolution.images` из renderer main отбрасывает.
     */
    resolve(id: string, resolution: RequestResolution, images?: AttachmentInput[]): Promise<RequestResolveResult>
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
     * Запуск координатора. `images` — приложенные картинки и файлы: main проверяет их
     * (`validateAttachments`), сохраняет файлами на время прогона и передаёт агенту пути.
     * Пустая цель допустима только с вложениями (тогда цель — `DEFAULT_ATTACHMENT_OBJECTIVE`).
     */
    start(objective: string, cols: number, rows: number, images?: AttachmentInput[]): Promise<string>
  }
  /** Ассистент доски активного проекта (skills/assistant.md): интерактивный агент, действует через orca-board. */
  assistant: {
    /** Терминал ассистента: живой — тот же, иначе запускается новый. */
    open(cols: number, rows: number): Promise<{ ptyId: string }>
    /** Закрыть терминал ассистента (если жив) и запустить новый — чистый контекст. */
    reset(cols: number, rows: number): Promise<{ ptyId: string }>
  }
  /** Двусторонний чат ассистента; Amp/Shell открываются отдельным терминалом. */
  assistantChat: {
    available(ptyId: string): Promise<boolean>
    getMessages(ptyId: string): Promise<AssistantChatSnapshot>
    send(ptyId: string, text: string): Promise<void>
    sendWithWorkflow?(ptyId: string, text: string, context: WorkflowAssistantContext): Promise<void>
    interrupt(ptyId: string): Promise<void>
    respond(ptyId: string, requestId: string, answer: InteractionAnswer): Promise<void>
    onMessage(ptyId: string, cb: (u: AssistantChatUpdate) => void): () => void
  }
  workflowAssistant: {
    save(typeId: string, baseline: Workflow, workflow: Workflow | null): Promise<void>
    onSaved(cb: (saved: WorkflowAssistantSaved) => void): () => void
  }
  /**
   * «Документы»: файлы активного проекта и `.md` worktree его задач в работе (docs/architecture.md → «IPC: документы»).
   * `source` — `'project'` или id задачи в работе (иначе `docs.noTaskSource`); путь — только относительный, через `/`,
   * внутри источника, без `.git`. Отказы пути — `PROJECT_FILES_ERROR_CODES`, новых каналов — `DOC_VIEW_ERROR_CODES`;
   * узнавать по `ipcErrorCode`, не по тексту.
   */
  docs: {
    /** Группа `project` — все файлы проекта (уважая `.gitignore`), группы задач — только `.md`. Старый main и в `project` отдаёт только `.md`. */
    list(): Promise<DocGroup[]>
    /** Содержимое .md (не больше 2 МБ); путь вне источника, симлинк наружу, не-.md — ошибка. Для любых файлов — `view`. */
    read(source: string, path: string): Promise<string>
    /**
     * Как показать файл и его текст (`DocView`). Бинарь, не UTF-8, слишком большой и PDF — не ошибка, а `stub`.
     * Не файл (папка, FIFO) — `files.notFile`. Появился позже остальных: нет в старом preload, а старый main отвечает
     * «No handler registered for 'docs:view'» — проверяй наличие и показывай «перезапустите приложение».
     */
    view?(source: string, path: string, opts?: DocViewOptions): Promise<DocView>
    /** Байты картинки (`kind: 'image'`) не больше `DOC_IMAGE_MAX_BYTES`; не картинка — `docs.noPreview`. Совместимость — как у `view`. */
    bytes?(source: string, path: string): Promise<DocBytes>
    /**
     * Адрес `orca-preview://` на корень источника, **всегда без сети** (параметра нет намеренно: HTML проекта —
     * недоверенный код). `url` — страница для `<iframe sandbox="allow-scripts">` (HTML), `base` — для относительных
     * картинок markdown. Не html/markdown или путь со скрытым сегментом — `docs.noPreview`. Совместимость — как у `view`.
     */
    previewUrl?(source: string, path: string): Promise<DocPreviewUrl>
    /**
     * Открыть файл приложением системы по умолчанию: только расширения `SHOWCASE_FILE_TYPES`, проверка и по пути, и по
     * цели симлинка; иначе `docs.notOpenable` (`.sh`, `.app`, `.command` не запускаются никогда). Старый main открывает только `.md`.
     */
    open(source: string, path: string): Promise<void>
    /** Показать любой файл источника в Finder/Проводнике; симлинк — сам симлинк, не цель. Ничего не запускает. Старый main — только `.md`. */
    reveal(source: string, path: string): Promise<void>
  }
  /**
   * Файлы показа человеку (`Dispatch.showcase`, `HumanRequest.showcaseDispatchId(s)`) задачи `taskId` активного
   * проекта. `path` — как в `showcase.files` (от корня репозитория). `dispatchId` — чей показ: со снимком
   * (`showcase.snapshot`) файлы читаются из него, без — из worktree задачи. Путь вне корня, симлинк наружу,
   * расширение не из `SHOWCASE_FILE_TYPES` (`shared/showcase.ts`), запуск чужой задачи, нет ни снимка, ни worktree — ошибка.
   */
  showcase: {
    /** Байты для превью: только `preview: 'image' | 'markdown'`, не больше `SHOWCASE_READ_MAX_BYTES`. HTML — только `previewUrl`. */
    read(taskId: string, path: string, dispatchId?: string): Promise<ShowcaseFileData>
    /** Открыть файл приложением системы по умолчанию (HTML — в браузере). */
    open(taskId: string, path: string, dispatchId?: string): Promise<void>
    /** Показать файл в Finder/Проводнике. */
    reveal(taskId: string, path: string, dispatchId?: string): Promise<void>
    /**
     * Адрес страницы показа для `<iframe sandbox="allow-scripts">`: HTML, картинки и SVG из снимка запуска `dispatchId`;
     * у markdown — ради `base` (относительные картинки). PDF — отказ (пока только «Открыть»). Появился позже остальных: в старом preload метода нет — проверяй перед вызовом.
     */
    previewUrl(dispatchId: string, path: string, opts?: ShowcasePreviewOptions): Promise<ShowcasePreviewUrl>
    /**
     * База `orca-preview://<токен>/` для относительных картинок описания показа (`showcase.text`) запуска `dispatchId`:
     * пути в описании — от корня репозитория, картинки снимаются при `done`. Всегда без сети. `null` — ни снимка, ни
     * worktree. Для `Markdown` — `assets: { path: 'showcase.md', base }` (описание — как файл в корне). Появился позже
     * `previewUrl`: в старом preload метода нет — проверяй перед вызовом.
     */
    previewBase(dispatchId: string): Promise<string | null>
    /**
     * Esc нажат, пока фокус может быть во фрейме показа (событие `showcase:escape` из `before-input-event` окна): DOM
     * родителя keydown из фрейма другого origin не получает. Приходит на каждый Esc — закрывай просмотрщик, только
     * если `document.activeElement` — фрейм, и делай закрытие идемпотентным: при фокусе в самом окне придёт ещё и обычный
     * keydown. В старом preload метода нет — проверяй перед подпиской.
     */
    onFrameEscape(cb: () => void): () => void
  }
  /**
   * Папки корня проекта `projectId`, только чтение. Вкладки «Файлы» больше нет (все файлы — в «Документах», `docs:*`):
   * `files:list` нужен диалогу начального коммита (`.gitignore` в корне). `projectId` явный, а не «активный проект»:
   * пока запрос идёт в main, человек может переключить проект, и ответ был бы про чужой репозиторий. Коды отказов —
   * `PROJECT_FILES_ERROR_CODES`. `files:open` нет намеренно: запуск произвольного файла системой опасен (политика
   * `shared/showcase.ts`); `.md` открываются в «Документах». Появился позже остальных: в старом preload нет — проверяй перед вызовом.
   */
  files: {
    /** Содержимое одной папки корня проекта `projectId`; `dir` опущен или '' — корень. Игнорируемое git'ом и `.git` не отдаётся. */
    list(projectId: string, dir?: string): Promise<ProjectFilesListing>
    /** Показать запись (файл, папку, симлинк — сам симлинк) в Finder/Проводнике. Ничего не открывает и не запускает. */
    reveal(projectId: string, path: string): Promise<void>
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
    /** `images` — картинки к замечаниям (байты): main проверяет их и сохраняет в worktree задачи (или cwd координатора у проверки ветки). */
    reject(taskId: string, feedback: string, images?: AttachmentInput[]): Promise<void>
  }
  /**
   * Картинки к замечаниям при возврате в работу. Только рукопожатие: «новый preload + старый main» молча
   * отбросил бы лишний аргумент `images`, и картинка пропала бы без ошибки — renderer перед показом «Приложить»
   * зовёт `ping()` и при отсутствии метода/хендлера просит перезапустить приложение.
   */
  attachments: {
    ping(): Promise<true>
    /**
     * Что принимает main: `files: false` — только картинки PNG/JPEG/GIF/WebP (main до перехода на вложения-файлы),
     * `true` — любые файлы. `limits` — лимиты, которые main проверяет на самом деле. Нет метода или хендлера —
     * старый preload/main: режим «только картинки» с прежними лимитами.
     */
    capabilities(): Promise<AttachmentCapabilities>
  }
}
