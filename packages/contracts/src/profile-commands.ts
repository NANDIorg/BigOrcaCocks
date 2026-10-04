import type { TaskType, WfNodeTemplate, Workflow, WorkflowTypeContext, WorkflowPreparation, WorkflowSaveResult, WorkflowCreateInput, WorkflowRoleSelection } from '@orca-board/core'
import type { ClientCommandContext } from './project-commands.ts'
import type { RuntimeSettings, RuntimeSettingsPatch, OnboardingState, OnboardingCompleteInput } from './settings.ts'
import type { Project, ProjectGroup } from './projects.ts'
import type { TaskTypeInput, TaskTypePatch, TaskTypesState, NodeTemplateInput, TaskTypeDetection } from './tasks.ts'

/** Библиотека и настройки не зависят от выбранного проекта конкретного клиента. */
export interface ProfileCommands<S extends RuntimeSettings = RuntimeSettings, P extends RuntimeSettingsPatch = RuntimeSettingsPatch> {
  listProjects(context: ClientCommandContext): { projects: Project[]; groups: ProjectGroup[] }
  addProject(context: ClientCommandContext, root: string, typeId?: string): Promise<Project>
  removeProject(context: ClientCommandContext, projectId: string): void
  detectTaskType(context: ClientCommandContext, root: string): TaskTypeDetection
  inProgressCounts(context: ClientCommandContext): Record<string, number>
  groups(context: ClientCommandContext): ProjectGroup[]
  createGroup(context: ClientCommandContext, name: string): ProjectGroup
  renameGroup(context: ClientCommandContext, id: string, name: string): ProjectGroup
  removeGroup(context: ClientCommandContext, id: string): void
  setGroupCollapsed(context: ClientCommandContext, id: string, collapsed: boolean): ProjectGroup
  reorderGroups(context: ClientCommandContext, ids: string[]): ProjectGroup[]
  settings(context: ClientCommandContext): S
  setSettings(context: ClientCommandContext, patch: P): S
  onboardingState(context: ClientCommandContext): OnboardingState
  completeOnboarding(context: ClientCommandContext, input?: OnboardingCompleteInput): OnboardingState
  taskTypes(context: ClientCommandContext): TaskTypesState
  saveTaskType(context: ClientCommandContext, input: TaskTypeInput): TaskType
  patchTaskType(context: ClientCommandContext, id: string, patch: TaskTypePatch): TaskType
  renameTaskType(context: ClientCommandContext, id: string, title: string, description: string): TaskType
  deleteTaskType(context: ClientCommandContext, id: string): TaskTypesState
  duplicateTaskType(context: ClientCommandContext, id: string): TaskType
  setDefaultTaskType(context: ClientCommandContext, id: string): TaskTypesState
  exportTaskType(context: ClientCommandContext, id: string): { fileName: string; text: string }
  nodeTemplates(context: ClientCommandContext): WfNodeTemplate[]
  saveNodeTemplate(context: ClientCommandContext, input: NodeTemplateInput): WfNodeTemplate
  deleteNodeTemplate(context: ClientCommandContext, id: string): WfNodeTemplate[]
  workflowGet(context: ClientCommandContext, typeId: string): WorkflowTypeContext
  workflowValidate(context: ClientCommandContext, definition: unknown, selection?: WorkflowRoleSelection): WorkflowPreparation
  workflowSet(context: ClientCommandContext, typeId: string, revision: string, definition: unknown): WorkflowSaveResult
  workflowCreate(context: ClientCommandContext, input: WorkflowCreateInput): WorkflowSaveResult
  saveWorkflowDraft(context: ClientCommandContext, typeId: string, baseline: Workflow, workflow: Workflow | null): void
  workflowContext(context: ClientCommandContext, input: unknown): string
}

export type ProfileCommandName = `profile.${keyof ProfileCommands}`
