import type { TaskTypeFileMeta, WorkflowCreateInput, WorkflowRoleSelection } from '@orca-board/core'
import { NOTIFY_KINDS, type ClientCommandContext, type ProfileCommands, type ProfileCommandName,
  type RuntimeSettings, type RuntimeSettingsPatch, type TaskTypeInput, type TaskTypePatch, type NodeTemplateInput } from '@orca-board/contracts'
import type { RuntimeProjectManager } from './projects.ts'
import { createClientCommandExecutor, type ClientCommandHost } from './project-commands.ts'
import { createAsyncClientCommandExecutor } from './async-client-commands.ts'
import { commandObject, commandString, commandOptionalString, commandBoolean, commandArray, invalidCommandField } from './profile-command-input.ts'
import type { createWorkflowAssistantServices } from './workflow-assistant.ts'

export interface ProfileCommandHost<S extends RuntimeSettings, P extends RuntimeSettingsPatch> extends ClientCommandHost<ProfileCommandName> {
  manager(): RuntimeProjectManager<S, P>
  workflowAssistant: ReturnType<typeof createWorkflowAssistantServices>
  exportMeta(): TaskTypeFileMeta
  /** Расширение настроек принадлежит проверенному host, client не расширяет schema. */
  settingsKeys?: readonly string[]
}
const settingsKeys = ['permissionMode', 'roles', 'agentRules', 'workflow']
function typePatch(input: unknown, notes = true): Record<string, unknown> {
  const patch = commandObject(input, [...settingsKeys, ...(notes ? ['workflowNotes'] : [])], 'settings')
  commandOptionalString(patch.permissionMode ?? undefined, 'permissionMode')
  commandOptionalString(patch.agentRules ?? undefined, 'agentRules', false)
  if (patch.roles != null) commandArray(patch.roles, 'roles', (role, field) => {
    const value = commandObject(role, ['id', 'title', 'agent', 'model', 'effort', 'description', 'systemPrompt', 'extraArgs'], field)
    for (const key of ['id', 'title', 'agent']) commandString(value[key], `${field}.${key}`)
    for (const key of ['model', 'effort', 'description', 'systemPrompt', 'extraArgs']) commandOptionalString(value[key], `${field}.${key}`, false)
    return value
  })
  if (patch.workflowNotes !== undefined) commandArray(patch.workflowNotes, 'workflowNotes', (note, field) => {
    const value = commandObject(note, ['code', 'message', 'nodeId', 'edgeId'], field)
    commandString(value.code, `${field}.code`); commandString(value.message, `${field}.message`, false)
    commandOptionalString(value.nodeId, `${field}.nodeId`); commandOptionalString(value.edgeId, `${field}.edgeId`)
    return value
  })
  return patch
}

function runtimePatch<P extends RuntimeSettingsPatch>(input: unknown, hostKeys: readonly string[]): P {
  const value = commandObject(input, ['language', 'assistant', 'appearance', 'notifications', ...hostKeys], 'settings')
  commandOptionalString(value.language, 'language')
  if (value.assistant !== undefined) {
    const assistant = commandObject(value.assistant, ['agent', 'model', 'effort', 'systemPrompt', 'extraArgs'], 'assistant')
    for (const key of Object.keys(assistant)) commandOptionalString(assistant[key], `assistant.${key}`, false)
  }
  if (value.appearance !== undefined) {
    const appearance = commandObject(value.appearance, ['theme', 'motion', 'highSaturation'], 'appearance')
    commandOptionalString(appearance.theme, 'appearance.theme'); commandOptionalString(appearance.motion, 'appearance.motion')
    if (appearance.highSaturation !== undefined) commandBoolean(appearance.highSaturation, 'appearance.highSaturation')
  }
  if (value.notifications !== undefined) {
    const notifications = commandObject(value.notifications, ['enabled', 'roles', 'events', 'onlyWhenUnfocused', 'sound', 'quietHours', 'showPreview'], 'notifications')
    for (const key of ['enabled', 'onlyWhenUnfocused', 'sound', 'showPreview']) {
      if (notifications[key] !== undefined) commandBoolean(notifications[key], `notifications.${key}`)
    }
    for (const key of ['roles', 'events']) if (notifications[key] !== undefined) {
      const raw = notifications[key]
      const keys = typeof raw === 'object' && raw !== null ? Object.keys(raw) : []
      const nested = commandObject(raw, key === 'events' ? NOTIFY_KINDS : keys, `notifications.${key}`)
      for (const [id, flag] of Object.entries(nested)) commandBoolean(flag, `notifications.${key}.${id}`)
    }
    if (notifications.quietHours !== undefined) {
      const quiet = commandObject(notifications.quietHours, ['enabled', 'from', 'to'], 'notifications.quietHours')
      if (quiet.enabled !== undefined) commandBoolean(quiet.enabled, 'notifications.quietHours.enabled')
      commandOptionalString(quiet.from, 'notifications.quietHours.from'); commandOptionalString(quiet.to, 'notifications.quietHours.to')
    }
  }
  return value as P
}

export function createProfileCommands<S extends RuntimeSettings, P extends RuntimeSettingsPatch>(host: ProfileCommandHost<S, P>): ProfileCommands<S, P> {
  const execute = createClientCommandExecutor(host)
  const executeAsync = createAsyncClientCommandExecutor(host)
  type Manager = RuntimeProjectManager<S, P>
  function run<T>(context: ClientCommandContext, name: keyof ProfileCommands, validate: () => (manager: Manager) => T): T {
    return execute(context, `profile.${name}`, () => {
      const operation = validate()
      return () => operation(host.manager())
    })
  }
  function byId<T>(context: ClientCommandContext, name: keyof ProfileCommands, id: string, operation: (manager: Manager, id: string) => T): T {
    return run(context, name, () => { const key = commandString(id, 'id'); return manager => operation(manager, key) })
  }
  function selection(input: unknown): WorkflowRoleSelection {
    const value = commandObject(input ?? {}, ['typeId', 'baseTypeId'], 'selection')
    commandOptionalString(value.typeId, 'typeId'); commandOptionalString(value.baseTypeId, 'baseTypeId')
    return value as WorkflowRoleSelection
  }
  return {
    listProjects: ctx => run(ctx, 'listProjects', () => pm => ({ projects: pm.list(), groups: pm.groups() })),
    addProject: (ctx, root, typeId) => executeAsync(ctx, 'profile.addProject', () => {
      const path = commandString(root, 'root'); const type = commandOptionalString(typeId, 'typeId')
      return (_, scope) => host.manager().add(path, type, false, scope.guard)
    }),
    removeProject: (ctx, id) => byId(ctx, 'removeProject', id, (pm, key) => pm.remove(key)),
    detectTaskType: (ctx, root) => run(ctx, 'detectTaskType', () => { const path = commandString(root, 'root'); return pm => pm.detectTaskType(path) }),
    inProgressCounts: ctx => run(ctx, 'inProgressCounts', () => pm => pm.inProgressCounts()),
    groups: ctx => run(ctx, 'groups', () => pm => pm.groups()),
    createGroup: (ctx, name) => run(ctx, 'createGroup', () => { const text = commandString(name, 'name', false); return pm => pm.createGroup(text) }),
    renameGroup: (ctx, id, name) => run(ctx, 'renameGroup', () => {
      const key = commandString(id, 'id'); const text = commandString(name, 'name', false); return pm => pm.renameGroup(key, text)
    }),
    removeGroup: (ctx, id) => byId(ctx, 'removeGroup', id, (pm, key) => pm.removeGroup(key)),
    setGroupCollapsed: (ctx, id, collapsed) => run(ctx, 'setGroupCollapsed', () => {
      const key = commandString(id, 'id'); const flag = commandBoolean(collapsed, 'collapsed'); return pm => pm.setGroupCollapsed(key, flag)
    }),
    reorderGroups: (ctx, ids) => run(ctx, 'reorderGroups', () => { const keys = commandArray(ids, 'ids', commandString); return pm => pm.reorderGroups(keys) }),
    settings: ctx => run(ctx, 'settings', () => pm => pm.settings()),
    setSettings: (ctx, patch) => run(ctx, 'setSettings', () => { const value = runtimePatch<P>(patch, host.settingsKeys ?? []); return pm => pm.setSettings(value) }),
    onboardingState: ctx => run(ctx, 'onboardingState', () => pm => pm.onboardingState()),
    completeOnboarding: (ctx, input) => run(ctx, 'completeOnboarding', () => {
      const value = commandObject(input ?? {}, ['skipped'], 'onboarding')
      if (value.skipped !== undefined) commandBoolean(value.skipped, 'skipped')
      return pm => pm.completeOnboarding(value)
    }),
    taskTypes: ctx => run(ctx, 'taskTypes', () => pm => pm.taskTypesState()),
    saveTaskType: (ctx, input) => run(ctx, 'saveTaskType', () => {
      const value = commandObject(input, ['id', 'title', 'description', 'settings', 'workflowNotes'], 'type')
      commandOptionalString(value.id, 'id'); commandString(value.title, 'title', false); commandOptionalString(value.description, 'description', false)
      value.settings = typePatch(value.settings ?? {}, false)
      if (value.workflowNotes !== undefined) typePatch({ workflowNotes: value.workflowNotes })
      return pm => pm.saveTaskType(value as unknown as TaskTypeInput)
    }),
    patchTaskType: (ctx, id, patch) => run(ctx, 'patchTaskType', () => {
      const key = commandString(id, 'id'); const value = typePatch(patch) as TaskTypePatch; return pm => pm.patchTaskType(key, value)
    }),
    renameTaskType: (ctx, id, title, description) => run(ctx, 'renameTaskType', () => {
      const key = commandString(id, 'id'); const text = commandString(title, 'title', false); const desc = commandString(description, 'description', false)
      return pm => pm.renameTaskType(key, { title: text, description: desc })
    }),
    deleteTaskType: (ctx, id) => byId(ctx, 'deleteTaskType', id, (pm, key) => pm.deleteTaskType(key)),
    duplicateTaskType: (ctx, id) => byId(ctx, 'duplicateTaskType', id, (pm, key) => pm.duplicateTaskType(key)),
    setDefaultTaskType: (ctx, id) => byId(ctx, 'setDefaultTaskType', id, (pm, key) => pm.setDefaultTaskType(key)),
    exportTaskType: (ctx, id) => byId(ctx, 'exportTaskType', id, (pm, key) => pm.exportTaskType(key, host.exportMeta())),
    nodeTemplates: ctx => run(ctx, 'nodeTemplates', () => pm => pm.nodeTemplates()),
    saveNodeTemplate: (ctx, input) => run(ctx, 'saveNodeTemplate', () => {
      const value = commandObject(input, ['id', 'title', 'description', 'node'], 'template')
      commandOptionalString(value.id, 'id'); commandString(value.title, 'title', false); commandOptionalString(value.description, 'description', false)
      return pm => pm.saveNodeTemplate(value as unknown as NodeTemplateInput)
    }),
    deleteNodeTemplate: (ctx, id) => byId(ctx, 'deleteNodeTemplate', id, (pm, key) => pm.deleteNodeTemplate(key)),
    workflowGet: (ctx, id) => byId(ctx, 'workflowGet', id, (pm, key) => pm.workflowGet(key)),
    workflowValidate: (ctx, definition, input) => run(ctx, 'workflowValidate', () => {
      const roles = selection(input); const value = structuredClone(definition); return pm => pm.workflowValidate(value, roles)
    }),
    workflowSet: (ctx, id, revision, definition) => run(ctx, 'workflowSet', () => {
      const key = commandString(id, 'typeId'); const rev = commandString(revision, 'revision'); const value = structuredClone(definition)
      return pm => pm.workflowSet(key, rev, value)
    }),
    workflowCreate: (ctx, input) => run(ctx, 'workflowCreate', () => {
      const value = commandObject(input, ['title', 'description', 'baseTypeId', 'definition'], 'workflow')
      commandString(value.title, 'title', false); commandOptionalString(value.description, 'description', false); commandOptionalString(value.baseTypeId, 'baseTypeId')
      return pm => pm.workflowCreate(value as unknown as WorkflowCreateInput)
    }),
    saveWorkflowDraft: (ctx, id, baseline, workflow) => run(ctx, 'saveWorkflowDraft', () => {
      const key = commandString(id, 'typeId'); const base = structuredClone(baseline); const value = structuredClone(workflow)
      return pm => host.workflowAssistant.saveWorkflowDraft(pm, key, base, value)
    }),
    workflowContext: (ctx, input) => run(ctx, 'workflowContext', () => {
      const value = commandObject(input, ['mode', 'typeId', 'title', 'workflow', 'baseline', 'dirty', 'path'], 'context')
      if (value.mode === 'create') commandObject(value, ['mode'], 'context')
      else if (value.mode === 'edit') {
        commandString(value.typeId, 'typeId'); commandString(value.title, 'title', false)
        commandBoolean(value.dirty, 'dirty'); commandArray(value.path, 'path', (id, field) => commandString(id, field, false))
      } else invalidCommandField('mode')
      return pm => host.workflowAssistant.buildWorkflowAssistantContext(pm, value)
    })
  }
}
