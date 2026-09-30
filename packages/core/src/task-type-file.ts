// Файл экспорта типа задач (docs/architecture.md → «Типы задач» → «Файл экспорта типа»): один JSON со снимком
// эффективных настроек типа — теми значениями, с которыми пойдёт глобальная задача. Здесь только построение текста
// файла и его имени; диалог «Сохранить как» и запись — в main.
// Модуль импортирует renderer, поэтому без node-импортов; значения импортируются с расширением .ts.
import type { Role } from './types'
import type { WfNode, Workflow } from './workflow'
import type { TaskType, TaskTypePermissionMode, TaskTypeSettings } from './task-types'
import { resolveTaskType } from './task-types.ts'

/** Метка формата: отличает файл типа от файла графа (экспорт воркфлоу) и от чужого JSON. */
export const TASK_TYPE_FILE_FORMAT = 'orca-board.task-type'

/** Версия формата файла (не графа: у графа своя, `Workflow.version`). Поднимается при несовместимой правке. */
export const TASK_TYPE_FILE_VERSION = 1

/** То, чего чистая функция знать не может: версия приложения и время экспорта. Передаёт вызывающий код. */
export interface TaskTypeFileMeta {
  /** Версия приложения (`app.getVersion()`). */
  appVersion: string
  /** Время экспорта, ISO 8601. */
  exportedAt: string
}

/**
 * Настройки типа в файле — те же `TaskTypeSettings`, но роли, граф и режим разрешений есть всегда: значения по
 * умолчанию раскрыты, файл читается без знания встроенных значений приложения. `agentRules` — только непустые.
 */
export interface TaskTypeFileSettings extends TaskTypeSettings {
  permissionMode: TaskTypePermissionMode
  roles: Role[]
  workflow: Workflow
}

/**
 * Тип в файле: по форме — вход сохранения типа (`TaskTypeInput` в apps/desktop/src/shared/ipc.ts) без `id`, так что
 * импорт сводится к сохранению `file.type` с обычной валидацией. `id` и `workflowNotes` в файл не попадают.
 */
export interface TaskTypeFileType {
  title: string
  description?: string
  settings: TaskTypeFileSettings
}

export interface TaskTypeFile {
  format: typeof TASK_TYPE_FILE_FORMAT
  formatVersion: number
  exportedAt: string
  appVersion: string
  type: TaskTypeFileType
}

/**
 * Снять `templateId` у нод: это ссылка на локальную библиотеку шаблонов, на другой машине она никуда не ведёт.
 * Правит переданные ноды на месте — звать только на своей копии. Путь подзадачи (`work.subflow`) — тоже ноды.
 */
function dropTemplateIds(nodes: WfNode[]): void {
  for (const node of nodes) {
    delete node.templateId
    // Граф не валидируется (бэкап сломанного типа тоже нужен), поэтому форму пути проверяем сами.
    if (node.type === 'work' && Array.isArray(node.subflow?.nodes)) dropTemplateIds(node.subflow.nodes)
  }
}

/**
 * Файл типа целиком. Роли, граф и режим разрешений раскрыты через `resolveTaskType` (нет своих — `DEFAULT_ROLES`,
 * `defaultWorkflow(roles)`, `auto`); всё — глубокие копии, правка файла не меняет тип. Название и описание — как
 * хранятся (после `trim`), без перевода заготовок: в файле данные, а не подписи интерфейса. Граф не валидируется
 * и не мигрируется: его версия, позиции нод и колонки (`node.column`) сохраняются как есть.
 */
export function buildTaskTypeFile(type: TaskType, meta: TaskTypeFileMeta): TaskTypeFile {
  const resolved = resolveTaskType(type)
  if (Array.isArray(resolved.workflow.nodes)) dropTemplateIds(resolved.workflow.nodes)
  const description = type.description?.trim()
  return {
    format: TASK_TYPE_FILE_FORMAT,
    formatVersion: TASK_TYPE_FILE_VERSION,
    exportedAt: meta.exportedAt,
    appVersion: meta.appVersion,
    type: {
      title: type.title.trim(),
      ...(description ? { description } : {}),
      settings: {
        permissionMode: resolved.permissionMode,
        roles: resolved.roles,
        ...(resolved.agentRules.trim() ? { agentRules: resolved.agentRules } : {}),
        workflow: resolved.workflow
      }
    }
  }
}

/** Текст файла: UTF-8, отступ 2 пробела, перевод строки в конце. */
export function serializeTaskTypeFile(file: TaskTypeFile): string {
  return JSON.stringify(file, null, 2) + '\n'
}

/** Сколько символов названия типа попадает в имя файла. */
const FILE_NAME_TITLE_LIMIT = 60

/**
 * Сколько байт UTF-8 названия типа попадает в имя файла. Предел имени файла на ext4 и большинстве ФС Linux — 255 байт,
 * а не символов, и запись идёт через временный `<имя>.tmp` (`writeFileAtomic` в main): `task-type-` (10) + название +
 * `.json` (5) + `.tmp` (4) должны уложиться в 255, то есть названию остаётся 236. 200 — с запасом под суффикс,
 * который человек или ОС допишет к имени (` (1)`, `.bak`). 60 символов кириллицы (120 байт) и иероглифов (180) проходят
 * целиком, режутся только четырёхбайтовые (эмодзи): 50 вместо 60.
 */
const FILE_NAME_TITLE_BYTE_LIMIT = 200

/** Края названия в имени файла: дефисы от замены и точки (Windows не хранит имя с точкой на конце). */
const FILE_NAME_EDGES = /^[-.]+|[-.]+$/g

/**
 * Длина символа (кодовой точки) в байтах UTF-8. Считается по кодовой точке, без `Buffer` и `TextEncoder`: модуль
 * импортирует renderer, а в core нет типов ни node, ни DOM. Одиночный суррогат при записи станет U+FFFD — те же 3 байта.
 */
function utf8Length(char: string): number {
  const code = char.codePointAt(0) ?? 0
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  return code < 0x10000 ? 3 : 4
}

/**
 * Имя файла типа: `task-type-<название>.json`. В названии запрещённые в именах файлов символы (`\ / : * ? " < > |`),
 * управляющие символы и пробелы заменяются на `-`, края (`-`, `.`) срезаются, длина — не больше 60 символов и не
 * больше 200 байт UTF-8 (действует то, что строже); кириллица остаётся. Пустое название — `task-type.json`. Префикс
 * заодно уводит от зарезервированных имён Windows (`CON`, `NUL`…).
 */
export function taskTypeFileName(title: string): string {
  const slug = title.replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\s]+/g, '-').replace(FILE_NAME_EDGES, '')
  // По кодовым точкам, а не по UTF-16: обрезка не разрывает суррогатную пару (эмодзи в названии) и многобайтовый символ.
  const chars: string[] = []
  let bytes = 0
  for (const char of Array.from(slug).slice(0, FILE_NAME_TITLE_LIMIT)) {
    bytes += utf8Length(char)
    if (bytes > FILE_NAME_TITLE_BYTE_LIMIT) break
    chars.push(char)
  }
  const short = chars.join('').replace(FILE_NAME_EDGES, '')
  return short ? `task-type-${short}.json` : 'task-type.json'
}
