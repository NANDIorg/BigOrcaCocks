import { TEMPLATE_SECTIONS, type AgentInfo, type ProjectTemplate, type TemplateSection } from '@orca-board/core'
import type { OrcaApi, Project, TaskRef } from '../../shared/ipc'
import { plural } from './plural'
import { applyPreview, templateDiffRows, type ApplyPreview } from './projectType'

// «Настройки → Шаблоны проектов → Применить к проектам…» (settings/BulkApplyModal.tsx): какие проекты отстали от
// шаблона, что с каждым случится и применение по одному через `projects:applyTemplate`. Без React — ради node --test.

/** Проект в диалоге массового применения. */
export interface BulkCandidate {
  project: Project
  /** Проект этого типа (`Project.templateId`), а не просто проект из списка. */
  own: boolean
  /** Разделы, которыми проект отличается от шаблона (`sectionsDiff`); пусто — совпадает. */
  differs: TemplateSection[]
}

/** Все проекты против шаблона: сначала проекты этого типа, внутри групп — порядок списка проектов. */
export function bulkCandidates(projects: readonly Project[], template: ProjectTemplate, agents: AgentInfo[]): BulkCandidate[] {
  const all = projects.map((project) => ({
    project,
    own: project.templateId === template.id,
    differs: templateDiffRows(project, template.settings, agents).map((r) => r.section)
  }))
  return [...all.filter((c) => c.own), ...all.filter((c) => !c.own)]
}

/** «Шаблон используют N проектов, у M отличаются» — по проектам этого типа. */
export function usageSummary(candidates: readonly BulkCandidate[]): { users: number; differ: number } {
  const own = candidates.filter((c) => c.own)
  return { users: own.length, differ: own.filter((c) => c.differs.length).length }
}

/** Текст подсказки в шапке шаблона; пусто — отстающих проектов нет, подсказка не нужна. */
export function usageHint({ users, differ }: { users: number; differ: number }): string {
  if (!differ) return ''
  const who = `${users} ${plural(users, 'проект', 'проекта', 'проектов')}`
  return differ === users
    ? `Шаблон используют ${who}, все отличаются от него.`
    : `Шаблон используют ${who}, у ${differ} настройки отличаются.`
}

/**
 * Выбор при открытии: отмечены отстающие проекты этого типа, разделы — те, чем они отличаются
 * (в порядке `TEMPLATE_SECTIONS`). Отличий нет — все разделы.
 */
export function initialSelection(candidates: readonly BulkCandidate[]): { projectIds: string[]; sections: TemplateSection[] } {
  const lagging = candidates.filter((c) => c.own && c.differs.length)
  const sections = TEMPLATE_SECTIONS.filter((s) => lagging.some((c) => c.differs.includes(s)))
  return { projectIds: lagging.map((c) => c.project.id), sections: sections.length ? sections : [...TEMPLATE_SECTIONS] }
}

/** Последствия для одного проекта; `tasks` null — задачи неизвестны (старый main), счётчики не показываются. */
export function bulkPreview(
  project: Project,
  template: ProjectTemplate,
  sections: readonly TemplateSection[],
  tasks: readonly TaskRef[] | null
): ApplyPreview | null {
  return sections.length ? applyPreview(project, template.settings, { sections: [...sections] }, tasks ?? []) : null
}

/** Отмеченные проекты, которые можно применить: граф пройдёт проверку. Порядок — как в списке кандидатов. */
export function applicableIds(
  candidates: readonly BulkCandidate[],
  selected: ReadonlySet<string>,
  previews: ReadonlyMap<string, ApplyPreview | null>
): string[] {
  return candidates
    .map((c) => c.project.id)
    .filter((id) => selected.has(id) && previews.get(id) != null && previews.get(id)?.error === null)
}

/** `projects.taskRefs`, если его знает preload; null — старый preload, последствия без счётчиков задач. */
export function taskRefsApi(api: Partial<OrcaApi> | undefined): OrcaApi['projects']['taskRefs'] | null {
  return api?.projects?.taskRefs ?? null
}

/** Итог по проекту: null — применено, строка — ошибка main. */
export type BulkResults = Record<string, string | null>

/**
 * Применить по очереди, не останавливаясь на ошибке: проекты независимы, упавший не мешает остальным.
 * Параллельно нельзя — main пишет один projects.json.
 */
export async function applyEach(
  ids: readonly string[],
  apply: (id: string) => Promise<unknown>,
  message: (e: unknown) => string,
  onProgress?: (results: BulkResults) => void
): Promise<BulkResults> {
  const results: BulkResults = {}
  for (const id of ids) {
    try {
      await apply(id)
      results[id] = null
    } catch (e) {
      results[id] = message(e)
    }
    onProgress?.({ ...results })
  }
  return results
}

/** Итог одной строкой: сколько применено и сколько нет. */
export function resultsText(results: BulkResults): string {
  const values = Object.values(results)
  const ok = values.filter((v) => v === null).length
  const failed = values.length - ok
  const done = `Применено к ${ok} ${plural(ok, 'проекту', 'проектам', 'проектам')}`
  return failed ? `${done}, не удалось — ${failed}: ошибки у проектов в списке.` : `${done}.`
}
