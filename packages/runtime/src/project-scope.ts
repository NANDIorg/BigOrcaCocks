import type { TaskStore } from '@orca-board/core'
import type { Project } from '@orca-board/contracts'
import type { RuntimeProjectManager } from './projects.ts'

export interface RegisteredProject { id: string; root: string; store: TaskStore; registration: Project }
type ProjectManager = Pick<RuntimeProjectManager, 'get' | 'store' | 'loadedStores'>

export function registeredProject(manager: ProjectManager, id: string): RegisteredProject | undefined {
  const registration = manager.get(id)
  return registration ? { id, root: registration.root, store: manager.store(id), registration } : undefined
}
export function isRegisteredProjectCurrent(manager: ProjectManager, project: RegisteredProject): boolean {
  // Id — hash пути: remove + add может оставить прежний id/store, но заменяет registration.
  return manager.get(project.id) === project.registration && project.registration.root === project.root
    && manager.loadedStores().some(([id, store]) => id === project.id && store === project.store)
}
