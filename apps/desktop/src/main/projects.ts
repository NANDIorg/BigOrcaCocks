import { writeFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  TaskStore, isAgentKind, DEFAULT_ROLES, withDefaultDescriptions, DEFAULT_COLUMNS, SYSTEM_COLUMN_KINDS, COLUMN_COLORS,
  WORKFLOW_VERSION, defaultWorkflow, migrateWorkflow, validateWorkflow,
  GENERAL_TASK_TYPE_ID, presetTaskType, presetTaskTypes,
  resolveRunType, resolveTaskType, runTypeInput, snapshotTaskType,
  type OrcaEvent, type AgentKind, type Role, type BoardColumn, type Workflow, type WfValidationContext,
  type TaskType, type TaskTypeSettings, type ResolvedRunType, type RunTypeInput
} from '@orca-board/core'
import { jsonPersistence, quarantineCorrupt, readJsonFile, writeFileAtomic, type StateWarning } from './persistence'
import { OrcaError, mt, type MText } from './i18n'
import { guessTaskType } from './task-type-detect'
import { PROJECTS_FILE_VERSION, migrateProjectsFile, type LegacyProjectsFile } from './task-types-migration'
import { DEFAULT_UPDATE_SETTINGS, ONBOARDING_VERSION } from '../shared/ipc'
import type { OnboardingCompleteInput, OnboardingState, ProjectGroup } from '../shared/ipc'
import type {
  AppLanguage, AppSettings, AppSettingsPatch, UpdateSettings, ProjectTaskTypesInput, TaskTypeDetection, TaskTypeInput,
  TaskTypesState
} from '../shared/ipc'
import { DEFAULT_NOTIFICATION_SETTINGS, mergeNotificationSettings, normalizeNotificationSettings } from '../shared/notifications'

export type PermissionMode = 'auto' | 'bypassPermissions' | 'acceptEdits'

const PERMISSION_MODES: PermissionMode[] = ['auto', 'bypassPermissions', 'acceptEdits']

function isPermissionMode(v: unknown): v is PermissionMode {
  return (PERMISSION_MODES as unknown[]).includes(v)
}

/**
 * Проект в projects.json. Роли, воркфлоу, правила агентов и разрешения у проекта больше не хранятся — они у
 * типа задачи (`TaskType`), который выбирается у глобальной задачи (docs/architecture.md → «Типы задач»).
 */
export interface Project {
  id: string
  root: string
  name: string
  /** Группа в левом меню (`ProjectsFile.groups[].id`). Нет — проект без группы; висячая ссылка чистится при загрузке. */
  groupId?: string
  /** Включённые агенты. undefined — все установленные. */
  enabledAgents?: AgentKind[]
  /** Колонки доски в порядке показа. undefined — DEFAULT_COLUMNS. */
  columns?: BoardColumn[]
  /** Типы задач, доступные в проекте. undefined — все типы библиотеки. */
  taskTypeIds?: string[]
  /**
   * Тип по умолчанию: глобальные задачи и координатор без выбранного типа, «Входящие», прогоны до типов.
   * Нет или тип удалён — тип библиотеки по умолчанию (`projectDefaultTypeId`).
   */
  defaultTaskTypeId?: string
  /**
   * Тип, в который миграция перенесла настройки проекта (`migrateProjectsFile`). Его получают прогоны доски без
   * типа при её загрузке (`store` → `assignRunTypes`): доска грузится лениво, и если человек успеет сменить тип
   * по умолчанию, старые прогоны всё равно останутся на ролях своего проекта. Поле не удаляется —
   * `assignRunTypes` идемпотентна.
   */
  legacyTypeId?: string
}

export interface ProjectsFile {
  projects: Project[]
  activeId: string | null
  /**
   * Группы проектов для левого меню, порядок массива = порядок в меню. Нет ключа — файл до групп: групп нет, все
   * проекты без группы (отдельной миграции и бампа версии не нужно, старая версия приложения поле игнорирует).
   */
  groups?: ProjectGroup[]
  /** Версия формата (`PROJECTS_FILE_VERSION`); нет — файл до типов задач, его переводит миграция в `load()`. */
  version?: number
  /**
   * Библиотека типов задач — вся, в порядке показа. Заготовки (`presetTaskTypes`) попадают сюда один раз
   * (`seededTaskTypes`) и дальше ничем не отличаются от созданных человеком. Пустой после загрузки не бывает.
   */
  taskTypes?: TaskType[]
  /**
   * Заготовки типов уже положены в библиотеку. Без флага засев повторялся бы при каждой загрузке, и удалённая
   * заготовка возвращалась бы после рестарта. Нет флага — файл от версии, где встроенные типы жили в коде.
   */
  taskTypesSeeded?: boolean
  /** Тип библиотеки по умолчанию (новые проекты, ассистент); нет или удалён — `general`, иначе первый тип. */
  defaultTaskTypeId?: string
  /** Глобальные настройки приложения; незаданные поля — DEFAULT_APP_SETTINGS. */
  settings?: Partial<AppSettings>
  /**
   * Версия приложения последнего запуска. По ней `backupOnVersionChange` (`backup.ts`) решает, делать ли бэкап
   * состояния перед миграциями. Лежит здесь, а не в `settings`: это не настройка человека и в renderer не уходит.
   */
  lastRunVersion?: string
  /**
   * Мастер первого запуска. Не настройка человека: в `AppSettings` не входит, `app:setSettings` его не меняет, в
   * renderer оно уходит только через `onboarding:*`. `pending` пишется явно при создании файла (`emptyProjectsFile`):
   * `markRun` и `setSettings` создают projects.json уже при первом запуске, поэтому «нет файла» первым запуском
   * не считается. Нет ключа — файл от версии до мастера, его решает `loadedOnboarding`.
   */
  onboarding?: StoredOnboarding
}

/** Что лежит в `ProjectsFile.onboarding`. `reason: 'existing'` — мастер не показывали: человек пользовался приложением до него. */
export interface StoredOnboarding {
  status: OnboardingState['status']
  version: number
  at?: number
  reason?: 'existing'
}

const ONBOARDING_STATUSES: readonly StoredOnboarding['status'][] = ['pending', 'completed', 'skipped']

/**
 * Поле `onboarding` из файла. Нет ключа или он невалиден (не объект, неизвестный `status`) — файл от версии до
 * мастера: пользователь с проектами или заданными настройками мастер уже не ждёт (`completed`, `existing`), пустой
 * файл (запускал, но ничего не делал) — `pending`. `changed` — значение придумано здесь и его надо записать, иначе
 * оно пересчитывалось бы при каждом старте.
 */
function loadedOnboarding(raw: unknown, existingUser: boolean): { value: StoredOnboarding; changed: boolean } {
  if (isObject(raw) && ONBOARDING_STATUSES.includes(raw.status as StoredOnboarding['status'])) {
    const status = raw.status as StoredOnboarding['status']
    return {
      value: {
        status,
        version: typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : ONBOARDING_VERSION,
        ...(status !== 'pending' && typeof raw.at === 'number' && Number.isFinite(raw.at) ? { at: raw.at } : {}),
        ...(raw.reason === 'existing' ? { reason: 'existing' as const } : {})
      },
      changed: false
    }
  }
  return {
    value: existingUser
      ? { status: 'completed', version: ONBOARDING_VERSION, at: Date.now(), reason: 'existing' }
      : { status: 'pending', version: ONBOARDING_VERSION },
    changed: true
  }
}

/** projects.json до типов задач: поля, которые читает только миграция. */
interface RawProjectsFile extends Omit<LegacyProjectsFile, 'templates'> {
  /** Старый глобальный дефолт для новых проектов — переносится в тип `general` (`normalizeLegacy`). */
  defaults?: Record<string, unknown>
  /** Шаблоны проектов: в файле — с колонками и агентами, после `normalizeLegacy` — уже типы. */
  templates?: unknown
}

function isAppLanguage(v: unknown): v is AppLanguage {
  return v === 'ru' || v === 'en'
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  keepInBackground: true,
  notifications: DEFAULT_NOTIFICATION_SETTINGS,
  updates: DEFAULT_UPDATE_SETTINGS
}

const UPDATE_SETTING_KEYS = Object.keys(DEFAULT_UPDATE_SETTINGS) as (keyof UpdateSettings)[]

/** Настройки обновления из файла: незаданные и не-boolean поля — дефолты. */
function normalizeUpdateSettings(raw: unknown): UpdateSettings {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const out = { ...DEFAULT_UPDATE_SETTINGS }
  for (const k of UPDATE_SETTING_KEYS) if (typeof r[k] === 'boolean') out[k] = r[k] as boolean
  return out
}

/** Имя бэкапа projects.json старого формата: откат на старую версию приложения прочтёт проекты без ролей. */
export const PROJECTS_BACKUP_NAME = 'projects.v1.bak.json'

/**
 * Список репозиториев, библиотека типов задач и по TaskStore на каждый проект. Доска хранится в
 * userData/boards/<id>.json. Активный проект — тот, что выбран в сайдбаре; CLI может адресовать любой через ORCA_PROJECT.
 */
export class ProjectManager {
  private file: string
  private data: ProjectsFile
  private stores = new Map<string, TaskStore>()
  private listeners = new Set<(projectId: string, store: TaskStore) => void>()
  private eventListeners = new Set<(projectId: string, events: OrcaEvent[]) => void>()
  private seenEvents = new Map<string, number>()
  private warnings: StateWarning[] = []

  constructor(private userData: string) {
    this.file = join(userData, 'projects.json')
    const { data, legacyText, dirty } = this.load()
    this.data = data
    if (legacyText !== undefined) {
      // Миграция пишет файл сразу: `legacyTypeId` должен дожить до ленивой загрузки досок.
      const backup = join(userData, PROJECTS_BACKUP_NAME)
      if (!existsSync(backup)) writeFileSync(backup, legacyText)
    }
    // `dirty` — решение по онбордингу для файла без ключа или битого: битый файл уже отложен, и без записи
    // следующий старт увидел бы «файла нет» и показал мастер человеку, которому он не нужен.
    if (legacyText !== undefined || dirty) this.save()
  }

  /** Файл целиком; `legacyText` — исходный текст, если файл был старого формата и его перевели на типы задач. */
  private load(): { data: ProjectsFile; legacyText?: string; dirty?: boolean } {
    const read = readJsonFile<RawProjectsFile>(this.file, 'проекты')
    if (read.status === 'missing') return { data: emptyProjectsFile() }
    // Битый projects.json — не «нет проектов»: файл отложен в .corrupt-<ts>, предупреждение ждёт `stateWarnings()`.
    if (read.status === 'corrupt') {
      this.warnings.push(read.warning)
      return { data: existingUserFile(), dirty: true }
    }
    try {
      const text = read.text
      const raw = read.value
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('ожидается объект')
      if (!Array.isArray(raw.projects)) raw.projects = []
      if (raw.settings !== undefined && !isObject(raw.settings)) delete raw.settings
      const legacy = !(typeof raw.version === 'number' && raw.version >= PROJECTS_FILE_VERSION)
      if (legacy) normalizeLegacy(raw)
      const { data, changed } = migrateProjectsFile(raw as LegacyProjectsFile)
      // Типы чистятся при каждой загрузке по разделам (`loadedTaskType`): битый раздел не уносит тип целиком,
      // иначе проект молча уехал бы на тип по умолчанию, а его роли и правила пропали бы при первой же записи.
      const rawTypes: unknown[] = Array.isArray(data.taskTypes) ? data.taskTypes : []
      data.taskTypes = seededTaskTypes(rawTypes.flatMap(loadedTaskType), data.taskTypesSeeded === true ? undefined : rawTypes)
      data.taskTypesSeeded = true
      if (data.defaultTaskTypeId !== undefined && !nonEmpty(data.defaultTaskTypeId)) delete data.defaultTaskTypeId
      for (const p of data.projects) normalizeProject(p)
      normalizeGroups(data)
      const settingsSet = isObject(raw.settings) && Object.keys(raw.settings).length > 0
      const onboarding = loadedOnboarding(raw.onboarding, data.projects.length > 0 || settingsSet)
      data.onboarding = onboarding.value
      return { data, ...(changed ? { legacyText: text } : {}), ...(onboarding.changed ? { dirty: true } : {}) }
    } catch (e) {
      // JSON разобрался, но содержимое не годится для нормализации — то же, что битый файл.
      const movedTo = quarantineCorrupt(this.file)
      this.warnings.push({
        kind: 'corrupt', file: this.file, movedTo,
        message: `проекты: файл ${this.file} не прочитан (${(e as Error).message})${movedTo ? ` — сохранён как ${movedTo}` : ''}, начато с пустого состояния`
      })
      return { data: existingUserFile(), dirty: true }
    }
  }

  private save(): void {
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2))
  }

  /** Предупреждения о файлах, которые не прочитались при загрузке (проекты и уже открытые доски). Каналов в renderer пока нет. */
  stateWarnings(): StateWarning[] {
    return [...this.warnings]
  }

  /** Запоминает версию приложения, которая работает с файлами сейчас (`backupOnVersionChange` сверяет с ней при запуске). */
  markRun(version: string): void {
    if (this.data.lastRunVersion === version) return
    this.data.lastRunVersion = version
    this.save()
  }

  list(): Project[] {
    return [...this.data.projects]
  }

  get(id: string): Project | undefined {
    return this.data.projects.find((p) => p.id === id)
  }

  // ---------- группы проектов ----------

  /** Группы в порядке показа; групп нет — пустой массив. */
  groups(): ProjectGroup[] {
    return (this.data.groups ?? []).map((g) => ({ ...g }))
  }

  private mustGetGroup(id: string): ProjectGroup {
    const g = (this.data.groups ?? []).find((x) => x.id === id)
    if (!g) throw new OrcaError('projects.groupNotFound', { id })
    return g
  }

  /** Новая группа в конце списка. Имя обрезается; пустое — `projects.groupNameEmpty`. */
  createGroup(name: string): ProjectGroup {
    const trimmed = groupName(name)
    const groups = this.data.groups ?? []
    let id: string
    do id = `group_${randomBytes(4).toString('hex')}`
    while (groups.some((g) => g.id === id))
    const group: ProjectGroup = { id, name: trimmed }
    this.data.groups = [...groups, group]
    this.save()
    return { ...group }
  }

  renameGroup(id: string, name: string): ProjectGroup {
    const g = this.mustGetGroup(id)
    g.name = groupName(name)
    this.save()
    return { ...g }
  }

  /** Удалить группу: её проекты остаются, но становятся проектами без группы. */
  removeGroup(id: string): void {
    this.mustGetGroup(id)
    this.data.groups = (this.data.groups ?? []).filter((g) => g.id !== id)
    for (const p of this.data.projects) if (p.groupId === id) delete p.groupId
    this.save()
  }

  /** Свернуть/развернуть группу; развёрнутая хранится без поля (`collapsed` не пишется вовсе). */
  setGroupCollapsed(id: string, collapsed: boolean): ProjectGroup {
    const g = this.mustGetGroup(id)
    if (collapsed) g.collapsed = true
    else delete g.collapsed
    this.save()
    return { ...g }
  }

  /** Положить проект в группу; `null` — вынуть. Неизвестный проект — `project not found`, неизвестная группа — `projects.groupNotFound`. */
  setProjectGroup(projectId: string, groupId: string | null): Project {
    const p = this.mustGet(projectId)
    if (groupId === null) delete p.groupId
    else p.groupId = this.mustGetGroup(groupId).id
    this.save()
    return p
  }

  /** Новый порядок групп: `ids` — ровно все существующие id, каждый один раз; иначе `projects.groupNotFound` на первом лишнем или пропущенном. */
  reorderGroups(ids: string[]): ProjectGroup[] {
    const groups = this.data.groups ?? []
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) throw new OrcaError('projects.groupNotFound', { id })
      this.mustGetGroup(id)
      seen.add(id)
    }
    const missing = groups.find((g) => !seen.has(g.id))
    if (missing) throw new OrcaError('projects.groupNotFound', { id: missing.id })
    this.data.groups = ids.map((id) => groups.find((g) => g.id === id)!)
    this.save()
    return this.groups()
  }

  private mustGet(id: string): Project {
    const p = this.get(id)
    if (!p) throw new Error(`project not found: ${id}`)
    return p
  }

  active(): Project | null {
    return this.data.projects.find((p) => p.id === this.data.activeId) ?? this.data.projects[0] ?? null
  }

  setActive(id: string): Project {
    const p = this.mustGet(id)
    this.data.activeId = id
    this.save()
    return p
  }

  /**
   * Добавить репозиторий. Путь нормализуется до корня git. Новый проект получает встроенные колонки и тип по
   * умолчанию `typeId` (нет — тип библиотеки по умолчанию); копии настроек типа нет — связь живая.
   * Уже добавленный репозиторий возвращается как есть.
   */
  add(path: string, typeId?: string): Project {
    let root: string
    try {
      root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: path, stdio: 'pipe' }).toString().trim()
    } catch {
      throw new OrcaError('projects.notGit', { path })
    }
    const existing = this.data.projects.find((p) => p.root === root)
    if (existing) {
      this.data.activeId = existing.id
      this.save()
      return existing
    }
    const type = this.requireType(typeId ?? this.defaultTaskTypeId())
    const id = createHash('sha1').update(root).digest('hex').slice(0, 10)
    const project: Project = { id, root, name: basename(root), columns: clone(DEFAULT_COLUMNS), defaultTaskTypeId: type.id }
    this.data.projects.push(project)
    this.data.activeId = id
    this.save()
    return project
  }

  /**
   * Подсказка типа по файлам репозитория (`guessTaskType`) — только предвыбор. Нет признаков или угаданного
   * типа нет в библиотеке — тип библиотеки по умолчанию.
   */
  detectTaskType(path: string): TaskTypeDetection {
    const hint = guessTaskType(path)
    if (hint.typeId && this.taskType(hint.typeId)) return { path, typeId: hint.typeId, reason: hint.reason }
    return { path, typeId: this.defaultTaskTypeId(), reason: '' }
  }

  // ---------- библиотека типов задач ----------

  /** Библиотека в порядке хранения (заготовки после засева — такие же типы, как созданные человеком). */
  taskTypes(): TaskType[] {
    return (this.data.taskTypes ?? []).map(clone)
  }

  taskType(id: string): TaskType | undefined {
    return this.taskTypes().find((t) => t.id === id)
  }

  private requireType(id: string): TaskType {
    const t = this.taskType(id)
    if (!t) throw new OrcaError('type.notFound', { id })
    return t
  }

  /** Библиотека и тип по умолчанию — то, что нужно «Настройкам → Типы задач» и выбору типа нового проекта. */
  taskTypesState(): TaskTypesState {
    return { taskTypes: this.taskTypes(), defaultTaskTypeId: this.defaultTaskTypeId() }
  }

  /**
   * Тип библиотеки по умолчанию: заданный и существующий, иначе «Программирование», а если и его удалили — первый
   * тип библиотеки (она не бывает пустой: последний тип не удаляется, пустая при загрузке засевается).
   */
  defaultTaskTypeId(): string {
    const types = this.data.taskTypes ?? []
    const id = this.data.defaultTaskTypeId
    if (id && types.some((t) => t.id === id)) return id
    return (types.find((t) => t.id === GENERAL_TASK_TYPE_ID) ?? types[0])?.id ?? GENERAL_TASK_TYPE_ID
  }

  setDefaultTaskType(id: string): TaskTypesState {
    this.requireType(id)
    this.data.defaultTaskTypeId = id
    this.save()
    return this.taskTypesState()
  }

  /**
   * Создать (без `id` — новый id) или целиком заменить тип. Граф проверяется по ролям типа, колонки доски — нет:
   * тип общий для проектов с разными колонками.
   */
  saveTaskType(input: TaskTypeInput): TaskType {
    if (!isObject(input)) throw new OrcaError('type.notObject')
    if (input.id !== undefined && !nonEmpty(input.id)) throw new OrcaError('type.emptyId')
    if (!nonEmpty(input.title)) throw new OrcaError('type.emptyTitle')
    if (input.description !== undefined && typeof input.description !== 'string') throw new OrcaError('type.descriptionNotString', { title: input.title })
    const user = [...(this.data.taskTypes ?? [])]
    const id = input.id ?? this.newTypeId()
    const i = user.findIndex((t) => t.id === id)
    const description = input.description?.trim()
    const type: TaskType = {
      id, title: input.title.trim(), ...(description ? { description } : {}),
      settings: savedTypeSettings(input.settings ?? {}, i === -1 ? undefined : user[i], typeLabel(input.title.trim()))
    }
    if (i !== -1) this.settleLegacyRuns(id)
    if (i === -1) user.push(type)
    else user[i] = type
    this.data.taskTypes = user
    this.save()
    return clone(type)
  }

  /**
   * Смержить патч в настройки типа (`validTypeSettings`: null у графа и разрешений — встроенное значение,
   * правила из пробелов — нет правил) и сохранить через `saveTaskType`.
   */
  patchTaskType(id: string, patch: Partial<Record<keyof TaskTypeSettings, unknown>>): TaskType {
    const t = this.requireType(id)
    const settings = validTypeSettings(patch, t.settings, typeLabel(t.title))
    return this.saveTaskType({ id: t.id, title: t.title, ...(t.description ? { description: t.description } : {}), settings })
  }

  /**
   * Удалить тип — любой, в том числе заготовку; после рестарта он не вернётся (`taskTypesSeeded`). Удалённый тип
   * библиотеки по умолчанию сбрасывается (`defaultTaskTypeId` выберет «Программирование» или первый тип);
   * ссылки проектов (`defaultTaskTypeId`, `taskTypeIds`) остаются висячими и при чтении пропускаются, прогоны
   * этого типа дорабатывают по снимку (`resolveRunType`). Последний тип не удаляется: глобальной задаче нужен тип.
   */
  deleteTaskType(id: string): TaskTypesState {
    const types = this.data.taskTypes ?? []
    const t = types.find((x) => x.id === id)
    if (!t) throw new OrcaError('type.notFound', { id })
    if (types.length === 1) throw new OrcaError('type.lastOne', { title: t.title })
    this.settleLegacyRuns(id)
    this.data.taskTypes = types.filter((x) => x.id !== id)
    if (this.data.defaultTaskTypeId === id) delete this.data.defaultTaskTypeId
    this.save()
    return this.taskTypesState()
  }

  /**
   * Перед правкой или удалением типа, в который миграция перенесла настройки проекта, загрузить незагруженные
   * доски таких проектов: `store` отдаёт их старым прогонам снимок типа (`assignRunTypes`), пока он ещё прежний.
   * Иначе доска, открытая после удаления, не нашла бы тип и прогоны ушли бы на тип проекта по умолчанию,
   * а после правки их снимок был бы уже с изменёнными ролями — не как у прогонов, созданных до правки. Снимок не хранится в projects.json заранее: роли с
   * промптами дублировались бы в файле, а момент, когда тип перестаёт совпадать со старыми настройками, — ровно этот.
   */
  private settleLegacyRuns(typeId: string): void {
    for (const p of this.data.projects) if (p.legacyTypeId === typeId) this.store(p.id)
  }

  /** Копия типа под новым id: отдельный тип рядом с исходным. */
  duplicateTaskType(id: string): TaskType {
    const src = this.requireType(id)
    return this.saveTaskType({
      title: mt('type.copyTitle', { title: src.title }),
      ...(src.description ? { description: src.description } : {}),
      settings: src.settings
    })
  }

  private newTypeId(): string {
    let id: string
    do id = `type_${randomBytes(4).toString('hex')}`
    while (this.taskType(id))
    return id
  }

  /**
   * Правила агентов типа (`roleId` нет) или системный промпт его роли — `rules set`.
   */
  saveTaskTypeRules(typeId: string, roleId: string | undefined, text: string): TaskType {
    const t = this.requireType(typeId)
    if (roleId === undefined) return this.patchTaskType(typeId, { agentRules: text })
    if (typeof text !== 'string') throw new OrcaError('rules.roleNotString')
    const roles = t.settings.roles ?? DEFAULT_ROLES
    if (!roles.some((r) => r.id === roleId)) throw new OrcaError('type.noRole', { title: t.title, role: roleId })
    return this.patchTaskType(typeId, { roles: roles.map((r) => (r.id === roleId ? { ...r, systemPrompt: text } : r)) })
  }

  /**
   * Граф типа: свой или дефолтный по ролям типа (`custom: false`). Граф из будущей версии формата не исполняем —
   * ошибка с просьбой обновить приложение.
   */
  taskTypeWorkflow(typeId: string): { typeId: string; title: string; workflow: Workflow; custom: boolean } {
    const t = this.requireType(typeId)
    const own = t.settings.workflow
    if (own && own.version > WORKFLOW_VERSION) throw futureWorkflowError(own.version)
    return { typeId: t.id, title: t.title, workflow: own ? clone(own) : resolveTaskType(t).workflow, custom: own !== undefined }
  }

  // ---------- типы проекта и прогонов ----------

  /** Типы, доступные в проекте (`taskTypeIds`, висячие id пропускаются); не осталось ни одного — тип по умолчанию. */
  projectTaskTypes(projectId: string): TaskType[] {
    const p = this.mustGet(projectId)
    const all = this.taskTypes()
    if (!p.taskTypeIds) return all
    const own = all.filter((t) => p.taskTypeIds!.includes(t.id))
    return own.length ? own : [this.projectDefaultType(projectId)]
  }

  /**
   * Тип проекта по умолчанию: свой (если он есть в библиотеке), иначе тип библиотеки по умолчанию, если он
   * доступен проекту, иначе первый доступный.
   */
  projectDefaultTypeId(projectId: string): string {
    const p = this.mustGet(projectId)
    const all = this.taskTypes()
    if (p.defaultTaskTypeId && all.some((t) => t.id === p.defaultTaskTypeId)) return p.defaultTaskTypeId
    const libraryDefault = this.defaultTaskTypeId()
    if (!p.taskTypeIds || p.taskTypeIds.includes(libraryDefault)) return libraryDefault
    return all.find((t) => p.taskTypeIds!.includes(t.id))?.id ?? libraryDefault
  }

  projectDefaultType(projectId: string): TaskType {
    return this.requireType(this.projectDefaultTypeId(projectId))
  }

  /** Доступные проекту типы (null — все) и тип по умолчанию, который должен быть среди них. */
  setProjectTaskTypes(projectId: string, input: ProjectTaskTypesInput): Project {
    const p = this.mustGet(projectId)
    if (!isObject(input)) throw new OrcaError('projectTypes.notObject')
    const exists = (id: string): boolean => this.taskType(id) !== undefined
    let typeIds: string[] | undefined
    if (input.typeIds != null) {
      if (!Array.isArray(input.typeIds) || !input.typeIds.every(nonEmpty)) throw new OrcaError('projectTypes.badIds')
      typeIds = [...new Set(input.typeIds)]
      if (!typeIds.length) throw new OrcaError('projectTypes.empty')
      const missing = typeIds.find((id) => !exists(id))
      if (missing) throw new OrcaError('type.notFound', { id: missing })
    }
    if (!nonEmpty(input.defaultTypeId) || !exists(input.defaultTypeId)) throw new OrcaError('type.notFound', { id: String(input.defaultTypeId) })
    if (typeIds && !typeIds.includes(input.defaultTypeId)) {
      throw new OrcaError('projectTypes.defaultNotAvailable', { title: this.requireType(input.defaultTypeId).title })
    }
    if (typeIds) p.taskTypeIds = typeIds
    else delete p.taskTypeIds
    p.defaultTaskTypeId = input.defaultTypeId
    this.save()
    return p
  }

  /**
   * Тип прогона `runId` (`resolveRunType` — единое правило): тип прогона из библиотеки, снимок удалённого,
   * а без прогона («Входящие») или у прогона без типа — тип проекта по умолчанию.
   */
  resolveRun(projectId: string, runId?: string): ResolvedRunType {
    const run = runId !== undefined ? this.store(projectId).getRun(runId) : undefined
    return resolveRunType(run, this.taskTypes(), this.projectDefaultTypeId(projectId))
  }

  /** Тип `typeId` раскрытым (для нового прогона, у которого ещё нет записи в store); неизвестный — тип по умолчанию. */
  resolveType(projectId: string, typeId: string): ResolvedRunType {
    return resolveRunType({ typeId }, this.taskTypes(), this.projectDefaultTypeId(projectId))
  }

  /**
   * Тип нового прогона для store (`createRun`, `createGlobalTask`): id, снимок и граф. Без `typeId` — тип проекта
   * по умолчанию; тип вне доступных проекту — ошибка. Граф из будущей версии не снимается — прогон пойдёт по
   * дефолтному графу, а не упадёт при создании.
   */
  runType(projectId: string, typeId?: string): RunTypeInput {
    const p = this.mustGet(projectId)
    const id = typeId ?? this.projectDefaultTypeId(projectId)
    const type = typeId === undefined ? this.taskType(id) : this.projectTaskTypes(projectId).find((t) => t.id === id)
    if (!type) {
      const known = this.taskType(id)
      throw known
        ? new OrcaError('type.unavailable', { title: known.title, project: p.name })
        : new OrcaError('type.notFoundHint', { id })
    }
    const input = runTypeInput(type)
    if (input.workflow && input.workflow.version > WORKFLOW_VERSION) delete input.workflow
    return input
  }

  /** Роли типа прогона; без прогона — типа проекта по умолчанию. */
  roles(projectId: string, runId?: string): Role[] {
    return this.resolveRun(projectId, runId).roles
  }

  /** Правила агентов типа прогона; не заданы — ''. */
  agentRules(projectId: string, runId?: string): string {
    return this.resolveRun(projectId, runId).agentRules
  }

  // ---------- настройки приложения и проекта ----------

  /** Настройки приложения; незаданные и некорректные поля — дефолты. */
  settings(): AppSettings {
    const s = this.data.settings ?? {}
    return {
      keepInBackground: typeof s.keepInBackground === 'boolean' ? s.keepInBackground : DEFAULT_APP_SETTINGS.keepInBackground,
      ...(isAppLanguage(s.language) ? { language: s.language } : {}),
      notifications: normalizeNotificationSettings(s.notifications),
      updates: normalizeUpdateSettings(s.updates)
    }
  }

  setSettings(patch: AppSettingsPatch): AppSettings {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new Error('настройки приложения: ожидается объект')
    const next: Partial<AppSettings> = { ...(this.data.settings ?? {}) }
    if (patch.keepInBackground !== undefined) {
      if (typeof patch.keepInBackground !== 'boolean') throw new Error('keepInBackground должен быть boolean')
      next.keepInBackground = patch.keepInBackground
    }
    if (patch.language !== undefined) {
      if (!isAppLanguage(patch.language)) throw new Error(`language: неизвестный язык «${String(patch.language)}», ожидается ru или en`)
      next.language = patch.language
    }
    if (patch.notifications !== undefined) {
      next.notifications = mergeNotificationSettings(this.settings().notifications, patch.notifications)
    }
    if (patch.updates !== undefined) {
      if (typeof patch.updates !== 'object' || patch.updates === null || Array.isArray(patch.updates)) throw new Error('updates: ожидается объект')
      const merged = this.settings().updates
      for (const k of UPDATE_SETTING_KEYS) {
        const v = patch.updates[k]
        if (v === undefined) continue
        if (typeof v !== 'boolean') throw new Error(`updates.${k} должен быть boolean`)
        merged[k] = v
      }
      next.updates = merged
    }
    this.data.settings = next
    this.save()
    return this.settings()
  }

  // ---------- мастер первого запуска ----------

  onboardingState(): OnboardingState {
    const o = this.data.onboarding ?? { status: 'pending' as const, version: ONBOARDING_VERSION }
    return {
      required: o.status === 'pending',
      status: o.status,
      version: o.version,
      ...(o.status !== 'pending' && o.at !== undefined ? { at: o.at } : {})
    }
  }

  /**
   * Записать прохождение (`completed`) или пропуск (`skipped`). Идемпотентно: у уже пройденного или пропущенного
   * статус, версия и время не меняются — повторный вызов (второе окно, двойной клик) ничего не понижает и не
   * перезаписывает. Файл пишется только при изменении.
   */
  completeOnboarding(input?: OnboardingCompleteInput): OnboardingState {
    if (input !== undefined && input !== null && !isObject(input)) throw new OrcaError('onboarding.invalidInput')
    const skipped = input?.skipped
    if (skipped !== undefined && typeof skipped !== 'boolean') throw new OrcaError('onboarding.invalidInput')
    if (this.data.onboarding?.status === undefined || this.data.onboarding.status === 'pending') {
      this.data.onboarding = { status: skipped ? 'skipped' : 'completed', version: ONBOARDING_VERSION, at: Date.now() }
      this.save()
    }
    return this.onboardingState()
  }

  setEnabledAgents(id: string, agents: AgentKind[]): Project {
    const p = this.mustGet(id)
    p.enabledAgents = agents.filter((a) => isAgentKind(a))
    this.save()
    return p
  }

  /** Колонки доски в порядке показа; не заданы — дефолтные. */
  columns(id: string): BoardColumn[] {
    return this.get(id)?.columns ?? DEFAULT_COLUMNS
  }

  /**
   * Заменить набор колонок. Задачи из удалённых колонок переезжают в backlog —
   * так на доске не остаётся задач со статусом, которого нет.
   */
  setColumns(id: string, columns: BoardColumn[]): Project {
    const p = this.mustGet(id)
    this.replaceColumns(p, validateColumns(columns))
    return p
  }

  /** Записать уже проверенные колонки (с сохранением файла) и перенести задачи из исчезнувших колонок в backlog. */
  private replaceColumns(p: Project, next: BoardColumn[]): void {
    const store = this.store(p.id)
    // Сначала применяем новый набор: store читает колонки через this.columns(id),
    // и перенос задач должен считать doneAt/ready уже по новым колонкам.
    p.columns = next
    this.save()
    const backlogId = next.find((c) => c.kind === 'backlog')!.id
    const keep = new Set(next.map((c) => c.id))
    const orphaned = new Set(store.listTasks().map((t) => t.status).filter((s) => !keep.has(s)))
    for (const oldId of orphaned) store.reassignColumn(oldId, backlogId)
  }

  remove(id: string): void {
    this.data.projects = this.data.projects.filter((p) => p.id !== id)
    if (this.data.activeId === id) this.data.activeId = this.data.projects[0]?.id ?? null
    this.save()
  }

  store(id: string): TaskStore {
    let s = this.stores.get(id)
    if (!s) {
      const project = this.mustGet(id)
      const created = new TaskStore(jsonPersistence(join(this.userData, 'boards', `${id}.json`), (w) => this.warnings.push(w)), () => this.columns(id))
      this.seenEvents.set(id, created.listEvents().length)
      created.subscribe(() => {
        this.listeners.forEach((fn) => fn(id, created))
        const all = created.listEvents()
        const seen = this.seenEvents.get(id) ?? 0
        if (all.length > seen) {
          this.seenEvents.set(id, all.length)
          this.eventListeners.forEach((fn) => fn(id, all.slice(seen)))
        }
      })
      this.stores.set(id, created)
      // Прогоны доски до типов задач получают тип, в который миграция перенесла настройки проекта.
      const legacy = project.legacyTypeId !== undefined ? this.taskType(project.legacyTypeId) : undefined
      if (legacy) created.assignRunTypes({ typeId: legacy.id, snapshot: snapshotTaskType(legacy) })
      // После запуска приложения ни одного координатора в живых нет: вопросы, которые ждали их, — человеку.
      for (const run of created.listRuns()) created.escalateOpenQuestions(run.id)
      s = created
    }
    return s
  }

  activeStore(): TaskStore {
    const p = this.active()
    if (!p) throw new OrcaError('projects.none')
    return this.store(p.id)
  }

  /**
   * Число задач в работе (kind=in_progress) по id каждого проекта, включая неактивные. Проект, доска которого не
   * открылась (например, сохранена более новой версией), пропускается: одна такая доска не должна ронять счётчики
   * остальных. Ошибка остаётся там, где открывают именно эту доску (`store(id)`).
   */
  inProgressCounts(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const p of this.list()) {
      try {
        counts[p.id] = this.store(p.id).inProgressCount()
      } catch {
        // доска не открылась — счётчика нет
      }
    }
    return counts
  }

  /** Все загруженные store — для детектора тишины. */
  loadedStores(): Array<[string, TaskStore]> {
    return [...this.stores.entries()]
  }

  onChange(fn: (projectId: string, store: TaskStore) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  onEvents(fn: (projectId: string, events: OrcaEvent[]) => void): () => void {
    this.eventListeners.add(fn)
    return () => this.eventListeners.delete(fn)
  }
}

/** Граф, который исполнитель может выполнить: из будущей версии формата — undefined (пойдёт дефолтный по ролям). */
export function runnableWorkflow(wf: Workflow | undefined): Workflow | undefined {
  return wf && wf.version <= WORKFLOW_VERSION ? wf : undefined
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== ''
}

/** Правила агентов: строка; из одних пробелов — undefined (поля нет). */
function validateAgentRules(text: unknown): string | undefined {
  if (typeof text !== 'string') throw new OrcaError('rules.agentNotString')
  return text.trim() ? text : undefined
}

/**
 * Роли: непустые уникальные id, непустые названия, известный агент; назначение, модель, effort, системный промпт —
 * строки или отсутствуют. Пустое назначение системной роли заменяется назначением по умолчанию.
 */
function validateRoles(roles: Role[]): Role[] {
  if (!Array.isArray(roles) || roles.length === 0) throw new OrcaError('role.noneLeft')
  const seen = new Set<string>()
  return withDefaultDescriptions(roles.map((r, i) => {
    if (!nonEmpty(r.id)) throw new OrcaError('role.emptyId', { n: i + 1 })
    if (seen.has(r.id)) throw new OrcaError('role.duplicate', { id: r.id })
    seen.add(r.id)
    if (!nonEmpty(r.title)) throw new OrcaError('role.emptyTitle', { id: r.id })
    if (r.description !== undefined && typeof r.description !== 'string') throw new OrcaError('role.descriptionNotString', { id: r.id })
    if (!isAgentKind(r.agent)) throw new OrcaError('role.unknownAgent', { id: r.id, agent: String(r.agent) })
    if (r.model !== undefined && typeof r.model !== 'string') throw new OrcaError('role.modelNotString', { id: r.id })
    if (r.effort !== undefined && typeof r.effort !== 'string') throw new OrcaError('role.effortNotString', { id: r.id })
    if (r.systemPrompt !== undefined && typeof r.systemPrompt !== 'string') throw new OrcaError('role.promptNotString', { id: r.id })
    const model = r.model?.trim()
    const effort = r.effort?.trim()
    // Назначение и промпт хранятся как введены (многострочные, без trim — иначе автосохранение съедало бы ввод); из одних пробелов — поля нет.
    const description = r.description?.trim() ? r.description : undefined
    const systemPrompt = r.systemPrompt?.trim() ? r.systemPrompt : undefined
    return {
      id: r.id, title: r.title.trim(), ...(description ? { description } : {}), agent: r.agent,
      ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(systemPrompt ? { systemPrompt } : {})
    }
  }))
}

/**
 * Колонки: непустые уникальные id и названия, каждый системный kind ровно один раз,
 * остальные — custom. Порядок массива = порядок на доске.
 */
function validateColumns(columns: BoardColumn[]): BoardColumn[] {
  if (!Array.isArray(columns) || columns.length === 0) throw new OrcaError('column.noneLeft')
  const ids = new Set<string>()
  const kinds = new Map<string, number>()
  const result = columns.map((c, i) => {
    if (!nonEmpty(c.id)) throw new OrcaError('column.emptyId', { n: i + 1 })
    if (ids.has(c.id)) throw new OrcaError('column.duplicate', { id: c.id })
    ids.add(c.id)
    if (!nonEmpty(c.title)) throw new OrcaError('column.emptyTitle', { id: c.id })
    const system = (SYSTEM_COLUMN_KINDS as string[]).includes(c.kind)
    if (!system && c.kind !== 'custom') throw new OrcaError('column.unknownKind', { id: c.id, kind: String(c.kind) })
    if (system) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1)
    const color = nonEmpty(c.color) ? c.color.trim() : COLUMN_COLORS[0].value
    return { id: c.id, title: c.title.trim(), color, kind: c.kind }
  })
  for (const kind of SYSTEM_COLUMN_KINDS) {
    const n = kinds.get(kind) ?? 0
    if (n === 0) throw new OrcaError('column.systemMissing', { kind })
    if (n > 1) throw new OrcaError('column.systemDuplicate', { kind, n })
  }
  return result
}

function futureWorkflowError(version: number): OrcaError {
  return new OrcaError('workflow.future', { version, known: WORKFLOW_VERSION })
}

/** Начало текста ошибок настроек типа: «тип «Бэкенд»». */
function typeLabel(title: string): MText {
  return { key: 'type.label', params: { title } }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Форма графа — то, без чего `validateWorkflow` упадёт, а не вернёт ошибку: объект, числовая версия,
 * массивы нод и рёбер, строковые id/тип/концы рёбер, числовые координаты. Возвращает копию.
 */
function parseWorkflow(v: unknown): Workflow {
  if (!isObject(v)) throw new Error('воркфлоу: ожидается объект')
  if (typeof v.version !== 'number') throw new Error('воркфлоу: нет номера версии формата')
  if (!Array.isArray(v.nodes) || !Array.isArray(v.edges)) throw new Error('воркфлоу: nodes и edges должны быть массивами')
  v.nodes.forEach((n: unknown, i) => {
    if (!isObject(n)) throw new Error(`воркфлоу: нода №${i + 1} — не объект`)
    if (typeof n.id !== 'string' || typeof n.type !== 'string') throw new Error(`воркфлоу: нода №${i + 1} — id и тип должны быть строками`)
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) throw new Error(`воркфлоу: нода «${n.id}» — координаты должны быть числами`)
  })
  v.edges.forEach((e: unknown, i) => {
    if (!isObject(e)) throw new Error(`воркфлоу: переход №${i + 1} — не объект`)
    for (const key of ['id', 'from', 'to', 'outcome'] as const) {
      if (typeof e[key] !== 'string') throw new Error(`воркфлоу: переход №${i + 1} — ${key} должен быть строкой`)
    }
  })
  // Форма проверена выше; остальное (типы нод, порты, роли) проверяет validateWorkflow.
  return cloneWorkflow(v as unknown as Workflow)
}

function cloneWorkflow(wf: Workflow): Workflow {
  return JSON.parse(JSON.stringify(wf)) as Workflow
}

/** Граф из projects.json: битый → undefined, старая версия → migrateWorkflow, будущая — как есть. */
function loadedWorkflow(v: unknown): Workflow | undefined {
  if (v === undefined) return undefined
  try {
    return migrateWorkflow(parseWorkflow(v))
  } catch {
    return undefined
  }
}

/** Граф на сохранение: форма, миграция, `validateWorkflow`; ошибки — одним сообщением. */
function checkedWorkflow(v: unknown, ctx: WfValidationContext): Workflow {
  const wf = migrateWorkflow(parseWorkflow(v))
  // Будущую версию validateWorkflow тоже отвергает («обновите приложение»).
  const { errors } = validateWorkflow(wf, ctx)
  // Тексты проблем — из core, по-русски: renderer проверяет граф сам и переводит их по коду до сохранения.
  if (errors.length) throw new OrcaError('workflow.notSaved', { errors: errors.map((e) => e.message).join('; ') })
  return wf
}

// ---------- типы задач ----------

const GENERAL_DESCRIPTION = 'Перенесён из «Настройки → Для новых проектов».'

function emptyProjectsFile(): ProjectsFile {
  return {
    projects: [], activeId: null, version: PROJECTS_FILE_VERSION, taskTypes: presetTaskTypes(), taskTypesSeeded: true,
    onboarding: { status: 'pending', version: ONBOARDING_VERSION }
  }
}

/** Пустое состояние вместо битого файла: человеку с повреждённым состоянием мастер не нужен, ему уже показывают предупреждение. */
function existingUserFile(): ProjectsFile {
  return { ...emptyProjectsFile(), onboarding: { status: 'completed', version: ONBOARDING_VERSION, at: Date.now(), reason: 'existing' } }
}

/**
 * Засев заготовок в библиотеку. `raw` (исходные типы из файла) передаётся только для файла без `taskTypesSeeded`:
 * это файл от версии, где встроенные типы жили в коде, а в projects.json лежали лишь их правки («изменённые
 * встроенные» — типы с id заготовки). Такой файл получает заготовки один раз: в их порядке, правка побеждает
 * заготовку со всем содержимым, дальше — остальные типы. Правка от версии до полной правки встроенных (без
 * `builtinBase`) не могла менять название — ей даётся название заготовки («Общий» → «Программирование»).
 * Уже засеянный файл не трогается: удалённая заготовка не возвращается. Пустая библиотека (все типы битые) — тоже
 * засев: без типа нельзя создать ни проект, ни глобальную задачу.
 */
function seededTaskTypes(types: TaskType[], raw: readonly unknown[] | undefined): TaskType[] {
  if (raw === undefined && types.length) return types
  const renamedByUser = new Set(raw?.flatMap((v) => (isObject(v) && nonEmpty(v.builtinBase) ? [v.id] : [])))
  const presets = presetTaskTypes().map((preset) => {
    const own = types.find((t) => t.id === preset.id)
    if (!own) return preset
    return renamedByUser.has(own.id) ? own : { ...own, title: preset.title }
  })
  return [...presets, ...types.filter((t) => !presets.some((p) => p.id === t.id))]
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/**
 * Патч настроек типа поверх `base`: разрешения — по `PERMISSION_MODES` (null — встроенное `auto`), роли —
 * `validateRoles`, правила из пробелов удаляют поле, граф (null — дефолтный по ролям) проверяется по ролям с
 * учётом этого же патча, колонки нод — нет. Посторонние поля (колонки и агенты старого формата) отбрасываются.
 * `label` — начало текста ошибки.
 */
function validTypeSettings(patch: unknown, base: TaskTypeSettings, label: MText): TaskTypeSettings {
  if (!isObject(patch)) throw new OrcaError('type.settingsNotObject', { label })
  const next: TaskTypeSettings = {
    ...(base.permissionMode ? { permissionMode: base.permissionMode } : {}),
    ...(base.roles ? { roles: base.roles } : {}),
    ...(base.agentRules ? { agentRules: base.agentRules } : {}),
    ...(base.workflow ? { workflow: base.workflow } : {})
  }
  if ('permissionMode' in patch) {
    if (patch.permissionMode == null) delete next.permissionMode
    else if (!isPermissionMode(patch.permissionMode)) throw new OrcaError('type.unknownPermission', { label, mode: String(patch.permissionMode) })
    else next.permissionMode = patch.permissionMode
  }
  if (patch.roles !== undefined) next.roles = validateRoles(patch.roles as Role[])
  if ('agentRules' in patch) {
    const rules = validateAgentRules(patch.agentRules ?? '')
    if (rules) next.agentRules = rules
    else delete next.agentRules
  }
  if ('workflow' in patch) {
    if (patch.workflow == null) delete next.workflow
    else next.workflow = checkedWorkflow(patch.workflow, { roles: next.roles ?? DEFAULT_ROLES })
  }
  return next
}

/**
 * Настройки типа на сохранение. Граф, который уже лежит в типе и не менялся, заново не проверяется: иначе правка
 * ролей, чей граф ссылается на удалённую роль, или любая правка типа с графом будущей версии падала бы. Такой
 * граф исполнитель встретит в рантайме — `workflow_blocked` или дефолтный граф (как у проекта до типов).
 */
function savedTypeSettings(settings: unknown, existing: TaskType | undefined, label: MText): TaskTypeSettings {
  const own = existing?.settings.workflow
  if (!isObject(settings) || !own || JSON.stringify(settings.workflow) !== JSON.stringify(own)) {
    return validTypeSettings(settings, {}, label)
  }
  const { workflow: _wf, ...rest } = settings
  return { ...validTypeSettings(rest, {}, label), workflow: clone(own) }
}

/**
 * Тип из projects.json. Отбрасывается только без id, названия или объекта настроек; разделы настроек чистятся
 * по одному, и битый раздел не уносит с собой остальные (роли, правила и разрешения — то, что человек настраивал
 * руками, и копии в другом месте у них нет). Граф — как в `savedTypeSettings`: только форма и миграция версии, без
 * сверки с ролями. Ссылку на удалённую роль (её пропускал `setRoles` до типов, и её переносит миграция проекта)
 * исполнитель встретит в рантайме, а графа будущей версии он не возьмёт. Поля старых версий (`builtin`,
 * `builtinBase`) отбрасываются: особых типов больше нет.
 */
function loadedTaskType(v: unknown): TaskType[] {
  if (!isObject(v) || !nonEmpty(v.id) || !nonEmpty(v.title) || !isObject(v.settings)) return []
  const raw = v.settings
  const settings: TaskTypeSettings = {}
  if (isPermissionMode(raw.permissionMode)) settings.permissionMode = raw.permissionMode
  const roles = loadedRoles(raw.roles)
  if (roles) settings.roles = roles
  if (typeof raw.agentRules === 'string' && raw.agentRules.trim()) settings.agentRules = raw.agentRules
  const wf = loadedWorkflow(raw.workflow)
  if (wf) settings.workflow = wf
  return [{
    id: v.id, title: v.title,
    ...(typeof v.description === 'string' && v.description.trim() ? { description: v.description } : {}),
    settings
  }]
}

/**
 * Роли типа из projects.json: целиком по `validateRoles`, а если список не проходит — по одной (битые и
 * повторные id выпадают, остальные остаются). Не осталось ни одной — поля нет, тип берёт роли по умолчанию.
 */
function loadedRoles(v: unknown): Role[] | undefined {
  if (!Array.isArray(v)) return undefined
  try {
    return validateRoles(v as Role[])
  } catch {
    const seen = new Set<string>()
    const roles = v.flatMap((r: Role) => {
      try {
        const [role] = validateRoles([r])
        if (seen.has(role.id)) return []
        seen.add(role.id)
        return [role]
      } catch {
        return []
      }
    })
    return roles.length ? roles : undefined
  }
}

/** Название группы: обрезанное по краям, непустое. */
function groupName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!trimmed) throw new OrcaError('projects.groupNameEmpty')
  return trimmed
}

/**
 * Группы из файла: мусор (не объект, нет id или названия, повтор id) отбрасывается, название обрезается, `collapsed`
 * остаётся только как `true`. Ссылки проектов на пропавшие группы снимаются — иначе группа, потерянная из-за битой
 * записи, «воскресла» бы вместе со старой привязкой при появлении такого же id. Файл без групп остаётся без ключа.
 */
function normalizeGroups(data: ProjectsFile): void {
  const raw: unknown[] = Array.isArray(data.groups) ? data.groups : []
  const groups: ProjectGroup[] = []
  for (const g of raw) {
    if (!isObject(g) || !nonEmpty(g.id) || typeof g.name !== 'string' || !g.name.trim() || groups.some((x) => x.id === g.id)) continue
    groups.push({ id: g.id, name: g.name.trim(), ...(g.collapsed === true ? { collapsed: true } : {}) })
  }
  if (groups.length) data.groups = groups
  else delete data.groups
  for (const p of data.projects) if (p.groupId !== undefined && !groups.some((g) => g.id === p.groupId)) delete p.groupId
}

/** Поля проекта нового формата: мусор отбрасывается (тип по умолчанию и доступные типы — строки id). */
function normalizeProject(p: Project): void {
  if (p.taskTypeIds !== undefined && !(Array.isArray(p.taskTypeIds) && p.taskTypeIds.length && p.taskTypeIds.every(nonEmpty))) delete p.taskTypeIds
  if (p.defaultTaskTypeId !== undefined && !nonEmpty(p.defaultTaskTypeId)) delete p.defaultTaskTypeId
  if (p.legacyTypeId !== undefined && !nonEmpty(p.legacyTypeId)) delete p.legacyTypeId
}

/**
 * Нормализация старого формата перед миграцией на типы (как её делал `load()` до типов): назначения системных
 * ролей, нестроковые правила, битые графы проектов; шаблоны проверяются как типы (колонки и агенты
 * отбрасываются); старый `defaults` становится типом «Программирование».
 */
function normalizeLegacy(raw: RawProjectsFile): void {
  const projects = raw.projects as unknown as Array<Record<string, unknown>>
  if (raw.defaults !== undefined && !isObject(raw.defaults)) delete raw.defaults
  for (const p of projects) {
    if (Array.isArray(p.roles)) p.roles = withDefaultDescriptions(p.roles as Role[])
    if (p.agentRules !== undefined && typeof p.agentRules !== 'string') delete p.agentRules
    if (p.permissionMode !== undefined && !isPermissionMode(p.permissionMode)) delete p.permissionMode
    const wf = loadedWorkflow(p.workflow)
    if (wf) p.workflow = wf
    else delete p.workflow
  }
  const templates = Array.isArray(raw.templates) ? raw.templates.flatMap(loadedTaskType) : []
  if (raw.defaultTemplateId !== undefined && !nonEmpty(raw.defaultTemplateId)) delete raw.defaultTemplateId
  // Старый `defaults` (единственный дефолт для новых проектов) → пользовательский тип «Программирование», он же тип по
  // умолчанию. Пустой дефолт ничего не создаёт: заготовка «Программирование» равна ему. Битый — тоже.
  const d = raw.defaults
  delete raw.defaults
  if (d && Object.keys(d).length && !templates.some((t) => t.id === GENERAL_TASK_TYPE_ID)) {
    const general = loadedTaskType({ id: GENERAL_TASK_TYPE_ID, title: presetTaskType(GENERAL_TASK_TYPE_ID)!.title, description: GENERAL_DESCRIPTION, settings: d })
    if (general.length) {
      templates.push(...general)
      raw.defaultTemplateId ??= GENERAL_TASK_TYPE_ID
    }
  }
  raw.templates = templates
}
