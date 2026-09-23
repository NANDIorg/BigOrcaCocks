import type { TaskType } from '@orca-board/core'
import type { OrcaApi, Project, TaskTypeDetection, TaskTypesState } from '../../shared/ipc'
import { isStaleTaskTypesError } from './taskTypes'

/**
 * Часть `window.orca`, нужная для добавления проекта. Поля необязательные: в `pnpm dev` renderer приходит по HMR,
 * а preload может быть старым — без `projects.detectTaskType` и `taskTypes`.
 */
export interface AddProjectApi {
  projects?: Partial<Pick<OrcaApi['projects'], 'detectTaskType'>>
  taskTypes?: Partial<Pick<OrcaApi['taskTypes'], 'list'>>
}

/** Что делать после выбора папки. */
export type AddProjectStart =
  /** Старый main/preload без типов задач: прежний `projects.add()` со своим диалогом. */
  | { kind: 'legacy' }
  /** Диалог выбора папки отменён. */
  | { kind: 'cancel' }
  /** Репозиторий уже добавлен (или выбирать не из чего) — `projects.add(undefined, path)` без модалки. */
  | { kind: 'direct'; path: string }
  /** Показать выбор типа по умолчанию с предвыбранным `selected`. */
  | { kind: 'pick'; detection: TaskTypeDetection; types: TaskType[]; defaultTypeId: string; selected: string }

function trimSeparators(p: string): string {
  return p.length > 1 ? p.replace(/[\\/]+$/, '') : p
}

/**
 * Проект, в чей репозиторий попадает выбранная папка: main нормализует путь до корня git, а renderer git не
 * запускает, поэтому «уже добавлен» — папка совпадает с корнем проекта или лежит внутри него.
 */
export function findProjectForPath(projects: Pick<Project, 'id' | 'root'>[], path: string): Pick<Project, 'id' | 'root'> | undefined {
  const dir = trimSeparators(path)
  return projects.find((p) => {
    const root = trimSeparators(p.root)
    return dir === root || dir.startsWith(root + '/') || dir.startsWith(root + '\\')
  })
}

/** Предвыбор: угаданный тип, иначе тип библиотеки по умолчанию, иначе первый в списке. */
export function preselectedType(state: TaskTypesState, detected?: string): string {
  const has = (id: string | undefined): id is string => !!id && state.taskTypes.some((t) => t.id === id)
  if (has(detected)) return detected
  if (has(state.defaultTaskTypeId)) return state.defaultTaskTypeId
  return state.taskTypes[0]?.id ?? ''
}

/**
 * Начало «Добавить репозиторий»: диалог выбора папки (в main), подсказка типа и решение, нужна ли модалка.
 * Ошибки, кроме «старого main», пробрасываются.
 */
export async function startAddProject(api: AddProjectApi | undefined, projects: Pick<Project, 'id' | 'root'>[]): Promise<AddProjectStart> {
  const detect = api?.projects?.detectTaskType
  const list = api?.taskTypes?.list
  if (typeof detect !== 'function' || typeof list !== 'function') return { kind: 'legacy' }
  let detection: TaskTypeDetection | null
  try {
    detection = await detect()
  } catch (e) {
    if (isStaleTaskTypesError(e instanceof Error ? e.message : String(e))) return { kind: 'legacy' }
    throw e
  }
  if (!detection) return { kind: 'cancel' }
  if (findProjectForPath(projects, detection.path)) return { kind: 'direct', path: detection.path }
  const state = await list()
  if (!state.taskTypes.length) return { kind: 'direct', path: detection.path }
  return {
    kind: 'pick',
    detection,
    types: state.taskTypes,
    defaultTypeId: state.defaultTaskTypeId,
    selected: preselectedType(state, detection.typeId)
  }
}
