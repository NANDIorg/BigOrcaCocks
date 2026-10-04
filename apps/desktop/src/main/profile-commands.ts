import type { AgentKind, BoardColumn, Workflow } from '@orca-board/core'
import type { ClientCommandContext, ProfileCommands, ProjectConfigCommands, Project, ProjectTaskTypesInput, TaskTypeInput, TaskTypePatch, NodeTemplateInput, OnboardingCompleteInput } from '@orca-board/contracts'
import type { AppSettings, AppSettingsPatch } from '../shared/ipc'
import { OrcaError } from './i18n'
import { invokeDesktopCommand as invoke, type DesktopCommandHandle } from './project-command-adapter'
import { exportTaskTypeToFile, type TaskTypeExportDeps } from './task-type-export'

export interface DesktopProfileCommandHost<Event> {
  commands: ProfileCommands<AppSettings, AppSettingsPatch>
  config: ProjectConfigCommands
  clientId(event: Event): string | null
  activeProject(): Project | null
  setActive(id: string): Project
  chooseFolder(): Promise<string | null>
  chooseExportFile: TaskTypeExportDeps['chooseFile']
  writeExport: TaskTypeExportDeps['write']
  settingsChanged(settings: AppSettings): void
}

/** Общий API не имеет selection/native dialogs; старые IPC сохраняют их в Desktop. */
export function registerDesktopProfileCommands<Event>(handle: DesktopCommandHandle<Event>, host: DesktopProfileCommandHost<Event>): void {
  function context(event: Event): ClientCommandContext {
    const clientId = host.clientId(event)
    if (typeof clientId !== 'string' || !clientId.trim()) throw new OrcaError('command.forbidden')
    return { clientId, actor: { kind: 'operator', id: 'local-user' } }
  }
  const project = (event: Event, projectId: string) => ({ ...context(event), projectId })
  const c = host.commands
  handle('app:getSettings', event => invoke(() => c.settings(context(event))))
  handle('app:setSettings', (event, patch: AppSettingsPatch) => invoke(() => {
    const settings = c.setSettings(context(event), patch ?? {}); host.settingsChanged(settings); return settings
  }))
  handle('onboarding:getState', event => invoke(() => c.onboardingState(context(event))))
  handle('onboarding:complete', (event, input?: OnboardingCompleteInput) => invoke(() => c.completeOnboarding(context(event), input)))
  handle('projects:list', event => invoke(() => {
    const result = c.listProjects(context(event)); return { ...result, active: structuredClone(host.activeProject()) }
  }))
  handle('projects:createGroup', (event, name: string) => invoke(() => c.createGroup(context(event), name)))
  handle('projects:renameGroup', (event, id: string, name: string) => invoke(() => c.renameGroup(context(event), id, name)))
  handle('projects:removeGroup', (event, id: string) => invoke(() => c.removeGroup(context(event), id)))
  handle('projects:setGroupCollapsed', (event, id: string, flag: boolean) => invoke(() => c.setGroupCollapsed(context(event), id, flag)))
  handle('projects:reorderGroups', (event, ids: string[]) => invoke(() => c.reorderGroups(context(event), ids)))
  handle('projects:setProjectGroup', (event, id: string, groupId: string | null) => invoke(() => host.config.setGroup(project(event, id), groupId)))
  handle('projects:inProgressCounts', event => invoke(() => c.inProgressCounts(context(event))))
  handle('projects:setActive', (event, id: string) => invoke(() => { context(event); return structuredClone(host.setActive(id)) }))
  handle('projects:remove', (event, id: string) => invoke(() => c.removeProject(context(event), id)))
  handle('projects:setEnabledAgents', (event, id: string, agents: AgentKind[]) => invoke(() => host.config.setEnabledAgents(project(event, id), agents)))
  handle('projects:setColumns', (event, id: string, columns: BoardColumn[]) => invoke(() => host.config.setColumns(project(event, id), columns)))
  handle('projects:setTaskTypes', (event, id: string, input: ProjectTaskTypesInput) => invoke(() => host.config.setTaskTypes(project(event, id), input)))
  handle('projects:add', async (event, typeId?: string, path?: string) => {
    const ctx = context(event)
    const root = typeof path === 'string' && path ? path : await host.chooseFolder()
    if (!root) return null
    return invoke(async () => {
      const saved = await c.addProject(ctx, root, typeof typeId === 'string' && typeId ? typeId : undefined)
      context(event)
      host.setActive(saved.id); return saved
    })
  })
  handle('projects:detectTaskType', async (event, path?: string) => {
    const ctx = context(event); const root = typeof path === 'string' && path ? path : await host.chooseFolder()
    return root ? invoke(() => c.detectTaskType(ctx, root)) : null
  })
  handle('taskTypes:list', event => invoke(() => c.taskTypes(context(event))))
  handle('taskTypes:patch', (event, id: string, patch: TaskTypePatch) => invoke(() => c.patchTaskType(context(event), id, patch)))
  handle('taskTypes:rename', (event, id: string, title: string, description: string) => invoke(() => c.renameTaskType(context(event), id, title, description)))
  handle('workflowAssistant:save', (event, id: string, baseline: Workflow, workflow: Workflow | null) => invoke(() => c.saveWorkflowDraft(context(event), id, baseline, workflow)))
  handle('taskTypes:save', (event, input: TaskTypeInput) => invoke(() => c.saveTaskType(context(event), input)))
  handle('taskTypes:delete', (event, id: string) => invoke(() => c.deleteTaskType(context(event), id)))
  handle('taskTypes:duplicate', (event, id: string) => invoke(() => c.duplicateTaskType(context(event), id)))
  handle('taskTypes:setDefault', (event, id: string) => invoke(() => c.setDefaultTaskType(context(event), id)))
  handle('taskTypes:export', (event, id: string) => {
    const ctx = context(event)
    return exportTaskTypeToFile({ export: typeId => invoke(() => c.exportTaskType(ctx, typeId)), chooseFile: host.chooseExportFile, write: host.writeExport }, id)
  })
  handle('nodeTemplates:list', event => invoke(() => c.nodeTemplates(context(event))))
  handle('nodeTemplates:save', (event, input: NodeTemplateInput) => invoke(() => c.saveNodeTemplate(context(event), input)))
  handle('nodeTemplates:delete', (event, id: string) => invoke(() => c.deleteNodeTemplate(context(event), id)))
}
