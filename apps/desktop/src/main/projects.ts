import { createProjectServices } from '@orca-board/runtime'
import type { AppSettings, AppSettingsPatch } from '../shared/ipc'
import { OrcaError, mt } from './i18n'
import { desktopProjectSettings } from './project-settings'
import { gitProcesses } from './git'

/** Единственный набор классов Desktop: instanceof сохраняется в IPC и сокете. */
export const { ProjectManager, WorkflowValidationError } = createProjectServices<AppSettings, AppSettingsPatch>({
  messages: { Error: OrcaError, text: mt },
  settings: desktopProjectSettings, processes: gitProcesses
})
export type ProjectManager = InstanceType<typeof ProjectManager>
export type WorkflowValidationError = InstanceType<typeof WorkflowValidationError>

export { PROJECTS_BACKUP_NAME, PROJECTS_WORKFLOW_BACKUP_NAME, runnableWorkflow } from '@orca-board/runtime'
export type { Project, ProjectsFile, StoredOnboarding, PermissionMode } from '@orca-board/runtime'
export { DEFAULT_APP_SETTINGS } from './project-settings'
