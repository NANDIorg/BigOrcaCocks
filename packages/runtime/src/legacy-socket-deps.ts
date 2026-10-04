import type { AgentKind } from '@orca-board/core'
import type { RuntimeServices } from './runtime-services.ts'
import type { SocketDeps } from './agent-socket.ts'
import type { createRuleServices } from './rules.ts'
import type { createShowcaseSnapshotServices } from './showcase-snapshot.ts'

/** Legacy callbacks используют тот же graph, что operator commands; platform updates остаются callback хоста. */
export function createLegacySocketDeps(services: RuntimeServices, rules: ReturnType<typeof createRuleServices>, snapshotDispatchShowcase: ReturnType<typeof createShowcaseSnapshotServices>['snapshotDispatchShowcase'], onSettingsChanged?: () => void): SocketDeps {
  return {
    libraryTaskTypes: () => ({ taskTypes: services.projects.taskTypes(), defaultTypeId: services.projects.defaultTaskTypeId() }),
    workflowGet: (id) => services.projects.workflowGet(id),
    workflowValidate: (definition, selection) => services.projects.workflowValidate(definition, selection),
    workflowSet: (id, revision, definition) => services.projects.workflowSet(id, revision, definition),
    workflowCreate: (input) => services.projects.workflowCreate(input),
    resolve: (projectId) => {
      const p = services.resolveProject(projectId)
      return {
        store: p.store,
        startWorker: (taskId) => services.runWorker(taskId, p.id),
        stopWorker: (taskId) => services.workerOperations.stop({ ...p, projectId: p.id }, taskId),
        review: (taskId) => services.reviewOperations.info(services.reviewProject(p.id)!, taskId),
        accept: (taskId, decision) => services.reviewOperations.decide(services.reviewProject(p.id)!, taskId, 'accept', decision),
        reject: (taskId, feedback) => services.reviewOperations.decide(services.reviewProject(p.id)!, taskId, 'reject', feedback),
        finishStage: (runId, summary, nodeId) => services.workflowServices.run.finishRunStage(services.runWorkflowDeps(p.id), runId, summary, nodeId),
        decide: (taskId, option, reason) => services.workflowServices.run.runDecision(services.runWorkflowDeps(p.id), taskId, option, reason),
        escalateDecision: (taskId, reason) => services.workflowServices.run.escalateDecision(services.runWorkflowDeps(p.id), taskId, reason),
        resolveRequest: (id, resolution) => services.reviewOperations.resolve(services.reviewProject(p.id)!, id, resolution),
        startCoordinator: (objective, runId, typeId) => services.runCoordinator(objective, p.id, undefined, undefined, [], runId, typeId),
        deleteGlobalTask: (runId, cascade) => services.globalTaskRemoval({ ...p, ...services.executionContextFor(p.id) }, runId, cascade),
        snapshotShowcase: (dispatchId, files, text) => snapshotDispatchShowcase(p.store, services.showcaseSnapshots(p.id), dispatchId, files, text),
        agents: () => services.projectAgents(p.id),
        resolveRun: (runId) => services.projects.resolveRun(p.id, runId),
        taskTypes: () => ({ taskTypes: services.projects.projectTaskTypes(p.id), defaultTypeId: services.projects.projectDefaultTypeId(p.id) }),
        runType: (typeId) => services.projects.runType(p.id, typeId),
        saveTaskTypeRules: (typeId, roleId, text) => services.projects.saveTaskTypeRules(typeId, roleId, text),
        columns: () => services.projects.columns(p.id),
        workflow: (typeId) => services.projects.taskTypeWorkflow(typeId ?? services.projects.projectDefaultTypeId(p.id)),
        // Настройки: библиотека типов задач, роли, шаблоны нод — общая для всех проектов, `p` только определяет,
        // через какой проект команда пришла (docs/assistant-chat.md → «2. Контракт CLI/сокета для настроек»).
        typesCreate: (input) => services.projects.saveTaskType({ ...input, settings: {} }),
        typesRename: (id, patch) => services.projects.renameTaskType(id, patch),
        typesSetDefault: (id) => services.projects.setDefaultTaskType(id),
        typesDuplicate: (id) => services.projects.duplicateTaskType(id),
        typesUsage: (id) => services.projects.taskTypeUsage(id),
        typesDelete: (id) => services.projects.deleteTaskType(id),
        rolesAdd: (typeId, input) => services.projects.addRole(typeId, input),
        rolesUpdate: (typeId, roleId, patch) => services.projects.updateRole(typeId, roleId, patch),
        rolesRemove: (typeId, roleId) => services.projects.removeRole(typeId, roleId),
        permissionMode: (typeId) => services.projects.permissionMode(typeId),
        setPermissionMode: (typeId, mode) => {
          services.projects.patchTaskType(typeId, { permissionMode: mode })
          return services.projects.permissionMode(typeId)
        },
        nodeTemplates: () => services.projects.nodeTemplates(),
        deleteNodeTemplate: (id) => services.projects.deleteNodeTemplate(id),
        setActive: () => services.projects.setActive(p.id),
        removeProject: () => {
          services.projects.remove(p.id)
          return { removed: p.id }
        },
        // Сокет уже сверил id с реестром агентов (project.agents.set в socket.ts) — здесь как есть.
        setEnabledAgents: (ids) => services.projects.setEnabledAgents(p.id, ids as AgentKind[]),
        setColumns: (columns) => services.projects.setColumns(p.id, columns),
        setProjectTaskTypes: (input) => services.projects.setProjectTaskTypes(p.id, input),
        projectRulesGet: (file) => rules.readRule(p.root, file),
        projectRulesSet: (file, text) => rules.writeRule(p.root, file, text)
      }
    },
    projects: () => {
      const activeId = services.projects.active()?.id
      const counts = services.projects.inProgressCounts()
      return services.projects.list().map((p) => {
        const type = services.projects.projectDefaultType(p.id)
        return {
          id: p.id,
          name: p.name,
          root: p.root,
          active: p.id === activeId,
          inProgress: counts[p.id] ?? 0,
          defaultTypeId: type.id,
          defaultTypeTitle: type.title
        }
      })
    },
    settings: () => services.projects.settings(),
    // Как `app:setSettings` в registerIpc: язык, трей и апдейтер должны узнать о правке независимо от того,
    // пришла ли она из renderer или от ассистента через `settings set`.
    setSettings: (patch) => {
      const settings = services.projects.setSettings(patch)
      onSettingsChanged?.()
      return settings
    }
  }
}
