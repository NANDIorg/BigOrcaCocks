import type { ProjectTemplate } from '@orca-board/core'
import type { OrcaApi, Project, TemplateDetection, TemplatesState } from '../../shared/ipc'

/**
 * Часть `window.orca`, нужная для добавления проекта. Поля необязательные: в `pnpm dev` renderer приходит по HMR,
 * а preload может быть старым — без `projects.detectTemplate` и `templates`.
 */
export interface AddProjectApi {
  projects?: Partial<Pick<OrcaApi['projects'], 'detectTemplate'>>
  templates?: Partial<Pick<OrcaApi['templates'], 'list'>>
}

/** Что делать после выбора папки. */
export type AddProjectStart =
  /** Старый main/preload без шаблонов: прежний `projects.add()` со своим диалогом. */
  | { kind: 'legacy' }
  /** Диалог выбора папки отменён. */
  | { kind: 'cancel' }
  /** Репозиторий уже добавлен (или выбирать не из чего) — `projects.add(undefined, path)` без модалки. */
  | { kind: 'direct'; path: string }
  /** Показать выбор типа с предвыбранным `selected`. */
  | { kind: 'pick'; detection: TemplateDetection; templates: ProjectTemplate[]; defaultTemplateId: string; selected: string }

/** Preload новый, а main старый — invoke падает с «No handler registered for 'projects:detectTemplate'». */
export function isStaleTemplatesError(message: string): boolean {
  return /No handler registered for '(projects:detectTemplate|templates:)/.test(message)
}

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

/** Предвыбор: угаданный тип, иначе шаблон по умолчанию, иначе первый в списке. */
export function preselectedTemplate(state: TemplatesState, detected?: string): string {
  const has = (id: string | undefined): id is string => !!id && state.templates.some((t) => t.id === id)
  if (has(detected)) return detected
  if (has(state.defaultTemplateId)) return state.defaultTemplateId
  return state.templates[0]?.id ?? ''
}

/**
 * Начало «Добавить репозиторий»: диалог выбора папки (в main), подсказка типа и решение, нужна ли модалка.
 * Ошибки, кроме «старого main», пробрасываются.
 */
export async function startAddProject(api: AddProjectApi | undefined, projects: Pick<Project, 'id' | 'root'>[]): Promise<AddProjectStart> {
  const detect = api?.projects?.detectTemplate
  const list = api?.templates?.list
  if (typeof detect !== 'function' || typeof list !== 'function') return { kind: 'legacy' }
  let detection: TemplateDetection | null
  try {
    detection = await detect()
  } catch (e) {
    if (isStaleTemplatesError(e instanceof Error ? e.message : String(e))) return { kind: 'legacy' }
    throw e
  }
  if (!detection) return { kind: 'cancel' }
  if (findProjectForPath(projects, detection.path)) return { kind: 'direct', path: detection.path }
  const state = await list()
  if (!state.templates.length) return { kind: 'direct', path: detection.path }
  return {
    kind: 'pick',
    detection,
    templates: state.templates,
    defaultTemplateId: state.defaultTemplateId,
    selected: preselectedTemplate(state, detection.templateId)
  }
}
