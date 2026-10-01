import type { Task, ImageAttachmentInput, AgentKind, AssistantSettings, AgentInfo, StoreSnapshot, Role, BoardColumn, Run, GlobalTask, BuiltinPrompts, AnswerAudience, TaskPriority, HumanRequest, RequestResolution, Workflow, TaskType, TaskTypeSettings, ProjectStats, StatsRange, TaskStats, GlobalTaskStats, WfMigrationNote, WfNodeTemplate, WfTemplateNode } from '@orca-board/core'
import type { NotificationSettings, NotificationSettingsPatch } from './notifications'
import type { WindowChromeMode } from './window-chrome'
import type { AppearanceSettings } from './appearance'
import type { ConversationStatus, ConversationMessage, ConversationToolCall, ConversationInteraction, InteractionAnswer } from './assistant-conversation'
import type { DocViewKind } from './docs-view'
export type { ConversationInteraction, InteractionAnswer } from './assistant-conversation'

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
 * Группа проектов в левом меню. Необязательна: проект без группы (`Project.groupId` не задан) показывается в меню
 * как раньше. Порядок групп — порядок массива `projects.list().groups`; порядок проектов внутри группы — их порядок
 * в `projects`. Хранится в projects.json (`groups`), см. docs/architecture.md → «Проекты».
 */
export interface ProjectGroup {
  /** Стабильный идентификатор, его выдаёт main при `createGroup`. */
  id: string
  /** Название для показа; непустое, без пробелов по краям. Введено человеком — не переводится. */
  name: string
  /** Группа свёрнута в меню: проекты скрыты, заголовок виден. undefined — развёрнута. */
  collapsed?: boolean
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
  /** HEAD без коммитов. */
  unborn?: true
}

/**
 * Режим `projects:createInitialCommit`: `empty` — пустой коммит через plumbing, индекс и рабочее дерево не трогаются;
 * `snapshot` — `git add -A` и коммит текущего состояния рабочего дерева.
 */
export type InitialCommitMode = 'empty' | 'snapshot'

/** Локальная ветка в `ProjectBranchList.local`. */
export interface ProjectLocalBranch {
  /** Короткое имя (`feature/x`). */
  name: string
  /** Ветка, на которой стоит корень проекта. */
  current: boolean
  /** Ветка уже checked out в другом worktree (в том числе воркера Orca): `checkoutBranch` откажет `git.branchBusy`. У текущей — false. */
  busy: boolean
}

/** Upstream текущей ветки корня и расхождение с ним (по уже полученным refs — без сети). */
export interface ProjectBranchUpstream {
  /** Полное имя upstream: `origin/main`. */
  name: string
  /** Коммитов в локальной ветке, которых нет в upstream. */
  ahead: number
  /** Коммитов в upstream, которых нет в локальной ветке. */
  behind: number
  /** Upstream настроен, но ветки на remote больше нет (после `fetch --prune`): ahead/behind — 0. */
  gone: boolean
}

/**
 * Ветки корня проекта (`projects:branches`). Не репозиторий (или git недоступен) — `isGitRepo: false`,
 * `current` — как у `projects.branch`, списки пусты, `dirty: false`; метод для этого случая не бросает.
 */
export interface ProjectBranchList {
  isGitRepo: boolean
  /** Текущее состояние HEAD корня — то же, что вернул бы `projects.branch(id)`. */
  current: ProjectBranchInfo
  /** Локальные ветки, отсортированные по имени. */
  local: ProjectLocalBranch[]
  /**
   * Удалённые ветки по последнему `fetch`, полные имена `origin/x`, отсортированные; без `<remote>/HEAD`.
   * Их же принимает `checkoutBranch` (создаст локальную `x` с tracking).
   */
  remote: string[]
  /** Upstream текущей ветки; нет — ветка без upstream, detached HEAD или репозиторий без коммитов. */
  upstream?: ProjectBranchUpstream
  /** Есть незакоммиченные изменения в корне (`git status --porcelain` не пуст, untracked тоже): checkout откажет `git.dirtyTree`. */
  dirty: boolean
}

/** Итог `projects:gitFetch` / `projects:gitPull`. */
export interface ProjectGitResult {
  /** Краткий вывод git (stdout + stderr, без ANSI, обрезан до ~4000 символов); пустой, если git ничего не написал. */
  output: string
  /** Состояние HEAD корня после операции (pull двигает ветку, но не переключает её). */
  branch: ProjectBranchInfo
}

/**
 * Коды `OrcaError` (`ipcErrorCode`) git-операций корня проекта: `projects:branches`, `gitFetch`, `gitPull`,
 * `checkoutBranch`. Тексты — `main/strings/{ru,en}.ts`, ключи те же. Ожидаемые отказы, не сбои: UI показывает
 * сообщение и не считает приложение сломанным. Любой другой отказ git — `git.opFailed`.
 */
export const PROJECT_GIT_ERROR_CODES = [
  /** Корень проекта — не git-репозиторий (или git недоступен); параметр — `path`. Кроме `branches`, который отдаёт `isGitRepo: false`. */
  'git.notRepo',
  /** Есть незакоммиченные изменения — `checkoutBranch` не выполняется, чтобы не унести правки на другую ветку. */
  'git.dirtyTree',
  /** `gitPull`: ветка разошлась с upstream, `--ff-only` не может её обновить. Мерж и rebase — вручную в терминале; параметры — `branch`, `upstream`. */
  'git.notFastForward',
  /** `gitPull`: у текущей ветки нет upstream (или она на detached HEAD — pull негде брать); параметр — `branch` (при detached — `HEAD`). */
  'git.noUpstream',
  /** `checkoutBranch`: ветка checked out в другом worktree; параметры сообщения — `branch`, `path`. */
  'git.branchBusy',
  /** `checkoutBranch`: в проекте есть живые воркеры или координаторы Orca — корень переключать нельзя; параметр — `count`. */
  'git.workersActive',
  /** `checkoutBranch`: такой ветки нет ни локально, ни среди remote-веток; параметр — `branch`. */
  'git.branchNotFound',
  /** Прочий отказ git (сеть, права, конфликт при pull, зависший remote): параметры — `command`, `error` (stderr git). */
  'git.opFailed'
] as const
export type ProjectGitErrorCode = (typeof PROJECT_GIT_ERROR_CODES)[number]

/** Вид записи папки проекта (`files:list`): симлинк отдаётся как есть, без перехода по нему. */
export type ProjectFileKind = 'dir' | 'file' | 'symlink'

/** Запись папки проекта (`files:list`). Пути renderer собирает сам: `dir + '/' + name`. */
export interface ProjectFileEntry {
  name: string
  kind: ProjectFileKind
}

export interface ProjectFilesListing {
  /** Папка от корня проекта через `/`; '' — корень (эхо запроса: renderer отбрасывает устаревшие ответы). */
  dir: string
  /** Отсортировано main: папки, затем файлы и симлинки, по имени. */
  entries: ProjectFileEntry[]
  /** Записей в папке больше `PROJECT_FILES_DIR_LIMIT` — показаны первые. */
  truncated: boolean
}

/** Сколько записей одной папки отдаёт `files:list`: огромная папка не должна подвешивать IPC и дерево. */
export const PROJECT_FILES_DIR_LIMIT = 5000

/** Ожидаемые отказы `files:*` — у каждого свой текст в renderer (образец — `PROJECT_GIT_ERROR_CODES`). */
export const PROJECT_FILES_ERROR_CODES = [
  'files.badPath', // не строка, NUL, абсолютный, `..`/`.`/пустой сегмент, `\`, `:` на win32
  'files.outside', // путь (по realpath) вне корня проекта
  'files.hidden', // `.git`
  'files.notFound', // папки/файла уже нет (удалили после последнего чтения)
  'files.notDir', // list на файле
  'files.notFile', // ожидался файл, а это папка, FIFO, сокет, устройство (`docs:view/bytes/previewUrl/open`)
  'files.rootMissing', // корня проекта нет на диске
  'files.readFailed' // прочее: доступ, ввод-вывод, слишком длинный путь; параметры path, error
] as const
export type ProjectFilesErrorCode = (typeof PROJECT_FILES_ERROR_CODES)[number]

/**
 * Проект в renderer. Свои у проекта только колонки, агенты и типы задач; роли, воркфлоу, правила агентов
 * и разрешения — у типа задачи (`TaskType`, «Настройки → Типы задач»).
 */
export interface Project {
  id: string
  root: string
  name: string
  /** Группа в левом меню (`ProjectGroup.id`). undefined — проект без группы. Id несуществующей группы читать как «без группы». */
  groupId?: string
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
  /**
   * Предупреждения автомиграции графа (`TaskType.workflowNotes`). Не передан — прежние остаются, пока граф не менялся;
   * передан (пустой список — «закрыть») — сохраняется как есть.
   */
  workflowNotes?: WfMigrationNote[]
}

/** Итог «Экспорта типа»: куда сохранён файл. Диалог закрыли — вместо результата null. */
export interface TaskTypeExportResult {
  path: string
}

/** Создать (без `id`) или целиком заменить шаблон ноды; `updatedAt` ставит main. */
export interface NodeTemplateInput {
  id?: string
  title: string
  description?: string
  /** Нода без id и позиции (лишние `id`/`x`/`y` main снимет). */
  node: WfTemplateNode
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

/**
 * Файл в просмотрщике «Документы»: в группе `project` — любой файл проекта, в группах задач — `.md`. Старый main
 * отдаёт и в `project` только `.md`: renderer не должен на это полагаться ни в ту, ни в другую сторону.
 */
export interface DocFile {
  /** Относительно корня источника (проекта или worktree задачи), через `/`. */
  path: string
  size: number
  mtime: number
  /** Не отслеживается git'ом — новый файл. */
  untracked: boolean
  /** Симлинк на файл (цель может быть вне корня или битой — это выяснится при `docs:view`). Нет поля — не симлинк. */
  link?: boolean
}

/** Файл показа для превью (`showcase:read`): mime по расширению и содержимое. */
export interface ShowcaseFileData {
  mime: string
  bytes: Uint8Array
}

/** Адрес страницы показа для изолированного фрейма (`showcase:previewUrl`). */
export interface ShowcasePreviewUrl {
  /** `orca-preview://<токен>/<путь>` — renderer ставит его в `src`, только проверив схему. */
  url: string
  mime: string
  /** `orca-preview://<токен>/` — корень снимка: к нему разрешаются относительные картинки markdown. */
  base: string
}

/** Параметры `showcase:previewUrl`. */
export interface ShowcasePreviewOptions {
  /** Разрешить странице интернет-ресурсы (CDN, шрифты). По умолчанию сеть закрыта; выбор не запоминается. */
  network?: boolean
}

/** Группа документов: проект (`source: 'project'`) или worktree задачи в работе (`source` — id задачи). */
export interface DocGroup {
  source: string
  title: string
  branch?: string
  files: DocFile[]
  /** Только `project`: файлов больше `DOCS_LIST_LIMIT` (`shared/docs-view.ts`) — отданы первые. */
  truncated?: boolean
}

/**
 * Почему содержимое файла не показывается (`DocView.stub`) — это обычный ответ `docs:view`, не ошибка: `binary` —
 * NUL в первых `DOC_SNIFF_BYTES` или бинарное расширение; `notUtf8` — невалидный UTF-8 (других кодировок не угадываем);
 * `tooBig` — больше `DOC_TEXT_MAX_BYTES` (текст) или `DOC_IMAGE_MAX_BYTES` (картинка); `pdf` — PDF только «Открыть».
 */
export type DocStub = 'binary' | 'notUtf8' | 'tooBig' | 'pdf'

/**
 * Ответ `docs:view`: как показать файл и, для текстовых видов, его содержимое. Инварианты:
 * - `kind` — вид по `docKindOf(path)`; `unknown` main уточняет по содержимому до `text` или `binary`. У заглушки это
 *   предполагаемый вид (`.ts` с NUL — `kind: 'text'`, `stub: 'binary'`), по нему renderer выбирает иконку и текст;
 * - `stub` задан ⇒ `text` нет. `stub: 'pdf'` ⇔ `kind: 'pdf'`;
 * - `text` без `stub` есть всегда у `markdown` и `text`; у `html` и SVG (`kind: 'image'`) — только при `opts.source`;
 *   у прочих картинок не бывает (байты — `docs:bytes`). Это UTF-8 без BOM, не больше `DOC_TEXT_MAX_BYTES`, переводы
 *   строк как в файле;
 * - `mime` есть у `image` и `html`;
 * - `size` и `mtime` — цели симлинка; `mtime` — мс эпохи.
 */
export interface DocView {
  kind: DocViewKind
  size: number
  mtime: number
  mime?: string
  text?: string
  stub?: DocStub
  /**
   * Кнопка «Открыть» приложением системы разрешена: расширение из `SHOWCASE_FILE_TYPES` и у пути, и у цели симлинка
   * (`a.png` → `run.sh` не откроется). Иначе `docs:open` отказывает `docs.notOpenable`.
   */
  openable: boolean
}

/** Параметры `docs:view`. */
export interface DocViewOptions {
  /** Вернуть исходный текст `html` и SVG для вкладки «Код» (у `markdown` и `text` текст есть и так). */
  source?: boolean
}

/** Байты картинки (`docs:bytes`): тот же вид, что у показа, — подходит для `useBlobUrl`. */
export type DocBytes = ShowcaseFileData

/** Адрес для изолированного фрейма (`docs:previewUrl`): `url` — HTML-страница, `base` — корень для картинок markdown. */
export type DocPreviewUrl = ShowcasePreviewUrl

/**
 * Отказы новых каналов `docs:*`, которых нет у `files:*`. Ошибки пути (`files.badPath`, `files.outside`, `files.hidden`,
 * `files.notFound`, `files.notFile`, `files.rootMissing`, `files.readFailed`) — из `PROJECT_FILES_ERROR_CODES`: резолвер
 * общий. Коды `docs.notMarkdown`, `docs.tooBig` и прежние остаются только за `docs:read`.
 */
export const DOC_VIEW_ERROR_CODES = [
  'docs.notOpenable', // `docs:open`: расширение (пути или цели симлинка) не из `SHOWCASE_FILE_TYPES`
  'docs.noPreview' // `docs:previewUrl` не для html/markdown или путь со скрытым сегментом (`.env`, `.github/…`); `docs:bytes` не для картинки
] as const
export type DocViewErrorCode = (typeof DOC_VIEW_ERROR_CODES)[number]

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
     * Создать глобальную задачу. `images` — картинки, вставленные человеком в `GlobalTaskModal`: отдельным
     * аргументом, а не полем `GlobalTaskInput`, чтобы байты не смешивались с JSON-описанием карточки (так же
     * устроен `coordinator:start`). Main проверяет их `validateImageAttachments` (PNG/JPEG/GIF/WebP по сигнатуре,
     * `IMAGE_ATTACHMENT_LIMITS`: ≤ 8 шт., ≤ 10 МБ каждая, ≤ 30 МБ всего на задачу), сохраняет файлы и кладёт
     * метаданные в `Run.images`. Невалидная картинка — ошибка, задача при этом **не создаётся**.
     * Без `images` (и у старого renderer) поведение прежнее.
     */
    create(input: GlobalTaskInput, images?: ImageAttachmentInput[]): Promise<GlobalTask>
    update(id: string, patch: GlobalTaskPatch): Promise<GlobalTask>
    /**
     * Сменить тип задачи (`typeId` из типов проекта) — только до начала работы (`canChangeRunType` из core):
     * в бэклоге, ни разу не была «В работе», без координатора и подзадач; иначе и для «Входящих» — ошибка.
     */
    changeType(id: string, typeId: string): Promise<GlobalTask>
    /**
     * Добавить картинки к существующей задаче. Лимиты `IMAGE_ATTACHMENT_LIMITS` действуют на задачу
     * **суммарно**: уже сохранённые (`GlobalTask.images`) плюс новые; превышение количества или общего размера,
     * неподдерживаемый формат, пустой массив — ошибка, ничего не сохраняется (всё или ничего).
     * Править картинки можно только до начала работы — то же правило, что у `changeType` (`canChangeRunType` /
     * `runTypeLockReason` из core: бэклог, ни разу не «В работе», без координатора и подзадач); «Входящие» —
     * ошибка. Позже картинку можно приложить только при запуске координатора (`startCoordinator(..., images)`),
     * но в задаче она не сохранится. Возвращает обновлённую карточку.
     */
    addImages(id: string, images: ImageAttachmentInput[]): Promise<GlobalTask>
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
     * отдельного аргумента нет: там уходят только сохранённые. Суммарно те же `IMAGE_ATTACHMENT_LIMITS`;
     * превышение (сохранённые + пришедшие) — ошибка запуска до старта агента. Пришедшие в `images` в задачу
     * не сохраняются — для этого есть `addImages`.
     */
    startCoordinator(id: string, cols: number, rows: number, images?: ImageAttachmentInput[]): Promise<string>
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
    returnToWork(id: string, text: string, cols: number, rows: number, images?: ImageAttachmentInput[]): Promise<string>
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
    resolve(id: string, resolution: RequestResolution, images?: ImageAttachmentInput[]): Promise<RequestResolveResult>
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
  /** Двусторонний чат ассистента; Amp/Shell открываются отдельным терминалом. */
  assistantChat: {
    available(ptyId: string): Promise<boolean>
    getMessages(ptyId: string): Promise<AssistantChatSnapshot>
    send(ptyId: string, text: string): Promise<void>
    interrupt(ptyId: string): Promise<void>
    respond(ptyId: string, requestId: string, answer: InteractionAnswer): Promise<void>
    onMessage(ptyId: string, cb: (u: AssistantChatUpdate) => void): () => void
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
    reject(taskId: string, feedback: string, images?: ImageAttachmentInput[]): Promise<void>
  }
  /**
   * Картинки к замечаниям при возврате в работу. Только рукопожатие: «новый preload + старый main» молча
   * отбросил бы лишний аргумент `images`, и картинка пропала бы без ошибки — renderer перед показом «Приложить»
   * зовёт `ping()` и при отсутствии метода/хендлера просит перезапустить приложение.
   */
  attachments: {
    ping(): Promise<true>
  }
}

// ---------- Чат-режим ассистента (docs/assistant-chat.md) ----------
//
// Модель сообщений канала `assistantChat` (`OrcaApi` выше) — панель ассистента как чат поверх того же PTY.
// Разбор транскрипта в эти типы — `main/assistant-chat.ts`, IPC — `registerIpc` в `main/index.ts`,
// мост — `preload/index.ts`. Настройки приложения/проекта из `docs/assistant-chat.md` → «1–2» в этот канал
// не входят: они остаются в общих методах `settings`/`types`/`roles`/`node-templates`/`project rules`.

/** Нормализованный поток ассистента. Старый парсер транскриптов использует эти же типы. */
export type AssistantChatRole = ConversationMessage['role']
export type AssistantChatStatus = ConversationStatus
export type AssistantChatToolCall = ConversationToolCall
export interface AssistantChatMessage extends ConversationMessage { hasImage?: boolean }

export interface AssistantChatSnapshot {
  ptyId: string
  messages: AssistantChatMessage[]
  status: AssistantChatStatus
  protocolVersion?: 2
  revision?: number
  agent?: AgentKind
  transport?: 'chat' | 'terminal'
  interactions?: ConversationInteraction[]
  error?: string
}

export type AssistantChatUpdate = { ptyId: string; revision?: number } & (
  | { message: AssistantChatMessage }
  | { status: AssistantChatStatus; error?: string }
  | { interaction: ConversationInteraction }
  | { resolvedRequestId: string }
)
