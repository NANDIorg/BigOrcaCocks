import type { OrcaApi, ProjectBranchInfo } from '../../shared/ipc'
import { t } from './i18n'

/** Как часто перечитывать ветку, пока окно открыто: переключение `git checkout` в терминале видно без перезапуска. */
export const BRANCH_REFRESH_MS = 12_000

/** Что показать в бейдже: `label` — текст, `mark` — пометка рядом (detached HEAD), `title` — полная подсказка. */
export interface BranchBadge {
  label: string
  mark?: string
  title: string
  detached: boolean
}

/**
 * Текст бейджа ветки. Не git-репозиторий или пустой ответ — null (бейдж не рисуется).
 * Длинное имя не режем здесь: обрезку делает CSS (`text-overflow`), а полное имя лежит в `title`.
 */
export function branchBadge(info: ProjectBranchInfo | null | undefined): BranchBadge | null {
  if (!info?.isGitRepo) return null
  if (info.detached) {
    const sha = info.sha || 'HEAD'
    return { label: sha, mark: t('shell.branch.detached'), title: t('shell.branch.detachedTitle', { sha }), detached: true }
  }
  if (!info.branch) return null
  return { label: info.branch, title: t('shell.branch.title', { name: info.branch }), detached: false }
}

/** Одинаковые ответы не должны перерисовывать шапку при каждом опросе. */
export function sameBranchInfo(a: ProjectBranchInfo | null, b: ProjectBranchInfo | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.isGitRepo === b.isGitRepo && a.branch === b.branch && a.detached === b.detached && a.sha === b.sha
}

/**
 * Ветка проекта через `window.orca.projects.branch`. Старый preload (метода нет) или старый main
 * (`No handler registered for 'projects:branch'`) — null: бейдж просто не показывается, шапка не падает.
 */
export async function loadBranchInfo(api: Partial<OrcaApi> | undefined, projectId: string): Promise<ProjectBranchInfo | null> {
  const branch = api?.projects?.branch
  if (typeof branch !== 'function') return null
  try {
    return await branch(projectId)
  } catch {
    return null
  }
}
