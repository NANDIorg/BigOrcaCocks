import { existsSync } from 'node:fs'
import {
  DECISION_REASON_LIMIT, RunApprovalAmbiguousError, decisionOptions, forkBranches, globalTaskTitle, renderGitTemplate, runAskTaskSpec, runAskTaskTitle, runDecisionTaskSpec,
  runDecisionTaskTitle, runGateTaskSpec, runGateTaskTitle, runPositionAt, runPositions, wfGitVars, wfNodeTitle, statusSource, withStatusSource,
  type GlobalTask, type HumanRequest, type OrcaEvent, type Role, type Run, type RunAction, type RunPathStep, type RunPosition,
  type RunStageOptions, type RunStepResult, type RunTaskContext, type StageChange, type StageDecision, type StageDecisionFallback, type Task,
  type TaskStore, type WfAction, type WfDecisionOption, type WfNode, type WfPort, type Workflow
} from '@orca-board/core'
import { showcaseMarkdown } from '@orca-board/contracts'
import type { MergeTargetOf } from './review.ts'
import { findOption } from './request-params.ts'
import type { TaskWorkflowServices } from './workflow.ts'
import type { ExecutionResources } from './execution-resources.ts'
import type { WorkflowMessages } from './workflow-messages.ts'
import { executionProject, obsoleteEffect, type ExecutionContext } from './execution-context.ts'
import type { EffectScope } from './effect-scope.ts'
import { GitProcessError } from './git-process.ts'
import { CommandError } from './project-commands.ts'

// Исполнитель воркфлоу глобальной задачи (docs/workflow.md → «Воркфлоу глобальной задачи»): позицию на графе хранит
// `Run.stage`, переходы делает store (`advanceRunStage`, `finishStage`), здесь выполняются эффекты нод — событие и
// перезапуск координатора на «Работе», задачи проверки, вопроса и решения ветки, запросы человеку, git, слияние ветки
// прогона в базу.
// Подзадачи по графу прогона не ходят: каждая идёт по пути своей ноды «Работа» (`work.subflow`, по умолчанию
// `defaultSubflow()`: воркер → мерж в ветку прогона → конец), его исполняет движок по подзадачам (`workflow.ts`, `Task.stage`).
// Внутри разветвления (`fork` … `join`) позиций несколько (`Run.lanes`): переход store отдаёт список действий (`RunAction`),
// эффекты исполняются по каждому, решение по ноде идёт с её `nodeId` — store двигает только путь на этой ноде. Позицию ноды
// сверяет `runPositionAt`, а не `Run.stage` (при путях он стоит на `fork`).
// Событие и задачу делят по `taskEngine`: здесь — только то, что он отдаёт прогону (проверки и вопросы этапов, подзадачи вне
// этапа). Прогоны без `Run.workflowScope: 'run'` идут прежним движком (`workflow.ts`); этот модуль их не трогает.

export interface RunWorkflowDeps extends ExecutionContext {
  store: TaskStore
  repoRoot: string
  /** Тип прогона сейчас (`resolveRunType`): роли — для проверок и вопросов, граф типа — запасной для прогона без снимка. */
  run(runId: string | undefined): { roles: Role[]; workflow?: Workflow }
  /** Запуск воркера задачи с проверками роли и агента (`runWorker` в index.ts). */
  startWorker(taskId: string, opts?: { roleId?: string }): { ptyId: string; dispatchId: string } | Promise<{ ptyId: string; dispatchId: string }>
  /** Жив ли терминал (`isAlive` из `pty.ts`): координатор или воркер. */
  isAlive(ptyId: string): boolean
  /**
   * (Пере)запуск координатора глобальной задачи: тот же запуск, что «Запустить координатора» (цель — с блоком «# Этап»,
   * `resumeObjective`). Не вызывает `startRunWorkflow`. Бросает, если координатор не запустился.
   */
  startCoordinator(runId: string): void | Promise<void>
  /** Куда сливать ветку подзадачи (`mergeTarget` в `run-branch.ts`). Нет — текущая ветка корня (тесты). */
  mergeTarget?: MergeTargetOf
}

/**
 * Id ноды в approval «Конфликт мержа» подзадачи, созданном сборкой до пути подзадачи (тогда автомерж был зашит в движок
 * прогона). Новые конфликты — нода `conflict` пути (`defaultSubflow()`), но запрос, ждавший человека при обновлении,
 * дорешивает `legacyConflictResolved`: задача входит в путь и идёт к ноде `merge`.
 */
export const SUBTASK_MERGE_NODE = 'subtask-merge'

export interface RunWorkflowServiceDeps {
  resources: ExecutionResources
  workflow: TaskWorkflowServices
  messages: WorkflowMessages
}

/** Эффекты графа прогона; запуск и liveness задаёт host. */
export function createRunWorkflowServices({ resources, workflow, messages }: RunWorkflowServiceDeps) {
  const { workflowGit } = resources.git
  const capture = (deps: RunWorkflowDeps, runId?: string, nodeId?: string, laneId?: string) => resources.effects.capture(executionProject(deps.store, deps.repoRoot, deps), { runId, nodeId, laneId }, { source: 'workflow' })
  function commit<T>(deps: RunWorkflowDeps, operation: () => T): T {
    const scope = capture(deps)
    try { return scope.commit(operation) } finally { scope.close() }
  }
  const scopedContext = (deps: RunWorkflowDeps, scope: EffectScope): ExecutionContext => ({ ...deps, source: 'workflow', isCurrent: () => { scope.guard(); return true } })
  const { ensureRunBranch, mergeRunBranch } = resources
  const { advance, enterWork, taskEngine } = workflow
  /** Сколько переходов подряд без ожидания (мерж → условие → git…) допускается, прежде чем считать граф зациклившимся. */
  const MAX_STEPS = 50



  function message(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
  }

  function mustRun(deps: RunWorkflowDeps, runId: string): Run {
    const run = deps.store.getRun(runId)
    if (!run) throw new Error(`глобальная задача не найдена: ${runId}`)
    return run
  }

  function mustTask(deps: RunWorkflowDeps, taskId: string): Task {
    const task = deps.store.getTask(taskId)
    if (!task) throw new Error(`task not found: ${taskId}`)
    return task
  }

  /** Воркфлоу идёт по глобальной задаче (`Run.workflowScope: 'run'`); иначе — прежний движок по подзадачам. */
  function isRunScope(store: TaskStore, runId: string | undefined): boolean {
    return runId !== undefined && store.getRun(runId)?.workflowScope === 'run'
  }

  /** Коммит ветки прогона сейчас — `StageChange.commit`: от него считается дифф этапа. Нет ветки или коммита — undefined. */
  /**
   * Что человек, проверка или решатель сказали при переходе: уходит в следующую «Работу», решение ветки — в историю.
   * `nodeId` — нода, на которой вынесено решение: внутри разветвления store двигает только путь на ней.
   */
  type StageExtra = Pick<RunStageOptions, 'feedback' | 'images' | 'decision' | 'answers' | 'chosen' | 'nodeId'>

  /** Опции переходов store: роли и граф типа (запасные), коммит входа в этап и то, что человек или проверка сказали. */
  async function stageOpts(deps: RunWorkflowDeps, runId: string, extra: StageExtra, scope: EffectScope): Promise<RunStageOptions> {
    const type = deps.run(runId); const branch = mustRun(deps, runId).git?.branch
    let head: string | undefined
    if (branch) {
      try { head = await scope.read(workflowGit, repo => repo.head(`refs/heads/${branch}`)) }
      catch (error) { scope.guard(); if (!(error instanceof GitProcessError)) throw error }
    }
    scope.guard()
    if (mustRun(deps, runId).git?.branch !== branch) throw new CommandError('command.stale', { globalTaskId: runId })
    return { roleIds: type.roles.map(r => r.id), ...(type.workflow ? { workflow: type.workflow } : {}), ...(head ? { commit: head } : {}), ...extra }
  }
  interface PreparedAction extends RunAction { scope: EffectScope; note?: Note }
  function prepareActions(deps: RunWorkflowDeps, runId: string, actions: readonly RunAction[], note?: Note): PreparedAction[] {
    const prepared: PreparedAction[] = []
    try {
      for (const action of actions) prepared.push({ ...action, scope: capture(deps, runId, action.nodeId, action.lane), ...(note ? { note } : {}) })
      return prepared
    } catch (error) { for (const action of prepared) action.scope.close(); throw error }
  }
  async function transition(deps: RunWorkflowDeps, runId: string, extra: StageExtra, operation: (opts: RunStageOptions) => RunStepResult): Promise<{ result: RunStepResult; effects: PreparedAction[] }> {
    const scope = capture(deps, runId, extra.nodeId)
    try {
      const opts = await stageOpts(deps, runId, extra, scope)
      const result = scope.commit(() => operation(opts))
      if (scope.signal.aborted) throw new CommandError('command.stale', { globalTaskId: runId })
      // Все позиции захватываются до возврата Promise, включая ещё не запущенные соседние пути.
      return { result, effects: prepareActions(deps, runId, result.actions) }
    } finally { scope.close() }
  }

  function graphOf(deps: RunWorkflowDeps, runId: string): Workflow {
    const type = deps.run(runId)
    return deps.store.runWorkflow(runId, { roleIds: type.roles.map((r) => r.id), ...(type.workflow ? { workflow: type.workflow } : {}) })
  }

  // ---------- вход в граф и переходы ----------

  /**
   * Координатор запущен на глобальной задаче: граф ещё не начат — входим в него из старта и выполняем эффект первой ноды
   * (обычно `stage_started` на «Работе»); граф идёт (перезапуск координатора) — повторяем эффект текущей ноды. Повтор
   * безопасен: проверка и вопрос не дублируются, approval ждущий возвращается, слияние и git идемпотентны, а «Работа»
   * при живом координаторе ничего не делает — его цель уже несёт блок «# Этап». Так же — «повторить этап» после правки
   * причины `workflow_blocked` (грязный корень с базой, роль проверки).
   */
  async function startRunWorkflow(deps: RunWorkflowDeps, runId: string): Promise<void> {
    if (mustRun(deps, runId).workflowScope !== 'run') return
    try {
      const prepared = await transition(deps, runId, {}, opts => deps.store.enterRunStage(runId, opts))
      await runEffects(deps, runId, prepared.effects)
    } catch (error) {
      if (obsoleteEffect(error)) throw error
      commit(deps, () => deps.store.blockRunStage(runId, `воркфлоу не запустился: ${message(error)}`))
    }
  }
  async function runEffects(deps: RunWorkflowDeps, runId: string, actions: readonly PreparedAction[]): Promise<void> {
    let stage: string | undefined
    try {
      for (const action of actions) { const work = await executeSteps(deps, runId, action); stage ??= work }
      const run = deps.store.getRun(runId)
      if (stage !== undefined && run) await ensureCoordinator(deps, run, stage)
    } finally { for (const action of actions) action.scope.close() }
  }
  async function advanceRun(deps: RunWorkflowDeps, runId: string, outcome: WfPort, extra: StageExtra = {}): Promise<void> {
    const prepared = await transition(deps, runId, extra, opts => deps.store.advanceRunStage(runId, outcome, opts))
    await runEffects(deps, runId, prepared.effects)
  }
  async function finishRunStage(deps: RunWorkflowDeps, runId: string, summary?: string, nodeId?: string): Promise<RunStepResult> {
    const { result, effects } = await transition(deps, runId, nodeId === undefined ? {} : { nodeId }, opts => deps.store.finishStage(runId, { ...opts, ...(summary?.trim() ? { summary } : {}) }))
    await runEffects(deps, runId, effects); return result
  }
  async function settleIdleRunStages(deps: RunWorkflowDeps): Promise<void> {
    const candidates = new Map<string, { run: Run; state: string; opts: RunStageOptions; scopes: EffectScope[] }>()
    const state = (run: Run) => JSON.stringify([run.coordinatorPtyId, run.closedAt, run.finishedAt, runPositions(run), run.lanes?.map(l => [l.id, l.forkVisit]), run.git])
    try {
      for (const run of deps.store.listRuns().filter(hasIdleStage)) {
        const scopes: EffectScope[] = []
        const before = state(run)
        try {
          for (const position of runPositions(run)) scopes.push(capture(deps, run.id, position.nodeId, position.lane))
          const opts = await stageOpts(deps, run.id, {}, scopes[0])
          for (const scope of scopes) scope.guard()
          candidates.set(run.id, { run, state: before, opts, scopes })
        } catch (error) {
          for (const scope of scopes) scope.close()
          if (!obsoleteEffect(error)) throw error
        }
      }
      const settled = commit(deps, () => deps.store.settleIdleStages(deps.isAlive, run => candidates.get(run.id)!.opts, run => {
        const candidate = candidates.get(run.id)
        if (!candidate || deps.store.getRun(run.id) !== candidate.run || state(run) !== candidate.state) return false
        try { for (const scope of candidate.scopes) scope.guard(); return true }
        catch (error) { if (!obsoleteEffect(error)) throw error; return false }
      }))
      const prepared: Array<{ runId: string; effects: PreparedAction[] }> = []
      try {
        for (const { runId, actions } of settled) prepared.push({ runId, effects: prepareActions(deps, runId, actions) })
        for (const { runId, effects } of prepared) await runEffects(deps, runId, effects)
      } finally { for (const item of prepared) for (const action of item.effects) action.scope.close() }
    } finally { for (const candidate of candidates.values()) for (const scope of candidate.scopes) scope.close() }
  }

  /** Есть ли у прогона этап «Работа» с закрытыми подзадачами — кандидат для `settleIdleRunStages` (любая позиция). */
  function hasIdleStage(run: Run): boolean {
    return run.workflowScope === 'run' && run.closedAt === undefined &&
      runPositions(run).some((p) => p.tasksDoneAt !== undefined && p.arrived === undefined)
  }

  /** Текст, который идёт в approval и в `stage_started` вместе с исходом: конфликт мержа или отказ git. */
  interface Note {
    title: string
    text: string
  }

  /**
   * Выполнить действие позиции и, если ждать никого не нужно (слияние, git), пройти дальше по исходу — с `nodeId` этой
   * ноды, чтобы внутри разветвления двигался только свой путь. Переход может дать несколько действий (после слияния граф
   * сразу вошёл в новое разветвление) — они исполняются по очереди. Ошибка эффекта — `workflow_blocked` этой ноды, позиция
   * остаётся. «Работу» не исполняет, а возвращает её ноду: координатор запускает `runEffects` один раз на все пути.
   */
  async function executeSteps(deps: RunWorkflowDeps, runId: string, first: PreparedAction): Promise<string | undefined> {
    const { store } = deps
    const queue: PreparedAction[] = [first]
    let stage: string | undefined
    try {
      for (let step = 0; step < MAX_STEPS; step += 1) {
        const item = queue.shift()
        if (!item) return stage
        const { action, note } = item
        const scope = item.scope
        const block = (reason: string) => scope.commit(() => store.blockRunStage(runId, reason, action.nodeId))
        const next = async (outcome: WfPort, extra: StageExtra, n?: Note): Promise<void> => {
          const opts = await stageOpts(deps, runId, { ...extra, nodeId: action.nodeId }, scope)
          const { actions } = scope.commit(() => store.advanceRunStage(runId, outcome, opts))
          queue.push(...prepareActions(deps, runId, actions, n))
        }
        try {
          scope.guard()
          const run = mustRun(deps, runId)
          const node = graphOf(deps, runId).nodes.find(n => n.id === action.nodeId)
          switch (action.type) {
            case 'start_stage': stage ??= action.nodeId; break
            case 'create_ask': if (node?.type === 'ask') await createAsk(deps, run, node, action.roleId); break
            case 'create_gate': if (node?.type === 'gate') await createGate(deps, run, node, action.roleId); break
            case 'create_decision': if (node?.type === 'decision') await createDecision(deps, run, node, action.roleId); break
            case 'request_human': if (node?.type === 'human') scope.commit(() => requestHuman(deps, run, node, note)); break
            case 'merge': {
              if (!run.git) { block('слияние в базу невозможно: у глобальной задачи нет ветки (глобальная задача начата до веток)'); break }
              const result = await scope.wait(() => mergeRunBranch(store, deps.repoRoot, runId, `Merge orca run: ${globalTaskTitle(run)}`, scopedContext(deps, scope)))
              if (result.kind === 'blocked') { block(`нода «${node ? wfNodeTitle(node) : action.nodeId}»: ${result.reason}`); break }
              await next(result.kind === 'ok' ? 'ok' : 'conflict', {}, result.kind === 'conflict' ? { title: 'Мерж не удался', text: result.error } : undefined); break
            }
            case 'git': {
              if (node?.type !== 'git') { block(`нода «${action.nodeId}» не найдена в воркфлоу или это не нода «Git»`); break }
              const result = await runGitNode(deps, run, node, action, scope)
              if (result.kind === 'blocked') { block(result.reason); break }
              if (result.kind === 'error' && !graphOf(deps, runId).edges.some(e => e.from === node.id && e.outcome === 'error')) {
                block(`нода «${wfNodeTitle(node)}»: ${result.text}; у ноды нет перехода «error» — добавьте его в воркфлоу (например, к человеку)`); break
              }
              if (result.kind === 'error') await next('error', { feedback: result.text }, { title: `Git-операция «${action.operation}» не удалась`, text: result.text })
              else await next('ok', {})
              break
            }
            case 'start_worker': block(`нода «${action.nodeId}»: запуск воркера по подзадачам не относится к воркфлоу глобальной задачи`); break
            case 'done': case 'blocked': case 'fork': case 'join': break
          }
        } catch (error) {
          if (obsoleteEffect(error)) throw error
          scope.guard(); block(`ошибка исполнителя воркфлоу: ${message(error)}`)
        } finally { scope.close() }
      }
      commit(deps, () => store.blockRunStage(runId, `больше ${MAX_STEPS} переходов подряд без ожидания — проверьте граф воркфлоу на цикл через мерж или git`, first.nodeId))
      return stage
    } finally { for (const item of queue) item.scope.close() }
  }

  // ---------- эффекты нод ----------

  /**
   * «Работа»: координатор получил `stage_started` (его шлёт store); нет живого координатора — запускаем его заново. Один
   * запуск на все открытые «Работы»: его цель несёт блок «# Этап» на каждую (`resumeObjective`). `nodeId` — нода, которой
   * достанется `workflow_blocked`, если запуск не удался.
   */
  async function ensureCoordinator(deps: RunWorkflowDeps, run: Run, nodeId?: string): Promise<void> {
    if (run.coordinatorPtyId && deps.isAlive(run.coordinatorPtyId)) return
    const launch = capture(deps, run.id, nodeId)
    try {
      await withStatusSource('workflow', () => deps.startCoordinator(run.id))
    } catch (e) {
      if (obsoleteEffect(e)) throw e
      launch.guard()
      launch.commit(() => deps.store.blockRunStage(run.id, `координатор не запустился: ${message(e)}. Запустить заново: orca-board global start --global ${run.id}`, nodeId))
    } finally { launch.close() }
  }

  /** Активная позиция прогона на ноде (основная или путь разветвления); путь, уже пришедший в слияние, не в счёт. */
  function positionAt(run: Run, nodeId: string | undefined): RunPosition | undefined {
    if (nodeId === undefined) return undefined
    const p = runPositionAt(run, nodeId)
    return p && p.arrived === undefined ? p : undefined
  }

  /**
   * Заход в ноду прогона и момент входа в неё — чтобы найти задачу этого захода, а не прошлого. Нода — позиция основного
   * графа или пути разветвления; нет такой позиции — счётчик заходов как есть.
   */
  function currentEntry(run: Run, nodeId: string): { visit: number; at: number } {
    const at = [...(run.stageHistory ?? [])].reverse().find((h) => h.nodeId === nodeId)?.at ?? 0
    return { visit: positionAt(run, nodeId)?.visit ?? run.stage?.visits[nodeId] ?? 1, at }
  }

  /** Путь разветвления, в котором стоит нода (`RunLane`); нода вне разветвления — undefined. */
  function laneOf(run: Run, nodeId: string): { id: string; title: string } | undefined {
    const lane = run.lanes?.find((l) => l.nodeId === nodeId)
    if (!lane) return undefined
    const fork = run.workflow?.nodes.find((n) => n.id === lane.forkId)
    const title = fork?.type === 'fork' ? forkBranches(fork).find((b) => b.id === lane.branchId)?.label : undefined
    return { id: lane.id, title: title ?? lane.branchId }
  }

  /**
   * История прогона глазами ноды: вне разветвления — вся (как раньше), в пути — общие записи (до разветвления) и записи
   * этого пути: записи соседних путей перемешаны по времени и к ноде не относятся.
   */
  function historyFor(run: Run, nodeId: string): StageChange[] {
    const history = run.stageHistory ?? []
    const lane = laneOf(run, nodeId)
    return lane ? history.filter((h) => h.lane === undefined || h.lane === lane.id) : history
  }

  /** Запуск воркера задачи этапа; не запустился — `workflow_blocked` прогона с командой повтора. */
  async function startStageWorker(deps: RunWorkflowDeps, run: Run, task: Task, what: string, nodeId: string): Promise<void> {
    const launch = capture(deps, run.id, nodeId)
    const child = resources.effects.capture(executionProject(deps.store, deps.repoRoot, deps), { taskId: task.id, taskResources: false, laneId: launch.token.laneId }, { source: 'workflow' })
    try {
      await withStatusSource('workflow', () => deps.startWorker(task.id))
    } catch (e) {
      if (obsoleteEffect(e)) throw e
      launch.guard(); child.guard()
      launch.commit(() => deps.store.blockRunStage(run.id, `${what} ${task.id} «${task.title}» не запустилась: ${message(e)}. Запустить заново: orca-board worker start --task ${task.id}`, nodeId))
    } finally { child.close(); launch.close() }
  }

  /** Задача заходa ещё ждёт запуска (не идёт и не закрыта): повтор эффекта после рестарта запускает её, а не дублирует. */
  function needsStart(deps: RunWorkflowDeps, task: Task): boolean {
    const kind = deps.store.columnKind(task.status)
    return kind !== 'in_progress' && kind !== 'done' && kind !== 'review' && kind !== 'needs_input'
  }

  /**
   * Что известно приложению о прогоне для спеки проверки и вопроса (`RunTaskContext`): цель, ветка с базой и сводки этапов.
   * Нода в пути разветвления — сводки только общих этапов и этого пути, плюс название пути (оговорка про общую ветку).
   */
  function taskContext(deps: RunWorkflowDeps, run: Run, nodeId: string, instructions: string | undefined): RunTaskContext {
    const nodes = graphOf(deps, run.id).nodes
    const lane = laneOf(run, nodeId)
    const stages = historyFor(run, nodeId).flatMap((h) => {
      const node = nodes.find((n) => n.id === h.nodeId)
      return node && h.summary?.trim() ? [{ title: wfNodeTitle(node), summary: h.summary }] : []
    })
    return {
      title: globalTaskTitle(run),
      goal: run.objective,
      ...(run.git ? { branch: run.git.branch, base: run.git.base } : {}),
      ...(stages.length > 0 ? { stages } : {}),
      ...(instructions?.trim() ? { instructions } : {}),
      ...(lane ? { lane: lane.title } : {})
    }
  }

  /**
   * Нода `ask`: одна задача роли ноды с `stageOf` — её вопросы идут человеку (`worker.ask` по типу ноды), координатор не
   * участвует. Повтор эффекта задачу этого захода не дублирует.
   */
  async function createAsk(deps: RunWorkflowDeps, run: Run, node: Extract<WfNode, { type: 'ask' }>, roleId: string): Promise<void> {
    const { store } = deps
    const role = deps.run(run.id).roles.find((r) => r.id === roleId)
    if (!role) {
      commit(deps, () => store.blockRunStage(run.id, `нода «${wfNodeTitle(node)}»: нет роли «${roleId}» в типе задачи`, node.id))
      return
    }
    const { visit } = currentEntry(run, node.id)
    let task = store.listTasks().find((t) => t.runId === run.id && !t.gateFor && t.stageOf?.nodeId === node.id && t.stageOf.visit === visit)
    if (task && !needsStart(deps, task)) return
    task ??= commit(deps, () => store.createTask({
      title: runAskTaskTitle(wfNodeTitle(node), globalTaskTitle(run)),
      spec: runAskTaskSpec(taskContext(deps, run, node.id, node.instructions)),
      roleId: role.id,
      agent: role.agent,
      runId: run.id,
      stageOf: { nodeId: node.id, visit }
    }))
    await startStageWorker(deps, run, task, 'задача-вопрос', node.id)
  }

  /**
   * Нода `gate`: задача-проверка роли ноды на ветку прогона целиком против `RunGit.base`. Решение проверяющий выносит
   * `review accept|reject --task "$ORCA_TASK_ID"` (спека `runGateTaskSpec`). Повтор эффекта проверку этого захода не дублирует.
   */
  async function createGate(deps: RunWorkflowDeps, run: Run, node: Extract<WfNode, { type: 'gate' }>, roleId: string): Promise<void> {
    const { store } = deps
    const role = deps.run(run.id).roles.find((r) => r.id === roleId)
    if (!role) {
      commit(deps, () => store.blockRunStage(run.id, `нода «${wfNodeTitle(node)}»: нет роли «${roleId}» в типе задачи`, node.id))
      return
    }
    if (!run.git) {
      commit(deps, () => store.blockRunStage(run.id, `нода «${wfNodeTitle(node)}»: у глобальной задачи нет ветки — проверять нечего (глобальная задача начата до веток)`, node.id))
      return
    }
    const { at } = currentEntry(run, node.id)
    let gate = store.listTasks().find((t) => t.gateFor?.runId === run.id && t.gateFor.nodeId === node.id && t.createdAt >= at)
    if (gate && !needsStart(deps, gate)) return
    gate ??= commit(deps, () => store.createTask({
      title: runGateTaskTitle(wfNodeTitle(node), globalTaskTitle(run)),
      spec: runGateTaskSpec(taskContext(deps, run, node.id, node.instructions)),
      roleId: role.id,
      agent: role.agent,
      runId: run.id,
      gateFor: { runId: run.id, nodeId: node.id }
    }))
    await startStageWorker(deps, run, gate, 'проверка', node.id)
  }

  type DecisionNode = Extract<WfNode, { type: 'decision' }>

  /**
   * Пройденный путь по графу для задачи-решателя (последние записи `Run.stageHistory`, последняя — сама развилка). Развилка
   * в пути разветвления — без записей соседних путей (`historyFor`).
   */
  function runPath(deps: RunWorkflowDeps, run: Run, nodeId: string): RunPathStep[] {
    const nodes = graphOf(deps, run.id).nodes
    return historyFor(run, nodeId).slice(-30).map((h) => {
      const node = nodes.find((n) => n.id === h.nodeId)
      return {
        title: h.title ?? (node ? wfNodeTitle(node) : h.nodeId),
        ...(h.visit !== undefined ? { visit: h.visit } : {}),
        ...(h.outcome !== undefined ? { outcome: h.outcome } : {}),
        ...(h.decision ? { decision: { label: h.decision.label, by: h.decision.by, ...(h.decision.reason ? { reason: h.decision.reason } : {}) } } : {})
      }
    })
  }

  /** Задача-решатель этого захода в развилку (`gateFor` на ноду, создана после входа в неё); нет — undefined. */
  function currentDecider(deps: RunWorkflowDeps, run: Run, nodeId: string): Task | undefined {
    const { at } = currentEntry(run, nodeId)
    return deps.store.listTasks().filter((t) => t.gateFor?.runId === run.id && t.gateFor.nodeId === nodeId && t.createdAt >= at).at(-1)
  }

  /** Ждущий запрос `decision` развилки (фоллбэк к человеку уже заведён). */
  function pendingDecisionRequest(deps: RunWorkflowDeps, runId: string, nodeId: string): HumanRequest | undefined {
    return deps.store.pendingRequests(runId).find((r) => r.kind === 'decision' && r.nodeId === nodeId)
  }

  /**
   * Нода `decision`: задача-решатель роли ноды (помечена `gateFor` — как проверка, поэтому не входит в подзадачи этапа и не
   * будит координатора). Агент выбирает вариант `decision choose` или передаёт решение человеку `decision escalate`
   * (спека `runDecisionTaskSpec`). Воркер не запустился — сразу фоллбэк к человеку: граф не должен вставать из-за агента.
   * Повтор эффекта (рестарт) не дублирует ни задачу захода, ни запрос; при ждущем запросе воркер заново не стартует.
   */
  async function createDecision(deps: RunWorkflowDeps, run: Run, node: DecisionNode, roleId: string): Promise<void> {
    const { store } = deps
    const role = deps.run(run.id).roles.find((r) => r.id === roleId)
    if (!role) {
      commit(deps, () => store.blockRunStage(run.id, `нода «${wfNodeTitle(node)}»: нет роли «${roleId}» в типе задачи`, node.id))
      return
    }
    let decider = currentDecider(deps, run, node.id)
    if (pendingDecisionRequest(deps, run.id, node.id) || (decider && !needsStart(deps, decider))) return
    decider ??= commit(deps, () => store.createTask({
      title: runDecisionTaskTitle(wfNodeTitle(node), globalTaskTitle(run)),
      spec: runDecisionTaskSpec({
        ...taskContext(deps, run, node.id, node.instructions),
        question: node.question,
        options: decisionOptions(node),
        path: runPath(deps, run, node.id)
      }),
      roleId: role.id,
      agent: role.agent,
      runId: run.id,
      gateFor: { runId: run.id, nodeId: node.id }
    }))
    const launch = capture(deps, run.id, node.id)
    const child = resources.effects.capture(executionProject(store, deps.repoRoot, deps), { taskId: decider.id, taskResources: false, laneId: launch.token.laneId }, { source: 'workflow' })
    try {
      await withStatusSource('workflow', () => deps.startWorker(decider.id))
    } catch (e) {
      if (obsoleteEffect(e)) throw e
      launch.guard(); child.guard()
      launch.commit(() => requestDecision(deps, run, node, 'start_failed', { problem: `агент-решатель (задача ${decider.id}) не запустился: ${message(e)}` }))
    } finally { child.close(); launch.close() }
  }

  /** Почему решает человек — строка в теле запроса. */
  const FALLBACK_TEXT: Record<StageDecisionFallback, string> = {
    unsure: 'Агент не смог выбрать уверенно и передал решение вам.',
    no_answer: 'Агент завершил работу, не выбрав вариант.',
    start_failed: 'Агент не запустился.'
  }

  /**
   * Фоллбэк развилки к человеку: запрос `decision` уровня прогона с теми же вариантами. В теле — вопрос, варианты,
   * почему решает человек, комментарий агента, сводки этапов и ветка. Ждущий запрос ноды не дублируется (store).
   */
  function requestDecision(
    deps: RunWorkflowDeps, run: Run, node: DecisionNode, fallback: StageDecisionFallback, extra: { agentNote?: string; problem?: string } = {}
  ): HumanRequest {
    const options = decisionOptions(node)
    const note = extra.agentNote?.trim()
    const stages = taskContext(deps, run, node.id, undefined).stages ?? []
    const body = [
      `**Вопрос:** ${node.question.trim()}`,
      `**Варианты:**\n${options.map((o) => `- ${o.label}${o.description?.trim() ? ` — ${o.description.trim()}` : ''}`).join('\n')}`,
      FALLBACK_TEXT[fallback] + (extra.problem ? ` ${extra.problem}` : ''),
      note ? `**Комментарий агента:** ${note}` : undefined,
      stages.length > 0 ? `**Что сделано на прошлых этапах:**\n${stages.map((x) => `- «${x.title}»: ${x.summary.trim()}`).join('\n')}` : undefined,
      run.git ? `Ветка: \`${run.git.branch}\` (база \`${run.git.base}\`)` : undefined,
      'Выберите вариант — граф глобальной задачи пойдёт по его ветке.'
    ].filter(Boolean).join('\n\n')
    return commit(deps, () => deps.store.requestRunDecision(run.id, {
      nodeId: node.id, title: node.question.trim() || wfNodeTitle(node), body, fallback,
      options: options.map((o) => ({ id: o.id, label: o.label, ...(o.description?.trim() ? { hint: o.description.trim() } : {}) })),
      ...(note ? { agentNote: note } : {})
    }))
  }

  /**
   * Подзадачи последнего закрытого захода «Работы»: их итоги и показ человек видит на следующей ноде `human`. Нода в пути
   * разветвления — последняя «Работа» этого пути. Нода после слияния, а последняя «Работа» была в путях, — последняя
   * «Работа» каждого пути этого разветвления: человек решает по итогам всех путей.
   */
  function lastWorkTasks(deps: RunWorkflowDeps, run: Run, nodeId: string): Task[] {
    const nodes = graphOf(deps, run.id).nodes
    const isWork = (h: StageChange): boolean => nodes.find((n) => n.id === h.nodeId)?.type === 'work'
    const history = historyFor(run, nodeId)
    let last = history.length - 1
    while (last >= 0 && !isWork(history[last])) last -= 1
    if (last < 0) return []
    let entries = [history[last]]
    if (history[last].lane !== undefined && !laneOf(run, nodeId)) {
      // Начало этого прохода через разветвление — первая запись пути после последней общей записи перед ним.
      let since = last
      while (since > 0 && history[since - 1].lane !== undefined) since -= 1
      const perLane = new Map<string, StageChange>()
      for (const h of history.slice(since, last + 1)) if (h.lane !== undefined && isWork(h)) perLane.set(h.lane, h)
      entries = [...perLane.values()]
    }
    return deps.store.listTasks().filter((t) => t.runId === run.id && !t.gateFor && entries.some(
      (e) => t.stageOf?.nodeId === e.nodeId && t.stageOf.visit === (e.visit ?? 1)
    ))
  }

  /**
   * Сводка этапа для approval ноды: вне разветвления — `Run.summary` (после слияния это сводки всех путей), в пути —
   * последняя сводка `stage finish` этого пути: `Run.summary` там принадлежит общим этапам или соседу.
   */
  function summaryFor(run: Run, nodeId: string): string | undefined {
    const lane = laneOf(run, nodeId)
    if (!lane) return run.summary?.text.trim() || undefined
    // Только этот проход через разветвление: пока пути идут, общих записей нет — первая общая с конца и есть вход в `fork`.
    for (const h of [...(run.stageHistory ?? [])].reverse()) {
      if (h.lane === undefined) return undefined
      if (h.lane === lane.id && h.summary?.trim()) return h.summary.trim()
    }
    return undefined
  }

  /**
   * Нода `human`: approval уровня прогона (карточка встаёт на «Проверку»). В тексте — что решить, сводка этапа, итоги и
   * показ подзадач последней «Работы», ветка. `showcaseDispatchIds` — запуски с показом, по одному на подзадачу;
   * `showcaseDispatchId` — последний из них, для старого renderer.
   */
  function requestHuman(deps: RunWorkflowDeps, run: Run, node: Extract<WfNode, { type: 'human' }>, note?: Note): void {
    const { store } = deps
    const tasks = lastWorkTasks(deps, run, node.id)
    const dispatches = tasks.flatMap((t) => {
      const d = t.dispatchId ? store.getDispatch(t.dispatchId) : undefined
      return d?.outcome === 'done' ? [{ task: t, dispatch: d }] : []
    })
    const withShowcase = dispatches.filter((x) => x.dispatch.showcase)
    const summary = summaryFor(run, node.id)
    // В пути разветвления «Принять» ведёт не к концу, а дальше по пути и в слияние; человеку важно, чей это путь.
    const lane = laneOf(run, node.id)
    const body = [
      node.instructions?.trim(),
      note ? `**${note.title}:**\n\n\`\`\`\n${note.text}\n\`\`\`` : undefined,
      summary
        ? `**Итог этапа:** ${summary}`
        : dispatches.length > 0
          ? `**Итоги подзадач:**\n${dispatches.map((x) => `- ${x.task.title}: ${x.dispatch.summary?.trim() || 'сдано'}`).join('\n')}`
          : undefined,
      ...withShowcase.map((x) => `### ${x.task.title}\n\n${showcaseMarkdown(x.dispatch.showcase!)}`),
      run.git ? `Ветка: \`${run.git.branch}\` (база \`${run.git.base}\`)` : undefined,
      lane ? messages.text('runApproval.acceptHintLane', { lane: lane.title }) : messages.text('runApproval.acceptHint')
    ].filter(Boolean).join('\n\n')
    const last = withShowcase.at(-1)
    const title = `${wfNodeTitle(node)}: ${globalTaskTitle(run)}`
    commit(deps, () => store.requestRunApproval(run.id, {
      nodeId: node.id, title: lane ? messages.text('runApproval.laneTitle', { lane: lane.title, title }) : title, body,
      ...(last ? { showcaseDispatchId: last.dispatch.id, showcaseDispatchIds: withShowcase.map((x) => x.dispatch.id) } : {})
    }))
  }

  /** Итог git-ноды прогона: `error` — git отказал (исход `error`), `blocked` — ошибка настройки (граф не двигается). */
  type GitRun = { kind: 'ok' } | { kind: 'error'; text: string } | { kind: 'blocked'; reason: string }

  /**
   * Нода `git` прогона: `commit` и `push` в worktree ветки глобальной задачи (`RunGit.worktree`, при необходимости
   * восстанавливается). `create_branch`/`checkout` в воркфлоу прогона не бывают (валидация) — здесь `blocked`. Шаблоны
   * подставляются по прогону: `{taskId}` — его id, `{title}` и `{slug}` — название. Отказ git или окружения — `error`.
   */
  async function runGitNode(deps: RunWorkflowDeps, run: Run, node: Extract<WfNode, { type: 'git' }>, a: Extract<WfAction, { type: 'git' }>, scope: EffectScope): Promise<GitRun> {
    const title = wfNodeTitle(node)
    if (a.operation !== 'commit' && a.operation !== 'push') return { kind: 'blocked', reason: `нода «${title}»: операция «${a.operation}» не поддерживается в воркфлоу глобальной задачи — доступны commit и push` }
    const vars = wfGitVars({ id: run.id, title: globalTaskTitle(run) })
    const commitMessage = a.message !== undefined ? renderGitTemplate(a.message, vars).trim() : undefined
    if (a.operation === 'commit' && !commitMessage) return { kind: 'blocked', reason: `нода «${title}»: сообщение коммита после подстановки пустое` }
    if (!run.git) return { kind: 'error', text: 'у глобальной задачи нет ветки — коммитить и пушить нечего (глобальная задача начата до веток)' }
    try {
      const g = await scope.wait(() => ensureRunBranch(deps.store, deps.repoRoot, run.id, scopedContext(deps, scope))) ?? run.git
      const before = JSON.stringify(g)
      const bound = resources.effects.capture({ ...executionProject(deps.store, deps.repoRoot, scopedContext(deps, scope)), isCurrent: () => {
        scope.guard(); return JSON.stringify(run.git) === before
      } }, { runId: run.id, nodeId: node.id, laneId: scope.token.laneId }, { source: 'workflow', signal: scope.signal })
      try {
        return await bound.transaction(workflowGit, async repo => {
          if (a.operation === 'commit') {
            if (!g.worktree) return { kind: 'error', text: 'у ветки глобальной задачи нет worktree — коммитить нечего' }
            await repo.gitCommit(g.worktree, commitMessage!)
          } else {
            if (!await repo.isBranchNameAcceptedByGit(g.branch)) return { kind: 'error', text: `имя ветки «${g.branch}» недопустимо для git` }
            await repo.gitPush(g.worktree && existsSync(g.worktree) ? g.worktree : undefined, a.remote ?? 'origin', g.branch)
          }
          return { kind: 'ok' }
        })
      } finally { bound.close() }
    } catch (error) { if (obsoleteEffect(error)) throw error; scope.guard(); return { kind: 'error', text: message(error) } }
  }

  // ---------- решения человека и проверки ----------

  /**
   * Решение approval уровня прогона (нода `human`): переход по исходу, если прогон всё ещё стоит на этой ноде. Нода —
   * `request.nodeId` (внутри разветвления каждый путь ждёт свой approval); запрос без ноды (старый) — основная позиция.
   */
  async function runApprovalResolved(deps: RunWorkflowDeps, request: HumanRequest): Promise<void> {
    const run = deps.store.getRun(request.runId)
    const action = request.resolution?.action
    if (!run || run.workflowScope !== 'run' || !run.stage || (action !== 'accept' && action !== 'reject')) return
    const nodeId = request.nodeId ?? (run.lanes?.length ? undefined : run.stage.nodeId)
    if (nodeId === undefined || !positionAt(run, nodeId)) return
    if (graphOf(deps, run.id).nodes.find((n) => n.id === nodeId)?.type !== 'human') return
    const text = request.resolution?.text?.trim() || undefined
    const images = request.resolution?.images
    try {
      await advanceRun(deps, run.id, action, {
        nodeId, ...(action === 'accept' ? (text ? { decision: text } : {}) : text ? { feedback: text, ...(images?.length ? { images } : {}) } : {})
      })
    } catch (e) {
      if (obsoleteEffect(e)) throw e
      commit(deps, () => deps.store.blockRunStage(run.id, `ошибка исполнителя воркфлоу: ${message(e)}`, nodeId))
    }
  }

  /**
   * Approval «Конфликт мержа» от сборки без пути подзадачи (`SUBTASK_MERGE_NODE`): «Принять» — человек разрешил конфликт в
   * ветке задачи, задача входит в путь и идёт от «Работы» к мержу, как после `done`; «Вернуть» — замечания уже в
   * `feedback` задачи, воркер стартует заново (запуск сам вводит задачу в путь).
   */
  async function legacyConflictResolved(deps: RunWorkflowDeps, request: HumanRequest): Promise<void> {
    const task = request.taskId !== undefined ? deps.store.getTask(request.taskId) : undefined
    const action = request.resolution?.action
    if (!task || task.stage || (action !== 'accept' && action !== 'reject')) return
    try {
      if (action === 'accept') {
        await enterWork(deps, task.id)
        await advance(deps, task.id, 'next')
      } else await deps.startWorker(task.id)
    } catch (e) {
      if (obsoleteEffect(e)) throw e
      commit(deps, () => deps.store.blockStage(task.id, `не удалось продолжить после конфликта мержа: ${message(e)}. Запустить заново: orca-board worker start --task ${task.id}`))
    }
  }

  /**
   * Решён запрос прогона (IPC `requests:resolve`, `request resolve`, «Подтвердить»/«Вернуть» на карточке): approval — прогон
   * идёт по исходу ноды `human`, decision — по ветке, выбранной человеком. `false` — approval на задаче: его ведёт движок по
   * подзадачам (`approvalResolved` в `workflow.ts`: нода `human` пути подзадачи, в том числе «Конфликт мержа»), кроме
   * устаревшего `SUBTASK_MERGE_NODE`.
   */
  async function handleRunRequest(deps: RunWorkflowDeps, request: HumanRequest): Promise<boolean> {
    if (request.kind === 'decision') {
      await runDecisionResolved(deps, request)
      return true
    }
    if (request.kind !== 'approval') return false
    if (request.taskId === undefined) {
      await runApprovalResolved(deps, request)
      return true
    }
    if (request.nodeId !== SUBTASK_MERGE_NODE || !isRunScope(deps.store, request.runId)) return false
    await legacyConflictResolved(deps, request)
    return true
  }

  /** «Подтвердить» на карточке прогона на «Проверке»: решение approval ноды `human` и переход по `accept`. */
  async function acceptRun(deps: RunWorkflowDeps, runId: string, decision?: string): Promise<GlobalTask> {
    return await decideRun(deps, runId, (id) => deps.store.acceptGlobalTask(id, decision))
  }

  /**
   * «Вернуть в работу» с «Проверки»: решение `reject` с замечаниями. Дальше граф идёт по ребру `reject` (обычно в «Работу»):
   * координатор получает `stage_started` с замечаниями, а если он не жив — запускается заново.
   */
  async function returnRun(deps: RunWorkflowDeps, runId: string, text: string, images?: string[]): Promise<GlobalTask> {
    return await decideRun(deps, runId, (id) => deps.store.returnGlobalTask(id, text, images))
  }

  async function decideRun(deps: RunWorkflowDeps, runId: string, decide: (runId: string) => GlobalTask): Promise<GlobalTask> {
    const { store } = deps
    const source = deps.source ?? statusSource()
    const decideNow = () => {
      const scope = resources.effects.capture(executionProject(store, deps.repoRoot, deps), { runId }, { source })
      try { return scope.commit(() => decideOnce(store, runId, decide)) } finally { scope.close() }
    }
    if (!isRunScope(store, runId)) return decideNow()
    // Ждут несколько approval (пути разветвления) — store откажет `RunApprovalAmbiguousError` до решения.
    const pending = store.pendingRequests(runId).find((r) => r.taskId === undefined && r.kind === 'approval')
    decideNow()
    const request = pending ? store.getRequest(pending.id) : undefined
    if (request) await handleRunRequest(deps, request)
    return store.getGlobalTask(runId)
  }

  /**
   * Решение с карточки. `RunApprovalAmbiguousError` из core — не ошибка хоста: renderer узнал бы его только по тексту.
   * Здесь он становится ошибкой хоста с кодом `global.approvalAmbiguous` (IPC передаёт код в имени ошибки, `ipcError`),
   * а сокет и CLI получают тот же русский текст.
   */
  function decideOnce(store: TaskStore, runId: string, decide: (runId: string) => GlobalTask): GlobalTask {
    try {
      return decide(runId)
    } catch (e) {
      if (!(e instanceof RunApprovalAmbiguousError)) throw e
      const titles = e.requestIds.map((id) => `«${store.getRequest(id)?.title ?? id}»`).join(', ')
      throw messages.error('global.approvalAmbiguous', { count: e.requestIds.length, titles })
    }
  }

  /** Задача — проверка ветки глобальной задачи (`gateFor.runId`): её решение — исход ноды `gate`, а не приёмка задачи. */
  function isRunGate(task: Pick<Task, 'gateFor'> | undefined): boolean {
    return task?.gateFor?.runId !== undefined
  }

  /**
   * Проверка ещё должна вынести решение: прогон стоит на её ноде (основная позиция или путь разветвления) и это последняя
   * проверка этой ноды (после `reject` → «Работа» → новая проверка старая уже не в счёт).
   */
  function gatePending(deps: RunWorkflowDeps, gate: Task): boolean {
    const { store } = deps
    const run = gate.gateFor?.runId !== undefined ? store.getRun(gate.gateFor.runId) : undefined
    if (!run || !gate.gateFor || !positionAt(run, gate.gateFor.nodeId) || run.closedAt !== undefined) return false
    const latest = store.listTasks().filter((t) => t.gateFor?.runId === run.id && t.gateFor.nodeId === gate.gateFor!.nodeId).at(-1)
    return latest?.id === gate.id
  }

  /**
   * Решение по проверке ветки прогона — `review accept|reject --task <id проверки>` (агент-проверяющий по сокету или человек
   * в приложении, IPC `review:*`): исход `accept` / `reject` ноды `gate` и эффекты следующей ноды. Единственный путь такого
   * решения — `reviewDecision` в index.ts, сокет и IPC ходят через него. Замечания `reject` уходят координатору в
   * `stage_started` (`Run.returns`). Проверка уже не актуальна (граф ушёл дальше) — ошибка. Задача-проверка закрывается здесь,
   * если её воркер уже сдал `done` (решение человека в приложении); у живого проверяющего — по его `done` (`settleGate`).
   */
  async function runGateDecision(deps: RunWorkflowDeps, gateTaskId: string, outcome: 'accept' | 'reject', text?: string, images?: string[]): Promise<void> {
    const gate = mustTask(deps, gateTaskId)
    const runId = gate.gateFor?.runId
    if (runId === undefined) throw new Error(`задача ${gateTaskId} — не проверка ветки глобальной задачи`)
    // Задача-решатель тоже помечена `gateFor`, но исходов accept/reject у развилки нет — граф пошёл бы в никуда.
    const decisionNode = deciderNode(deps, gate)
    if (decisionNode) {
      throw new Error(`задача ${gateTaskId} выбирает ветку ноды «${wfNodeTitle(decisionNode)}» — используй decision choose, а не review`)
    }
    if (!gatePending(deps, gate)) {
      const run = mustRun(deps, runId)
      const nodes = graphOf(deps, runId).nodes
      const titles = runPositions(run).flatMap((p) => {
        const node = nodes.find((n) => n.id === p.nodeId)
        return node ? [`«${wfNodeTitle(node)}»`] : []
      })
      const where = titles.length > 0 ? `на ${titles.length > 1 ? 'этапах' : 'этапе'} ${titles.join(', ')}` : 'не на этапе проверки'
      throw new Error(`проверка ${gateTaskId} уже не актуальна: глобальная задача ${runId} сейчас ${where} — решение по ней принято или проверка заменена новой`)
    }
    const comment = text?.trim() || undefined
    await advanceRun(deps, runId, outcome, {
      nodeId: gate.gateFor!.nodeId,
      ...(comment ? (outcome === 'reject' ? { feedback: comment, ...(images?.length ? { images } : {}) } : { decision: comment }) : {})
    })
    if (deps.store.columnKind(mustTask(deps, gateTaskId).status) === 'review') await closeStageTask(deps, gate)
  }

  /** Закрыть служебную задачу этапа (проверку, вопрос): worktree и ветка — удалить (сливать нечего), задача — в done. */
  async function closeStageTask(deps: RunWorkflowDeps, task: Task): Promise<void> {
    const scope = resources.effects.capture(executionProject(deps.store, deps.repoRoot, deps), { taskId: task.id, parentPosition: false }, { source: deps.source ?? 'workflow' })
    try {
      if (task.worktree && task.branch) {
        try { await scope.transaction(workflowGit, repo => repo.removeWorktree(task.worktree!, task.branch!, task.branchForeign === true)) }
        catch { scope.guard() }
      }
      scope.commit(() => deps.store.acceptTask(task.id))
    } finally { scope.close() }
  }

  /**
   * Проверка сдала `done` или её воркер вышел. Решение уже есть — проверка закрывается. Нет решения после `done` —
   * `workflow_blocked` по прогону, проверка остаётся на ревью (её можно перезапустить). Воркер вышел без `done` и без
   * решения — ничего: эскалацию («Перезапустить» / «Скрыть») уже завёл store.
   */
  async function settleGate(deps: RunWorkflowDeps, gate: Task, why: 'done' | 'exit'): Promise<void> {
    if (!gatePending(deps, gate)) {
      await closeStageTask(deps, gate)
      return
    }
    if (why === 'done') {
      commit(deps, () => deps.store.blockRunStage(
        gate.gateFor!.runId!,
        `проверка ${gate.id} сдана без решения (нет review accept/reject по задаче ${gate.id}). ` +
          `Перезапустить проверку: orca-board task reopen --task ${gate.id} --start; или решите в приложении: «Принять» / «Вернуть» у задачи ${gate.id}`,
        gate.gateFor!.nodeId
      ))
    }
  }

  // ---------- развилка «Решение ИИ» ----------

  /** Нода `decision`, ветку которой выбирает задача (`gateFor` на ноду этого типа); иначе undefined. */
  function deciderNode(deps: RunWorkflowDeps, task: Task): DecisionNode | undefined {
    const g = task.gateFor
    if (g?.runId === undefined || g.taskId !== undefined) return undefined
    const node = graphOf(deps, g.runId).nodes.find((n) => n.id === g.nodeId)
    return node?.type === 'decision' ? node : undefined
  }

  /** Задача — решатель ноды `decision` (не проверка): у неё свои команды `decision choose|escalate`. */
  function isRunDecider(deps: RunWorkflowDeps, task: Task | undefined): boolean {
    return task !== undefined && deciderNode(deps, task) !== undefined
  }

  /**
   * Решатель ещё отвечает за развилку: граф стоит на её ноде (основная позиция или путь разветвления), прогон не закрыт и
   * это задача текущего захода (после возврата в развилку старая задача уже не в счёт). Ждущий запрос человеку здесь не
   * учитывается — его проверяют вызывающие.
   */
  function deciderCurrent(deps: RunWorkflowDeps, task: Task): { run: Run; node: DecisionNode } | undefined {
    const node = deciderNode(deps, task)
    const run = node ? deps.store.getRun(task.gateFor!.runId!) : undefined
    if (!node || !run || run.closedAt !== undefined || !positionAt(run, node.id)) return undefined
    return currentDecider(deps, run, node.id)?.id === task.id ? { run, node } : undefined
  }

  /** Задача-решатель по id; не решатель — ошибка из контракта `decision choose|escalate`. */
  function mustDecider(deps: RunWorkflowDeps, taskId: string): Task {
    const task = mustTask(deps, taskId)
    if (!deciderNode(deps, task)) throw new Error(`задача ${taskId} не выбирает ветку — decision choose только для задачи ноды «Решение ИИ»`)
    return task
  }

  /** Текст решения для следующей «Работы» (`stage_started.decision`, `Run.stageInput`). */
  function decisionText(node: DecisionNode, d: StageDecision): string {
    const head = `«${node.question.trim()}» → ${d.label}${d.by === 'human' ? ' (решил человек)' : ''}.`
    return d.reason?.trim() ? `${head} ${d.reason.trim()}` : head
  }

  /** Куда ведёт ребро варианта (id ноды); нет ребра — id варианта: store всё равно отдаст `blocked`. */
  function optionTarget(deps: RunWorkflowDeps, runId: string, nodeId: string, optionId: string): string {
    return graphOf(deps, runId).edges.find((e) => e.from === nodeId && e.outcome === optionId)?.to ?? optionId
  }

  /** Переход по выбранной ветке с решением в истории развилки; ошибки store (решение не согласовано) — как есть. */
  async function applyChoice(deps: RunWorkflowDeps, runId: string, node: DecisionNode, chosen: StageDecision): Promise<void> {
    await advanceRun(deps, runId, chosen.optionId, { chosen, decision: decisionText(node, chosen), nodeId: node.id })
  }

  /** Закрыть задачу-решатель, если её воркер уже не работает (сдал `done`, не запустился); живую закроет её `done`. */
  async function closeIdleDecider(deps: RunWorkflowDeps, task: Task | undefined): Promise<void> {
    if (!task) return
    const kind = deps.store.columnKind(mustTask(deps, task.id).status)
    if (kind !== 'in_progress' && kind !== 'done') await closeStageTask(deps, mustTask(deps, task.id))
  }

  /**
   * `decision choose` агента-решателя (сокет → `ProjectDeps.decide` в index.ts): вариант по id или метке, граф идёт по его
   * ветке, решение `by: 'agent'` с обоснованием — в историю развилки. Решение уже принято, граф ушёл, есть более новый
   * решатель или решение передано человеку — ошибка, граф не трогается. Неизвестный вариант — ошибка со списком id.
   */
  async function runDecision(
    deps: RunWorkflowDeps, taskId: string, option: string, reason: string
  ): Promise<{ runId: string; nodeId: string; optionId: string; label: string; to: string }> {
    const task = mustDecider(deps, taskId)
    const text = reason.trim()
    if (!text) throw new Error('--task, --option и --reason обязательны')
    if (text.length > DECISION_REASON_LIMIT) throw new Error(`обоснование длиннее ${DECISION_REASON_LIMIT} символов — сократи --reason`)
    const current = deciderCurrent(deps, task)
    if (!current || pendingDecisionRequest(deps, current.run.id, current.node.id)) {
      throw new Error(`решение по задаче ${taskId} уже принято или передано человеку`)
    }
    const { run, node } = current
    const options = decisionOptions(node)
    const picked: WfDecisionOption | undefined = findOption(options, option)
    if (!picked) throw new Error(`нет варианта «${option.trim()}» — допустимы: ${options.map((o) => `${o.id} (${o.label})`).join(', ')}`)
    const to = optionTarget(deps, run.id, node.id, picked.id)
    await applyChoice(deps, run.id, node, { optionId: picked.id, label: picked.label, reason: text, by: 'agent' })
    if (deps.store.columnKind(mustTask(deps, taskId).status) === 'review') await closeStageTask(deps, mustTask(deps, taskId))
    return { runId: run.id, nodeId: node.id, optionId: picked.id, label: picked.label, to }
  }

  /**
   * `decision escalate` агента-решателя: запрос `decision` человеку с теми же вариантами, `fallback: 'unsure'`, комментарий
   * агента — `agentNote`. Повтор при уже ждущем запросе возвращает его; решение уже принято — ошибка.
   */
  function escalateDecision(deps: RunWorkflowDeps, taskId: string, reason: string): { requestId: string } {
    const task = mustDecider(deps, taskId)
    const text = reason.trim()
    if (!text) throw new Error('--task и --reason обязательны')
    if (text.length > DECISION_REASON_LIMIT) throw new Error(`обоснование длиннее ${DECISION_REASON_LIMIT} символов — сократи --reason`)
    const current = deciderCurrent(deps, task)
    if (!current) throw new Error(`решение по задаче ${taskId} уже принято или передано человеку`)
    const request = withStatusSource('workflow', () => requestDecision(deps, current.run, current.node, 'unsure', { agentNote: text }))
    return { requestId: request.id }
  }

  /**
   * Решатель сдал `done` или его воркер вышел. Граф уже ушёл с развилки (агент выбрал, решил человек) — задача закрывается.
   * `done` без выбора — фоллбэк к человеку (`no_answer`, сводка агента — `agentNote`) и задача закрывается: ветку выберут
   * в Инбоксе. Воркер вышел без `done` — ничего: штатную эскалацию с «Перезапустить» уже завёл store.
   */
  async function settleDecision(deps: RunWorkflowDeps, task: Task, why: 'done' | 'exit', dispatchId?: string): Promise<void> {
    if (dispatchId !== undefined && task.dispatchId !== dispatchId) return
    const current = deciderCurrent(deps, task)
    if (!current) {
      await closeStageTask(deps, task)
      return
    }
    if (why === 'exit') return
    if (!pendingDecisionRequest(deps, current.run.id, current.node.id)) {
      const summary = task.dispatchId ? deps.store.getDispatch(task.dispatchId)?.summary : undefined
      requestDecision(deps, current.run, current.node, 'no_answer', summary?.trim() ? { agentNote: summary } : {})
    }
    await closeStageTask(deps, task)
  }

  /**
   * Человек выбрал ветку по запросу `decision` (Инбокс, `request resolve --option`): переход по ней с решением `by: 'human'`,
   * `fallback` и комментарием агента из запроса; задача-решатель закрывается, если её воркер уже не работает. Граф ушёл с
   * развилки — ничего (store уже отменил бы запрос). Варианта больше нет в графе (граф поменяли) — `workflow_blocked`.
   */
  async function runDecisionResolved(deps: RunWorkflowDeps, request: HumanRequest): Promise<void> {
    const run = deps.store.getRun(request.runId)
    const optionId = request.resolution?.optionId
    if (!run || run.workflowScope !== 'run' || !run.stage || request.taskId !== undefined || optionId === undefined) return
    if (request.nodeId === undefined || !positionAt(run, request.nodeId) || run.closedAt !== undefined) return
    const node = graphOf(deps, run.id).nodes.find((n) => n.id === request.nodeId)
    if (node?.type !== 'decision') return
    const option = decisionOptions(node).find((o) => o.id === optionId)
    if (!option) {
      commit(deps, () => deps.store.blockRunStage(run.id, `нода «${wfNodeTitle(node)}»: варианта «${optionId}» больше нет в воркфлоу — выберите ветку заново или верните граф руками`, node.id))
      return
    }
    const decider = currentDecider(deps, run, node.id)
    const text = request.resolution?.text?.trim()
    try {
      await applyChoice(deps, run.id, node, {
        optionId: option.id, label: option.label, by: 'human',
        ...(text ? { reason: text.slice(0, DECISION_REASON_LIMIT) } : {}),
        ...(request.fallback ? { fallback: request.fallback } : {}),
        ...(request.agentNote ? { agentNote: request.agentNote } : {})
      })
      await closeIdleDecider(deps, decider)
    } catch (e) {
      if (obsoleteEffect(e)) throw e
      commit(deps, () => deps.store.blockRunStage(run.id, `ошибка исполнителя воркфлоу: ${message(e)}`, node.id))
    }
  }

  /** Ответы человека на вопросы задачи `ask`: текст для `stage_started.answers` и `Run.stageInput` следующей «Работы». */
  function answersText(deps: RunWorkflowDeps, taskId: string): string {
    return deps.store.snapshot().questions
      .filter((q) => q.taskId === taskId && q.answeredAt)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((q) => `- ${q.question}\n  Ответ: ${q.answer ?? ''}`)
      .join('\n')
  }

  /** Задача `ask` сдала `done`: закрыть её и перейти по `next` с ответами человека — если прогон всё ещё на этом заходе ноды. */
  async function askDone(deps: RunWorkflowDeps, task: Task, dispatchId: string | undefined): Promise<void> {
    // Сданный прошлый запуск (задачу уже перезапустили) переход не делает.
    if (dispatchId !== undefined && task.dispatchId !== dispatchId) return
    const run = mustRun(deps, task.runId!)
    const answers = answersText(deps, task.id)
    await closeStageTask(deps, task)
    const nodeId = task.stageOf?.nodeId
    const position = positionAt(run, nodeId)
    if (!position || run.closedAt !== undefined || position.visit !== task.stageOf?.visit) return
    await advanceRun(deps, run.id, 'next', { nodeId: position.nodeId, ...(answers ? { answers } : {}) })
  }

  /**
   * Человек ответил на вопрос с этапа `ask`, а агента уже нет (упал, перезапуск приложения): воркер стартует сам, ответ
   * попадает в его промпт. Живой воркер получает ответ через свой `ask`. Ошибка запуска — `workflow_blocked`.
   */
  async function restartAsk(deps: RunWorkflowDeps, task: Task, workerLive: boolean): Promise<void> {
    if (workerLive || task.gateFor || !task.runId) return
    const node = deps.store.taskStageNode(task.id, { roleIds: deps.run(task.runId).roles.map((r) => r.id) })
    if (node?.type !== 'ask' || deps.store.columnKind(task.status) !== 'ready') return
    const launch = resources.effects.capture(executionProject(deps.store, deps.repoRoot, deps), { taskId: task.id, taskResources: false }, { source: 'workflow' })
    try {
      await withStatusSource('workflow', () => deps.startWorker(task.id))
    } catch (e) {
      if (obsoleteEffect(e)) throw e
      launch.guard()
      launch.commit(() => deps.store.blockRunStage(task.runId!, `воркер не запустился после ответа: ${message(e)}. Запустить заново: orca-board worker start --task ${task.id}`, task.stageOf?.nodeId))
    } finally { launch.close() }
  }

  /**
   * Подзадача, не привязанная к этапу «Работа» (заготовлена до входа в граф), сдала `done`: пути у неё нет, а сливать в
   * ветку прогона по графу нечем — задача ждёт ручной приёмки («Принять»: прежняя приёмка с мержем).
   */
  function unboundSubtaskDone(deps: RunWorkflowDeps, task: Task): void {
    commit(deps, () => deps.store.blockStage(
      task.id,
      `подзадача не привязана к этапу «Работа» (создана до входа глобальной задачи в граф) — пути подзадачи у неё нет. ` +
        `Принять вручную: «Принять» в приложении или orca-board review accept --task ${task.id}`
    ))
  }

  /**
   * События store → шаги воркфлоу прогона (подписка `projects.onEvents` в index.ts): `worker_done` задачи `ask` — переход
   * дальше, проверки ветки прогона — закрытие; решателя развилки — закрытие или фоллбэк к человеку без выбора (`settleDecision`);
   * `escalation` проверки или решателя — закрытие, если решение уже есть;
   * `question_answered` на этапе `ask` без живого воркера — автоперезапуск. Задачи-ответы идут мимо воркфлоу; подзадачи
   * этапа «Работа» (их путь) и проверки их веток, как и прогоны старого формата, — на движке по подзадачам
   * (`handleWorkflowEvents`): `taskEngine` отдаёт каждую задачу ровно одному. Ошибки не выбрасываются из подписки — они
   * становятся `workflow_blocked`.
   */
  async function handleRunWorkflowEvents(deps: RunWorkflowDeps, events: readonly OrcaEvent[]): Promise<void> {
    {
      for (const e of events) {
        if (!e.taskId || (e.type !== 'worker_done' && e.type !== 'escalation' && e.type !== 'question_answered')) continue
        const task = deps.store.getTask(e.taskId)
        if (!task || task.answerFor || taskEngine(deps, task) !== 'run') continue
        // Запоздалые done/exit прошлого запуска не меняют новый dispatch, в том числе gate.
        if (e.type !== 'question_answered' && e.dispatchId !== undefined && task.dispatchId !== e.dispatchId) continue
        try {
          if (e.type === 'question_answered') {
            await restartAsk(deps, task, e.payload.workerLive === true)
          } else if (e.type === 'worker_done') {
            if (isRunDecider(deps, task)) await settleDecision(deps, task, 'done', e.dispatchId)
            else if (isRunGate(task)) await settleGate(deps, task, 'done')
            else if (!task.gateFor) {
              const node = task.stageOf ? deps.store.taskStageNode(task.id, { roleIds: deps.run(task.runId).roles.map((r) => r.id) }) : undefined
              if (node?.type === 'ask') await askDone(deps, task, e.dispatchId)
              else if (e.dispatchId === undefined || task.dispatchId === e.dispatchId) unboundSubtaskDone(deps, task)
            }
          } else if (isRunDecider(deps, task) && e.payload.stuck !== true) {
            await settleDecision(deps, task, 'exit')
          } else if (isRunGate(task) && e.payload.stuck !== true) {
            await settleGate(deps, task, 'exit')
          }
        } catch (err) {
          if (obsoleteEffect(err)) continue
          commit(deps, () => deps.store.blockRunStage(task.runId!, `ошибка исполнителя воркфлоу: ${message(err)}`, task.stageOf?.nodeId ?? task.gateFor?.nodeId))
        }
      }
    }
  }

  return { isRunScope, startRunWorkflow, advanceRun, finishRunStage, settleIdleRunStages, hasIdleStage, handleRunRequest, acceptRun, returnRun, isRunGate, runGateDecision, isRunDecider, runDecision, escalateDecision, handleRunWorkflowEvents }
}

export type RunWorkflowServices = ReturnType<typeof createRunWorkflowServices>
