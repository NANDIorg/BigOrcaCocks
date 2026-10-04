import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BuiltinPrompts } from '@orca-board/core'
import type { ClientCommandContext, OperatorProduct } from '@orca-board/contracts'
import { startProfileRuntime } from './profile-runtime.ts'
import { assertProfileSchemas } from './profile-preflight.ts'
import { createEffectJournal } from './effect-journal.ts'
import { createMutationLedger } from './mutation-ledger.ts'
import { backupOnProductVersionChange } from './backup.ts'
import { createGitProcessService } from './git-process.ts'
import { createGitOperations } from './git.ts'
import { createRuntimeSettings } from './settings.ts'
import { createProjectServices } from './projects.ts'
import { createExecutionResources } from './execution-resources.ts'
import { createWorkerServices } from './workers.ts'
import { createAgentLauncher } from './agent-launch.ts'
import { createAgentDiscovery } from './agent-discovery.ts'
import { createRuntimeServices } from './runtime-services.ts'
import { createWorkflowAssistantServices } from './workflow-assistant.ts'
import { createSessionRegistry, defaultShell, type PtyFactory } from './sessions.ts'
import { createRuleServices } from './rules.ts'
import { createRuleCommands } from './rule-commands.ts'
import { createStatsServices } from './stats.ts'
import { createStatsCommands, statsProjectDeps } from './stats-commands.ts'
import { registeredProject, isRegisteredProjectCurrent } from './project-scope.ts'
import { createProjectFileServices } from './project-files.ts'
import { createDocServices } from './docs.ts'
import { createDocViewServices } from './docs-view.ts'
import { createPreviewServices, createSchemePreviewAddress, PreviewTokens, type PreviewAddress } from './preview.ts'
import { createShowcaseServices } from './showcase.ts'
import { createShowcaseSnapshotServices } from './showcase-snapshot.ts'
import { createFileCommands } from './file-commands.ts'
import { createAssistantConversationServices } from './assistant-conversation.ts'
import { createDialogRepository } from './dialog-repository.ts'
import { DialogRegistry } from './dialog-registry.ts'
import { createDialogCommands } from './dialog-commands.ts'
import { assistantEnv, assistantCwd } from './launch-policy.ts'
import { createAgentSelection } from './agent-selection.ts'
import { missingRoleText } from './launch-policy.ts'
import { createAgentSocketServices } from './agent-socket.ts'
import { createLegacySocketDeps } from './legacy-socket-deps.ts'
import { createOperatorApi } from './operator-api.ts'

class RuntimeMessageError extends Error {
  readonly key: string
  constructor(key: string, params?: Record<string, unknown>) { super(`Ошибка Orca (${key})${params?.reason ? `: ${String(params.reason)}` : ''}`); this.key = key }
}
export interface OrcaRuntimeOptions {
  dataDir: string
  socketPath: string
  cliBinDir: string
  product: OperatorProduct
  prompts: BuiltinPrompts
  native: { spawn: PtyFactory }
  authorize(context: ClientCommandContext, command: string): boolean
  env?: NodeJS.ProcessEnv
  homeDir?: string
  nodePath?: string
  warn?(message: string, detail?: string): void
  agentSocket?: boolean
  previewAddress?: PreviewAddress
}

/** Полная Node composition; Electron/PTY backend/авторизацию выбирает host. Импорт ничего не запускает. */
export async function createOrcaRuntime(options: OrcaRuntimeOptions) {
  return startProfileRuntime({ dataDir: options.dataDir, start: async owner => {
    let active = true
    const authorize: OrcaRuntimeOptions['authorize'] = (context, command) => active && options.authorize(context, command)
    assertProfileSchemas(owner.dataDir)
    const journal = createEffectJournal({ dataDir: owner.dataDir, ownerId: owner.owner.instanceId })
    const ledger = createMutationLedger({ dataDir: owner.dataDir, ownerId: owner.owner.instanceId })
    // Journal/ledger schema validation тоже предшествует созданию backup и миграциям старого профиля.
    backupOnProductVersionChange(owner.dataDir, options.product)
    const processes = createGitProcessService(); owner.deferCleanup(processes.stop)
    const error = (key: string, params?: Record<string, unknown>) => new RuntimeMessageError(key, params)
    const messages = { Error: RuntimeMessageError, text: (key: string) => key === 'docs.project' ? 'Проект' : `Orca: ${key}` }
    const git = createGitOperations({ error, untrackedLabel: () => 'Новые файлы' }, undefined, processes, () => journal)
    const resources = createExecutionResources({ messages: { error }, git, journal: () => journal, logger: { warn: options.warn ?? (() => {}) } })
    const { ProjectManager, WorkflowValidationError } = createProjectServices({ messages, settings: createRuntimeSettings(messages), processes })
    const projects = new ProjectManager(owner.dataDir)
    const sessions = createSessionRegistry({ spawn: options.native.spawn }); owner.deferCleanup(sessions.stop)
    const env = options.env ?? process.env; const home = options.homeDir ?? homedir()
    const discovery = createAgentDiscovery({ env, home })
    const launcher = createAgentLauncher({ settingsInvalid: path => new Error(`Не удалось прочитать настройки агента: ${path}`) }); owner.deferCleanup(launcher.dispose)
    const workers = createWorkerServices({ resources, messages: { error }, sessions, launcher, host: {
      dataDir: owner.dataDir, cliBinDir: options.cliBinDir, nodePath: options.nodePath ?? process.execPath, prompts: options.prompts,
      env, language: () => projects.settings().language ?? 'ru', shell: defaultShell, extraPathDirs: discovery.extraPathDirs,
      launchOptions: () => ({ electronNode: options.nodePath, systemPromptFile: () => { const dir = join(owner.dataDir, 'tmp', 'system-prompts'); mkdirSync(dir, { recursive: true }); return join(dir, `${randomUUID()}.md`) } })
    } })
    let agentSocket: ReturnType<typeof createAgentSocketServices> | undefined
    const services = createRuntimeServices({ projects, resources, workers, sessions, discovery, processes, journal,
      dataDir: owner.dataDir, socketPath: options.socketPath, ownerId: owner.owner.instanceId, version: options.product.version, authorize,
      messages: { execution: { error }, selection: { error }, workflow: { error, text: messages.text, displayError: cause => cause instanceof Error ? cause.message : String(cause) }, error },
      askWaiting: id => agentSocket?.askWaiting(id) ?? false,
      profile: { workflowAssistant: createWorkflowAssistantServices({ messages }) }
    })
    owner.deferCleanup(services.stop)
    const rules = createRuleServices({ messages }); const ruleCommands = createRuleCommands({ project: id => projects.get(id), authorize, rules })
    const project = (id: string) => registeredProject(projects, id); const isCurrent = (p: NonNullable<ReturnType<typeof project>>) => isRegisteredProjectCurrent(projects, p)
    const statsCommands = createStatsCommands({ project, isCurrent, authorize, messages, stats: createStatsServices({ messages }),
      deps: p => statsProjectDeps(projects, p, { isAlive: sessions.isAlive }), workflow: (p, taskId) => projects.resolveRun(p.id, p.store.getTask(taskId)?.runId).workflow })
    const files = createProjectFileServices({ messages, gitCheckIgnore: git.gitCheckIgnore }); const preview = createPreviewServices(options.previewAddress ?? createSchemePreviewAddress('orca-preview'))
    const docs = createDocServices({ messages, processes }); const view = createDocViewServices({ messages, files, preview }); const showcase = createShowcaseServices({ messages, preview })
    const fileCommands = createFileCommands({ project, isCurrent, authorize, files, docs, view, showcase, tokens: new PreviewTokens(), snapshots: services.showcaseSnapshots,
      branch: p => git.currentBranch(p.root), native: { open: () => { throw new Error('Этот host не поддерживает native open') }, reveal: () => { throw new Error('Этот host не поддерживает native reveal') } } })
    const conversations = createAssistantConversationServices({ messages: key => `Ошибка диалога (${key})`, env: () => env, homeDir: home, executablePath: options.nodePath ?? process.execPath, platform: process.platform }); owner.deferCleanup(conversations.stop)
    const registry = new DialogRegistry({ repository: createDialogRepository(join(owner.dataDir, 'dialogs.json')), errors: {
      unknown: () => new Error('Диалог не найден'), emptyText: () => new Error('Введите сообщение'), readOnly: () => new Error('Начните новый диалог'), storage: cause => new Error('Ошибка сохранения диалога', { cause })
    }, create: (settings, onUpdate, projectId) => {
      const launch = resources.assistantLaunch(settings, options.prompts.assistant, projects.settings().language ?? 'ru')
      const cwd = projectId ? projects.get(projectId)?.root : assistantCwd(owner.dataDir)
      if (!cwd) throw new Error('Проект не найден'); mkdirSync(cwd, { recursive: true })
      return conversations.create({ agent: launch.agent, system: launch.system, model: launch.model, effort: launch.effort, extraArgs: launch.extraArgs, cwd, projectId,
        env: assistantEnv({ socketPath: options.socketPath, path: workers.workerPath(), nodePath: options.nodePath ?? process.execPath }), onUpdate })
    } })
    owner.deferCleanup(() => registry.dispose())
    const dialogCommands = createDialogCommands({ registry, authorize, project: id => projects.get(id), settings: () => projects.settings().assistant,
      assertUsable: agent => { const selected: ReturnType<typeof createAgentSelection> = createAgentSelection({ error }); selected.assertAgentUsable(discovery.agentInfos(undefined), agent) } })
    const snapshots = createShowcaseSnapshotServices()
    agentSocket = createAgentSocketServices({ sessions, selection: createAgentSelection({ error }), missingRoleMessage: (role, type) => { const message = missingRoleText(role, type); return `Роль не найдена: ${message.params?.roleId ?? role}` }, validation: cause => cause instanceof WorkflowValidationError ? cause.validation : undefined })
    owner.deferCleanup(agentSocket.stop)
    if (options.agentSocket !== false) {
      const server = agentSocket.startSocketServer(options.socketPath, createLegacySocketDeps(services, rules, snapshots.snapshotDispatchShowcase))
      await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    }
    const dialogsOff = new Map<string, () => void>()
    const registerDialog = (id: string) => { if (!dialogsOff.has(id)) dialogsOff.set(id, registry.subscribe(id, event => services.events.publish('dialog.changed', { id, revision: event.revision }, registry.snapshot(id).dialog.projectId))) }
    const groups = { profile: services.profileCommands, projectConfig: services.projectConfigCommands, board: services.boardCommands, globalTask: services.globalTaskCommands,
      coordinator: services.coordinatorCommands, worker: services.workerCommands, review: services.reviewCommands, humanRequest: services.humanRequestCommands,
      projectGit: services.projectGitCommands, run: services.runCommands, agent: services.agentCommands, session: services.sessionCommands, recovery: services.recoveryCommands,
      rules: ruleCommands, stats: statsCommands, files: fileCommands, dialog: dialogCommands }
    const { metadata, operator } = createOperatorApi({ groups, product: options.product, ownerId: owner.owner.instanceId, ledger, events: services.events, preview: Boolean(options.previewAddress),
      getRevision: (_projectId, dialogId) => dialogId ? registry.snapshot(dialogId).dialog.revision : services.revision,
      authorize, authorizeProject: (ctx, id) => Boolean(projects.get(id)) && authorize(ctx, 'project.access'), onDetach: ctx => services.detach(ctx.clientId), onDialog: registerDialog })
    owner.deferCleanup(() => { for (const off of dialogsOff.values()) off() })
    let shutdown: Promise<void> | undefined
    const beginStop = () => {
      if (shutdown) return shutdown
      active = false; registry.dispose()
      shutdown = Promise.all([agentSocket!.stop(), services.stop(), conversations.stop(), sessions.stop(), processes.stop()]).then(() => undefined)
      void shutdown.catch(() => { shutdown = undefined })
      return shutdown
    }
    owner.deferCleanup(beginStop)
    return { ...services, get revision() { return services.revision }, ledger, registry, operator, metadata, fileCommands, ruleCommands, statsCommands, dialogCommands, agentSocket, beginStop }
  } })
}
