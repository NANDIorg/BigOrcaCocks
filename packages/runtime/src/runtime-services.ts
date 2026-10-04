import { join } from 'node:path'
import { homedir } from 'node:os'
import { coordinatorsToClose, getAgent, type AgentInfo, type Attachment, type TaskStore, type ResolvedRunType } from '@orca-board/core'
import type { ClientCommandContext, RuntimeSettings, RuntimeSettingsPatch } from '@orca-board/contracts'
import { registeredProject, isRegisteredProjectCurrent } from './project-scope.ts'
import { runnableWorkflow, type RuntimeProjectManager } from './projects.ts'
import type { ExecutionResources } from './execution-resources.ts'
import type { WorkerServices, WorkerEnvContext } from './workers.ts'
import type { createSessionRegistry } from './sessions.ts'
import type { createAgentDiscovery } from './agent-discovery.ts'
import { createAgentSelection, type AgentSelectionMessages } from './agent-selection.ts'
import { createWorkerPreflight } from './worker-preflight.ts'
import { createTaskWorkerLifecycle } from './task-worker-lifecycle.ts'
import { createWorkflowServices } from './workflow-services.ts'
import type { WorkflowMessages } from './workflow-messages.ts'
import type { ExecutionMessages } from './execution-messages.ts'
import type { WorkflowDeps } from './workflow.ts'
import type { RunWorkflowDeps } from './workflow-run.ts'
import { createWorkerCommands } from './worker-commands.ts'
import { createWorkerOperations, type WorkerProject } from './worker-operations.ts'
import { createCoordinatorCommands } from './coordinator-commands.ts'
import { createCoordinatorOperations, type CoordinatorProject } from './coordinator-operations.ts'
import { createReviewCommands } from './review-commands.ts'
import { createReviewOperations, type ReviewProject, type ReviewOperationHost } from './review-operations.ts'
import { createHumanRequestCommands } from './human-request-commands.ts'
import { createGlobalTaskRemoval } from './global-task-removal.ts'
import { createGlobalTaskCommands } from './global-task-commands.ts'
import { createBoardCommands } from './board-commands.ts'
import { createProjectGitCommands } from './project-git-commands.ts'
import { createRunCommands } from './run-commands.ts'
import { createAgentCommands } from './agent-commands.ts'
import { createProjectConfigCommands } from './project-config-commands.ts'
import { createProfileCommands, type ProfileCommandHost } from './profile-commands.ts'
import { createSessionCommands } from './session-commands.ts'
import { createSessionWriterLeases } from './session-writer-leases.ts'
import { createRecoveryCommands } from './recovery-commands.ts'
import { createObserverEvents } from './observer-events.ts'
import type { GitProcessService } from './git-process.ts'
import type { EffectJournal } from './effect-journal.ts'
import { obsoleteEffect } from './execution-context.ts'
import type { ShowcaseSnapshots } from './showcase-snapshot.ts'

export interface RuntimeServiceOptions<S extends RuntimeSettings, P extends RuntimeSettingsPatch> {
  projects: RuntimeProjectManager<S, P>
  dataDir: string
  socketPath: string
  ownerId: string
  version: string
  resources: ExecutionResources
  processes: GitProcessService
  journal: EffectJournal
  workers: WorkerServices
  sessions: ReturnType<typeof createSessionRegistry>
  discovery: Pick<ReturnType<typeof createAgentDiscovery>, 'agentInfos'>
  authorize(context: ClientCommandContext, command: string): boolean
  messages: { execution: ExecutionMessages; workflow: WorkflowMessages; selection: AgentSelectionMessages; error(key: 'global.coordinatorAlive' | 'workflow.runFinished' | 'workflow.coordinatorNotRunning'): Error }
  profile: Pick<ProfileCommandHost<S, P>, 'workflowAssistant' | 'settingsKeys'>
  writerLeases?: ReturnType<typeof createSessionWriterLeases>
  sessionEnv?: (projectId?: string) => Record<string, string>
  enableLifecycle?: boolean
  askWaiting?: (questionId: string) => boolean
  stuckMs?: number
}

/** Одна сборка бизнес-служб для Desktop и headless; здесь нет выбора окна и native imports. */
export function createRuntimeServices<S extends RuntimeSettings, P extends RuntimeSettingsPatch>(host: RuntimeServiceOptions<S, P>) {
  const { projects, resources, workers, sessions, authorize } = host
  const { isAlive, killPty, lastActivityAt, silentFor } = sessions
  const { startWorker, startCoordinator, returnToWork } = workers
  const workflowServices = createWorkflowServices({ resources, messages: host.messages.workflow })
  const selection = createAgentSelection(host.messages.selection)
  const preflight = createWorkerPreflight({ selection, launchPolicy: resources, messages: host.messages.execution })
  const taskWorkerLifecycle = createTaskWorkerLifecycle({ isAlive, killPty })
function executionContextFor(projectId: string) {
  const captured = registeredProject(projects, projectId)
  if (!captured) throw new Error(`project not found: ${projectId}`)
  return { projectId, isCurrent: () => !closed && isRegisteredProjectCurrent(projects, captured) }
}

function ctx(projectId: string, runId?: string): WorkerEnvContext {
  return typeCtx(projectId, projects.resolveRun(projectId, runId))
}

function typeCtx(projectId: string, type: ResolvedRunType): WorkerEnvContext {
  return {
    ...executionContextFor(projectId),
    socketPath: host.socketPath,
    projectId,
    permissionMode: type.permissionMode,
    roles: type.roles,
    typeTitle: type.title,
    agentRules: type.agentRules,
    runImagesRoot: resources.runImagesRoot(host.dataDir),
    ...(runnableWorkflow(type.workflow) ? { workflow: runnableWorkflow(type.workflow) } : {})
  }
}

/** Агенты с учётом настроек проекта; refresh — пересканировать PATH. */
function projectAgents(projectId: string, refresh = false): AgentInfo[] {
  return host.discovery.agentInfos(projects.get(projectId)?.enabledAgents, refresh)
}

/** Снимки показа проекта (`<userData>/showcase`, `showcase-snapshot.ts`): пишет `worker.done`, читают IPC `showcase:*`. */
function showcaseSnapshots(projectId: string): ShowcaseSnapshots {
  return { root: join(host.dataDir, 'showcase'), projectId }
}

function resolveProject(projectId?: string): { id: string; root: string; store: TaskStore } {
  const p = projectId ? projects.get(projectId) : projects.active()
  if (!p) throw projectId ? new Error(`project not found: ${projectId}`) : new Error('Проект не выбран')
  return { id: p.id, root: p.root, store: projects.store(p.id) }
}

/** Legacy socket/workflow выбирают проект здесь, проверки и orchestration выполняет runtime. */
function runWorker(taskId: string, projectId?: string, cols?: number, rows?: number, opts: { roleId?: string } = {}): ReturnType<typeof startWorker> {
  const p = resolveProject(projectId)
  return workerOperations.start(workerProject(p.id)!, taskId, { cols, rows, roleId: opts.roleId })
}

/** Host предоставляет ports конкретного проекта; создание callback не запускает workflow. */
function workerProject(projectId: string): WorkerProject | undefined {
  const project = projects.get(projectId)
  return project ? { ...executionContextFor(projectId), store: projects.store(projectId), root: project.root,
    environment: runId => ctx(projectId, runId), agents: () => projectAgents(projectId), workflow: workflowDeps(projectId) } : undefined
}

/**
 * Исполнитель воркфлоу проекта: store, репозиторий, тип прогона задачи (роли и граф) и запуск воркера
 * (docs/workflow.md). Граф будущей версии не исполняется — прогон без снимка пойдёт по дефолтному по ролям.
 */
function workflowDeps(projectId: string): WorkflowDeps {
  const p = resolveProject(projectId)
  return {
    ...executionContextFor(projectId), store: p.store,
    repoRoot: p.root,
    run: (runId) => {
      const t = projects.resolveRun(p.id, runId)
      const workflow = runnableWorkflow(t.workflow)
      return { roles: t.roles, ...(workflow ? { workflow } : {}) }
    },
    startWorker: (taskId, opts) => runWorker(taskId, p.id, undefined, undefined, opts),
    mergeTarget: (task) => resources.mergeTarget(p.store, p.root, task, executionContextFor(projectId))
  }
}

/**
 * Исполнитель воркфлоу глобальных задач проекта (`workflow-run.ts`): те же store, тип прогона и запуск воркера, плюс
 * координатор (его перезапускает граф на входе в «Работу»).
 */
function runWorkflowDeps(projectId: string): RunWorkflowDeps {
  const p = resolveProject(projectId)
  const legacy = workflowDeps(projectId)
  return {
    ...executionContextFor(projectId), store: p.store,
    repoRoot: p.root,
    run: legacy.run,
    startWorker: legacy.startWorker,
    isAlive,
    // Без `startRunWorkflow`: граф уже стоит на «Работе», повторный вход не нужен (и зациклил бы ensureCoordinator).
    startCoordinator: async (runId) => {
      await startCoordinator(p.store, p.root, ctx(p.id, runId), '', undefined, undefined, [], runId)
    },
    ...(legacy.mergeTarget ? { mergeTarget: legacy.mergeTarget } : {})
  }
}

function reviewProject(projectId: string): ReviewProject | undefined {
  const project = projects.get(projectId)
  return project ? { ...executionContextFor(projectId), store: projects.store(projectId), root: project.root, workflow: runWorkflowDeps(projectId) } : undefined
}

async function runCoordinator(
  objective: string,
  projectId?: string,
  cols?: number,
  rows?: number,
  images: Attachment[] = [],
  runId?: string,
  typeId?: string
): Promise<string> {
  const p = resolveProject(projectId)
  return (await coordinatorOperations.start(coordinatorProject(p.id)!, objective, cols, rows, images, runId, typeId)).ptyId
}

/** Host собирает ports одного явного проекта; runtime не знает выбора проекта в окне. */
function coordinatorProject(projectId: string): CoordinatorProject | undefined {
  const project = projects.get(projectId)
  if (!project) return undefined
  return {
    ...executionContextFor(projectId), store: projects.store(projectId), root: project.root,
    environment: runId => ctx(projectId, runId),
    newRunEnvironment: typeId => {
      const type = projects.runType(projectId, typeId)
      return { ...typeCtx(projectId, projects.resolveType(projectId, type.typeId)), type }
    },
    workflow: runWorkflowDeps(projectId)
  }
}

  const removal = {
    resources: resources, dataDir: host.dataDir,
    messages: { error: (key: 'global.coordinatorAlive') => host.messages.error(key) },
    sessions: { isAlive, kill: killPty }
  }
  const globalTaskRemoval = createGlobalTaskRemoval(removal)
  const boardCommands = createBoardCommands({
    project: id => projects.get(id) ? {
      store: projects.store(id), roles: () => projects.resolveRun(id), agents: () => projectAgents(id)
    } : undefined,
    authorize, selection
  })
  const globalTaskCommands = createGlobalTaskCommands({
    ...removal, authorize, selection,
    isCurrent: project => project.isCurrent?.() === true,
    project: id => {
      const project = projects.get(id)
      return project ? {
        ...executionContextFor(id), store: projects.store(id), root: project.root,
        runType: typeId => projects.runType(id, typeId),
        roles: runId => projects.resolveRun(id, runId), agents: () => projectAgents(id)
      } : undefined
    }
  })
  const coordinatorHost = {
    workers: { startCoordinator, returnToWork }, workflow: workflowServices.run,
    resources: resources,
    messages: { error: (key: 'workflow.runFinished' | 'workflow.coordinatorNotRunning') => host.messages.error(key) }
  }
  const coordinatorOperations = createCoordinatorOperations(coordinatorHost)
  const coordinatorCommands = createCoordinatorCommands({ ...coordinatorHost, project: coordinatorProject, authorize, isCurrent: project => project.isCurrent?.() === true })
  const workerHost = { workers: { startWorker }, workflow: workflowServices.task,
    preflight: { validate: preflight.validate }, lifecycle: taskWorkerLifecycle, resources: resources }
  const workerOperations = createWorkerOperations(workerHost)
  const workerCommands = createWorkerCommands({ ...workerHost, project: workerProject, authorize, isCurrent: project => project.isCurrent?.() === true })
  const reviewHost: ReviewOperationHost = { workflow: workflowServices, resources: resources,
    lifecycle: taskWorkerLifecycle, messages: host.messages.execution }
  const reviewOperations = createReviewOperations(reviewHost)
  const reviewCommands = createReviewCommands({ ...reviewHost, project: reviewProject, authorize, isCurrent: project => project.isCurrent?.() === true })
  const humanRequestCommands = createHumanRequestCommands({ ...reviewHost, project: reviewProject, authorize, isCurrent: project => project.isCurrent?.() === true })

  const profileCommands = createProfileCommands<S, P>({ manager: () => projects, authorize, ...host.profile, exportMeta: () => ({ appVersion: host.version, exportedAt: new Date().toISOString() }) })
  const projectConfigCommands = createProjectConfigCommands({ manager: () => projects, authorize })
  const projectGitCommands = createProjectGitCommands({ project: id => projects.get(id), authorize, isCurrent: project => projects.get(project.id) === project, git: resources.git,
    liveAgents: id => projects.store(id).snapshot().dispatches.filter(d => !d.endedAt && isAlive(d.ptyId)).length + projects.store(id).snapshot().runs.filter(r => r.coordinatorPtyId && isAlive(r.coordinatorPtyId)).length })
  const runCommands = createRunCommands({ project: id => projects.get(id) ? { store: projects.store(id) } : undefined, authorize })
  const agentCommands = createAgentCommands({ project: id => projects.get(id), authorize, discovery: host.discovery, preflight, resolveRun: (id, runId) => projects.resolveRun(id, runId), store: id => projects.store(id) })
  const leases = host.writerLeases ?? createSessionWriterLeases({ isAlive })
  const sessionCommands = createSessionCommands({ authorize, project: id => projects.get(id), sessions, journal: () => host.journal, leases, defaultCwd: homedir(),
    env: project => host.sessionEnv?.(project?.id) ?? ({ ORCA_SOCKET: host.socketPath, ...(project ? { ORCA_PROJECT: project.id } : {}), PATH: workers.workerPath() }),
    onExit: (id, code) => projects.loadedStores().forEach(([, store]) => store.ptyExited(id, code)) })
  const recoveryCommands = createRecoveryCommands({ journal: () => host.journal, processes: host.processes, authorize,
    project: id => { const project = projects.get(id); return project ? { ...executionContextFor(id), id, root: project.root, store: projects.store(id) } : undefined }, isCurrent: project => project.isCurrent?.() === true })
  const events = createObserverEvents({ epoch: host.ownerId }); let revision = 0; let closed = false
  const runBranchSync = new resources.RunBranchSync({ isAlive })
  const report = (error: unknown) => { if (!obsoleteEffect(error)) resources.logger.warn('Ошибка общей runtime службы', error instanceof Error ? error.message : String(error)) }
  const pending = new Set<Promise<unknown>>()
  const background = (operation: () => Promise<unknown>) => {
    if (closed) return
    const job = new Promise<void>(resolve => setImmediate(resolve)).then(() => { if (!closed) return operation() }).catch(report)
    pending.add(job); void job.finally(() => pending.delete(job))
  }
  const unsubscribe = [
    projects.onChange((projectId, store) => {
      revision++; events.publish('board.changed', { revision }, projectId)
      if (host.enableLifecycle !== false) { taskWorkerLifecycle.closeDoneWorkers(store); const project = projects.get(projectId); if (project) background(() => runBranchSync.sync(store, project.root, executionContextFor(projectId))) }
    }),
    projects.onDataChange(() => { revision++; events.publish('profile.changed', { revision }) }),
    projects.onWorkflowSaved(saved => events.publish('workflow.saved', saved)),
    sessions.subscribe(event => { if (event.type === 'exit') leases.dropSession(event.ptyId); events.publish(`session.${event.type}`, event) })
  ]
  const timers = new Set<ReturnType<typeof setTimeout>>()
  if (host.enableLifecycle !== false) {
    unsubscribe.push(projects.onEvents((projectId, list) => {
      if (!list.some(e => e.type === 'worker_done' || e.type === 'escalation' || e.type === 'question_answered')) return
      const deps = runWorkflowDeps(projectId); background(async () => { if (deps.isCurrent?.()) await workflowServices.forProject(deps).handleEvents(list) })
    }), projects.onStoreOpened(projectId => {
      const deps = runWorkflowDeps(projectId); background(async () => { if (deps.isCurrent?.()) await workflowServices.forProject(deps).resumeStuckStages() })
    }))
    unsubscribe.push(projects.onEvents((projectId, list) => {
      const store = projects.store(projectId)
      for (const event of list) {
        if (event.type !== 'question_answered' || !event.dispatchId) continue
        const questionId = String(event.payload.questionId ?? '')
        if (host.askWaiting?.(questionId)) continue
        const dispatch = store.getDispatch(event.dispatchId)
        if (!dispatch || dispatch.endedAt || !isAlive(dispatch.ptyId)) continue
        const requestId = typeof event.payload.requestId === 'string' ? event.payload.requestId : undefined
        const command = requestId ? `orca-board request get --request ${requestId}` : `orca-board question get --question ${questionId}`
        sessions.writePty(dispatch.ptyId, `[orca] на вопрос ${questionId} ответили: ${command}`)
        const timer = setTimeout(() => { timers.delete(timer); if (!closed && isAlive(dispatch.ptyId)) sessions.writePty(dispatch.ptyId, '\r') }, 150)
        timers.add(timer); timer.unref()
      }
    }))
    const stuck = setInterval(() => {
      for (const [, store] of projects.loadedStores()) for (const dispatch of store.activeDispatches()) {
        if (isAlive(dispatch.ptyId) && silentFor(dispatch.ptyId) > (host.stuckMs ?? 600_000)) store.markStuck(dispatch.id, silentFor(dispatch.ptyId))
      }
    }, 60_000)
    const finished = setInterval(() => {
      for (const [id, store] of projects.loadedStores()) {
        const snapshot = store.snapshot()
        for (const { ptyId } of coordinatorsToClose({ ...snapshot, isDone: status => store.columnKind(status) === 'done', lingers: agent => agent ? getAgent(agent)?.lingersAfterAnswer === true : false, lastActivityAt, now: Date.now() })) killPty(ptyId)
        store.settleIdleRuns(isAlive)
        if (snapshot.runs.some(workflowServices.run.hasIdleStage)) background(() => workflowServices.run.settleIdleRunStages(runWorkflowDeps(id)))
      }
    }, 5000)
    timers.add(stuck); timers.add(finished); stuck.unref(); finished.unref()
  }
  return {
    projects, resources, workers, sessions, events, leases, workflowServices, taskWorkerLifecycle, globalTaskRemoval,
    boardCommands, globalTaskCommands, coordinatorCommands, coordinatorOperations, workerCommands, workerOperations,
    reviewCommands, humanRequestCommands, reviewOperations, profileCommands, projectConfigCommands, projectGitCommands, runCommands, agentCommands, sessionCommands, recoveryCommands,
    executionContextFor, ctx, typeCtx, projectAgents, showcaseSnapshots, resolveProject, runWorker, workerProject, workflowDeps, runWorkflowDeps, reviewProject, runCoordinator, coordinatorProject,
    get revision() { return revision },
    detach(clientId: string) { leases.dropClient(clientId) },
    async stop() { closed = true; for (const timer of timers) clearTimeout(timer); timers.clear(); for (const off of unsubscribe) off(); events.close(); await Promise.allSettled([...pending]) },
    lastActivityAt, silentFor
  }
}
export type RuntimeServices = ReturnType<typeof createRuntimeServices>
