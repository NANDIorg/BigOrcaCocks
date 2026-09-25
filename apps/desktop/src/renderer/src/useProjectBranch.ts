import { useEffect, useState } from 'react'
import type { ProjectBranchInfo } from '../../shared/ipc'
import { BRANCH_REFRESH_MS, loadBranchInfo, sameBranchInfo } from './projectBranch'

/**
 * Текущая ветка проекта: читается при смене проекта, при фокусе окна и по таймеру.
 * При смене проекта прежнее значение сбрасывается, чтобы не показать ветку чужого репозитория.
 */
export function useProjectBranch(projectId: string | undefined): ProjectBranchInfo | null {
  const [info, setInfo] = useState<ProjectBranchInfo | null>(null)
  useEffect(() => {
    setInfo(null)
    if (!projectId) return
    let cancelled = false
    const refresh = (): void => {
      void loadBranchInfo(window.orca, projectId).then((next) => {
        if (!cancelled) setInfo((prev) => (sameBranchInfo(prev, next) ? prev : next))
      })
    }
    refresh()
    const timer = setInterval(() => {
      if (!document.hidden) refresh()
    }, BRANCH_REFRESH_MS)
    window.addEventListener('focus', refresh)
    return () => {
      cancelled = true
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [projectId])
  return info
}
