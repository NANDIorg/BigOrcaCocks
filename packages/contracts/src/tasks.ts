import type { AnswerAudience, TaskPriority, HumanRequest, TaskType, TaskTypeSettings, WfMigrationNote, WfTemplateNode } from '@orca-board/core'

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

/** Узкая правка настроек над актуальным типом main. */
export type TaskTypePatch = { [K in keyof TaskTypeSettings]?: TaskTypeSettings[K] | null } & { workflowNotes?: WfMigrationNote[] }

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
