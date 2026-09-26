import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  DECISION_REASON_LIMIT, decisionOptions, globalTaskTitle, renderGitTemplate, runAskTaskSpec, runAskTaskTitle, runDecisionTaskSpec,
  runDecisionTaskTitle, runGateTaskSpec, runGateTaskTitle, wfGitVars, wfNodeTitle, withStatusSource,
  type GlobalTask, type HumanRequest, type OrcaEvent, type Role, type Run, type RunPathStep, type RunStageOptions, type RunTaskContext,
  type StageDecision, type StageDecisionFallback, type Task, type TaskStore, type WfAction, type WfDecisionOption, type WfNode, type WfPort,
  type Workflow
} from '@orca-board/core'
import { gitCommit, gitPush, isBranchNameAcceptedByGit, removeWorktree } from './git'
import type { MergeTargetOf } from './review'
import { findOption } from './request-params'
import { ensureRunBranch, mergeRunBranch } from './run-branch'
import { advance, enterWork, taskEngine } from './workflow'
import { showcaseMarkdown } from '../shared/showcase'

// Исполнитель воркфлоу глобальной задачи (docs/workflow.md → «Воркфлоу глобальной задачи»): позицию на графе хранит
// `Run.stage`, переходы делает store (`advanceRunStage`, `finishStage`), здесь выполняются эффекты нод — событие и
// перезапуск координатора на «Работе», задачи проверки, вопроса и решения ветки, запросы человеку, git, слияние ветки
// прогона в базу.
// Подзадачи по графу прогона не ходят: каждая идёт по пути своей ноды «Работа» (`work.subflow`, по умолчанию
// `defaultSubflow()`: воркер → мерж в ветку прогона → конец), его исполняет движок по подзадачам (`workflow.ts`, `Task.stage`).
// Событие и задачу делят по `taskEngine`: здесь — только то, что он отдаёт прогону (проверки и вопросы этапов, подзадачи вне
// этапа). Прогоны без `Run.workflowScope: 'run'` идут прежним движком (`workflow.ts`); этот модуль их не трогает.

export interface RunWorkflowDeps {
  store: TaskStore
  repoRoot: string
  /** Тип прогона сейчас (`resolveRunType`): роли — для проверок и вопросов, граф типа — запасной для прогона без снимка. */
  run(runId: string | undefined): { roles: Role[]; workflow?: Workflow }
  /** Запуск воркера задачи с проверками роли и агента (`runWorker` в index.ts). */
  startWorker(taskId: string, opts?: { roleId?: string }): { ptyId: string; dispatchId: string }
  /** Жив ли терминал (`isAlive` из `pty.ts`): координатор или воркер. */
  isAlive(ptyId: string): boolean
  /**
   * (Пере)запуск координатора глобальной задачи: тот же запуск, что «Запустить координатора» (цель — с блоком «# Этап»,
   * `resumeObjective`). Не вызывает `startRunWorkflow`. Бросает, если координатор не запустился.
   */
  startCoordinator(runId: string): void
  /** Куда сливать ветку подзадачи (`mergeTarget` в `run-branch.ts`). Нет — текущая ветка корня (тесты). */
  mergeTarget?: MergeTargetOf
}

/** Сколько переходов подряд без ожидания (мерж → условие → git…) допускается, прежде чем считать граф зациклившимся. */
const MAX_STEPS = 50

/**
 * Id ноды в approval «Конфликт мержа» подзадачи, созданном сборкой до пути подзадачи (тогда автомерж был зашит в движок
 * прогона). Новые конфликты — нода `conflict` пути (`defaultSubflow()`), но запрос, ждавший человека при обновлении,
 * дорешивает `legacyConflictResolved`: задача входит в путь и идёт к ноде `merge`.
 */
export const SUBTASK_MERGE_NODE = 'subtask-merge'

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
export function isRunScope(store: TaskStore, runId: string | undefined): boolean {
  return runId !== undefined && store.getRun(runId)?.workflowScope === 'run'
}

/** Коммит ветки прогона сейчас — `StageChange.commit`: от него считается дифф этапа. Нет ветки или коммита — undefined. */
function branchHead(deps: RunWorkflowDeps, run: Run): string | undefined {
  if (!run.git) return undefined
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${run.git.branch}`], {
      cwd: deps.repoRoot, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8'
    }).trim() || undefined
  } catch {
    return undefined
  }
}

/** Что человек, проверка или решатель сказали при переходе: уходит в следующую «Работу», решение ветки — в историю. */
type StageExtra = Pick<RunStageOptions, 'feedback' | 'images' | 'decision' | 'answers' | 'chosen'>

/** Опции переходов store: роли и граф типа (запасные), коммит входа в этап и то, что человек или проверка сказали. */
function stageOpts(deps: RunWorkflowDeps, runId: string, extra: StageExtra = {}): RunStageOptions {
  const type = deps.run(runId)
  const commit = branchHead(deps, mustRun(deps, runId))
  return { roleIds: type.roles.map((r) => r.id), ...(type.workflow ? { workflow: type.workflow } : {}), ...(commit ? { commit } : {}), ...extra }
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
export function startRunWorkflow(deps: RunWorkflowDeps, runId: string): void {
  const run = mustRun(deps, runId)
  if (run.workflowScope !== 'run') return
  withStatusSource('workflow', () => {
    try {
      const { action } = deps.store.enterRunStage(runId, stageOpts(deps, runId))
      executeSteps(deps, runId, action)
    } catch (e) {
      deps.store.blockRunStage(runId, `воркфлоу не запустился: ${message(e)}`)
    }
  })
}

/**
 * Эффекты новой ноды после перехода, сделанного store. Ошибка эффекта не откатывает переход (позиция уже новая), а
 * становится `workflow_blocked`: вызывающий (сокет, IPC) не должен видеть провал перехода, которого не было.
 */
function runEffects(deps: RunWorkflowDeps, runId: string, action: WfAction): void {
  try {
    executeSteps(deps, runId, action)
  } catch (e) {
    deps.store.blockRunStage(runId, `ошибка исполнителя воркфлоу: ${message(e)}`)
  }
}

/** Исход текущей ноды прогона → переход по графу и эффекты новых нод. */
export function advanceRun(deps: RunWorkflowDeps, runId: string, outcome: WfPort, extra: StageExtra = {}): void {
  withStatusSource('workflow', () => {
    const { action } = deps.store.advanceRunStage(runId, outcome, stageOpts(deps, runId, extra))
    runEffects(deps, runId, action)
  })
}

/**
 * `stage finish` координатора (сокет `stage.finish`): этап «Работа» закрыт — переход по `next` и эффекты следующей ноды
 * (проверка, человек, git, мерж, конец). Единственный путь закрытия этапа: сам store эффектов не делает, поэтому сокет
 * не вызывает `store.finishStage` напрямую. Ошибки store (не все подзадачи закрыты, не «Работа») — с подсказкой, как есть.
 * Возвращает то, что сделал store: обновлённый прогон и действие новой ноды.
 */
export function finishRunStage(deps: RunWorkflowDeps, runId: string, summary?: string): { run: Run; action: WfAction } {
  return withStatusSource('workflow', () => {
    const result = deps.store.finishStage(runId, { ...stageOpts(deps, runId), ...(summary?.trim() ? { summary } : {}) })
    runEffects(deps, runId, result.action)
    return result
  })
}

/**
 * Страховка на случай, когда координатор умер, не успев вызвать `stage finish` (раз в несколько секунд, как
 * `settleIdleRuns`): этапы с закрытыми подзадачами и мёртвым координатором закрываются без сводки, дальше — эффекты.
 */
export function settleIdleRunStages(deps: RunWorkflowDeps): void {
  const settled = deps.store.settleIdleStages(deps.isAlive, (run) => stageOpts(deps, run.id))
  for (const { runId, action } of settled) {
    withStatusSource('workflow', () => {
      try {
        executeSteps(deps, runId, action)
      } catch (e) {
        deps.store.blockRunStage(runId, `ошибка исполнителя воркфлоу: ${message(e)}`)
      }
    })
  }
}

/** Текст, который идёт в approval и в `stage_started` вместе с исходом: конфликт мержа или отказ git. */
interface Note {
  title: string
  text: string
}

/**
 * Выполнить действие ноды и, если ждать никого не нужно (слияние, git), пройти дальше по исходу. Любая ошибка эффекта —
 * `workflow_blocked` по `runId`, позиция остаётся.
 */
function executeSteps(deps: RunWorkflowDeps, runId: string, first: WfAction): void {
  const { store } = deps
  let action = first
  let note: Note | undefined
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const run = store.getRun(runId)
    if (!run) return
    const node = graphOf(deps, runId).nodes.find((n) => n.id === action.nodeId)
    switch (action.type) {
      case 'start_stage':
        ensureCoordinator(deps, run)
        return
      case 'create_ask':
        if (node?.type === 'ask') createAsk(deps, run, node, action.roleId)
        return
      case 'create_gate':
        if (node?.type === 'gate') createGate(deps, run, node, action.roleId)
        return
      case 'create_decision':
        if (node?.type === 'decision') createDecision(deps, run, node, action.roleId)
        return
      case 'request_human':
        if (node?.type === 'human') requestHuman(deps, run, node, note)
        return
      case 'merge': {
        const g = run.git
        if (!g) {
          store.blockRunStage(runId, 'слияние в базу невозможно: у глобальной задачи нет ветки (глобальная задача начата до веток)')
          return
        }
        let result: ReturnType<typeof mergeRunBranch>
        try {
          result = mergeRunBranch(deps.repoRoot, g, `Merge orca run: ${globalTaskTitle(run)}`)
        } catch (e) {
          store.blockRunStage(runId, `мерж не выполнен: ${message(e)}`)
          return
        }
        if (result.kind === 'blocked') {
          store.blockRunStage(runId, `нода «${node ? wfNodeTitle(node) : action.nodeId}»: ${result.reason}`)
          return
        }
        note = result.kind === 'conflict' ? { title: 'Мерж не удался', text: result.error } : undefined
        action = store.advanceRunStage(runId, result.kind === 'ok' ? 'ok' : 'conflict', stageOpts(deps, runId)).action
        continue
      }
      case 'git': {
        if (node?.type !== 'git') {
          store.blockRunStage(runId, `нода «${action.nodeId}» не найдена в воркфлоу или это не нода «Git»`)
          return
        }
        const result = runGitNode(deps, run, node, action)
        if (result.kind === 'blocked') {
          store.blockRunStage(runId, result.reason)
          return
        }
        if (result.kind === 'error') {
          note = { title: `Git-операция «${action.operation}» не удалась`, text: result.text }
          if (!graphOf(deps, runId).edges.some((e) => e.from === node.id && e.outcome === 'error')) {
            store.blockRunStage(runId, `нода «${wfNodeTitle(node)}»: ${result.text}; у ноды нет перехода «error» — добавьте его в воркфлоу (например, к человеку)`)
            return
          }
        } else note = undefined
        // Как замечания при reject: если `error` ведёт в «Работу», координатор увидит причину в `stage_started`.
        action = store.advanceRunStage(runId, result.kind, stageOpts(deps, runId, result.kind === 'error' ? { feedback: result.text } : {})).action
        continue
      }
      case 'done':
        // Граф дошёл до `end`: прогон закрыт, карточка в «Сделано», координатору ушёл `run_done` (store). Worktree
        // ветки убирает `RunBranchSync`, когда в прогоне никто не работает.
        return
      case 'blocked':
        // Событие workflow_blocked уже отправил store.
        return
      case 'start_worker':
        store.blockRunStage(runId, `нода «${action.nodeId}»: запуск воркера по подзадачам не относится к воркфлоу глобальной задачи`)
        return
    }
  }
  store.blockRunStage(runId, `больше ${MAX_STEPS} переходов подряд без ожидания — проверьте граф воркфлоу на цикл через мерж или git`)
}

// ---------- эффекты нод ----------

/** «Работа»: координатор получил `stage_started` (его шлёт store); нет живого координатора — запускаем его заново. */
function ensureCoordinator(deps: RunWorkflowDeps, run: Run): void {
  if (run.coordinatorPtyId && deps.isAlive(run.coordinatorPtyId)) return
  try {
    deps.startCoordinator(run.id)
  } catch (e) {
    deps.store.blockRunStage(run.id, `координатор не запустился: ${message(e)}. Запустить заново: orca-board global start --global ${run.id}`)
  }
}

/** Заход в текущую ноду прогона и момент входа в неё — чтобы найти задачу этого захода, а не прошлого. */
function currentEntry(run: Run): { visit: number; at: number } {
  const nodeId = run.stage?.nodeId
  const at = [...(run.stageHistory ?? [])].reverse().find((h) => h.nodeId === nodeId)?.at ?? 0
  return { visit: nodeId ? run.stage?.visits[nodeId] ?? 1 : 1, at }
}

/** Запуск воркера задачи этапа; не запустился — `workflow_blocked` прогона с командой повтора. */
function startStageWorker(deps: RunWorkflowDeps, run: Run, task: Task, what: string): void {
  try {
    deps.startWorker(task.id)
  } catch (e) {
    deps.store.blockRunStage(run.id, `${what} ${task.id} «${task.title}» не запустилась: ${message(e)}. Запустить заново: orca-board worker start --task ${task.id}`)
  }
}

/** Задача заходa ещё ждёт запуска (не идёт и не закрыта): повтор эффекта после рестарта запускает её, а не дублирует. */
function needsStart(deps: RunWorkflowDeps, task: Task): boolean {
  const kind = deps.store.columnKind(task.status)
  return kind !== 'in_progress' && kind !== 'done' && kind !== 'review' && kind !== 'needs_input'
}

/** Что известно приложению о прогоне для спеки проверки и вопроса (`RunTaskContext`): цель, ветка с базой и сводки этапов. */
function taskContext(deps: RunWorkflowDeps, run: Run, instructions: string | undefined): RunTaskContext {
  const nodes = graphOf(deps, run.id).nodes
  const stages = (run.stageHistory ?? []).flatMap((h) => {
    const node = nodes.find((n) => n.id === h.nodeId)
    return node && h.summary?.trim() ? [{ title: wfNodeTitle(node), summary: h.summary }] : []
  })
  return {
    title: globalTaskTitle(run),
    goal: run.objective,
    ...(run.git ? { branch: run.git.branch, base: run.git.base } : {}),
    ...(stages.length > 0 ? { stages } : {}),
    ...(instructions?.trim() ? { instructions } : {})
  }
}

/**
 * Нода `ask`: одна задача роли ноды с `stageOf` — её вопросы идут человеку (`worker.ask` по типу ноды), координатор не
 * участвует. Повтор эффекта задачу этого захода не дублирует.
 */
function createAsk(deps: RunWorkflowDeps, run: Run, node: Extract<WfNode, { type: 'ask' }>, roleId: string): void {
  const { store } = deps
  const role = deps.run(run.id).roles.find((r) => r.id === roleId)
  if (!role) {
    store.blockRunStage(run.id, `нода «${wfNodeTitle(node)}»: нет роли «${roleId}» в типе задачи`)
    return
  }
  const { visit } = currentEntry(run)
  let task = store.listTasks().find((t) => t.runId === run.id && !t.gateFor && t.stageOf?.nodeId === node.id && t.stageOf.visit === visit)
  if (task && !needsStart(deps, task)) return
  task ??= store.createTask({
    title: runAskTaskTitle(wfNodeTitle(node), globalTaskTitle(run)),
    spec: runAskTaskSpec(taskContext(deps, run, node.instructions)),
    roleId: role.id,
    agent: role.agent,
    runId: run.id,
    stageOf: { nodeId: node.id, visit }
  })
  startStageWorker(deps, run, task, 'задача-вопрос')
}

/**
 * Нода `gate`: задача-проверка роли ноды на ветку прогона целиком против `RunGit.base`. Решение проверяющий выносит
 * `review accept|reject --task "$ORCA_TASK_ID"` (спека `runGateTaskSpec`). Повтор эффекта проверку этого захода не дублирует.
 */
function createGate(deps: RunWorkflowDeps, run: Run, node: Extract<WfNode, { type: 'gate' }>, roleId: string): void {
  const { store } = deps
  const role = deps.run(run.id).roles.find((r) => r.id === roleId)
  if (!role) {
    store.blockRunStage(run.id, `нода «${wfNodeTitle(node)}»: нет роли «${roleId}» в типе задачи`)
    return
  }
  if (!run.git) {
    store.blockRunStage(run.id, `нода «${wfNodeTitle(node)}»: у глобальной задачи нет ветки — проверять нечего (глобальная задача начата до веток)`)
    return
  }
  const { at } = currentEntry(run)
  let gate = store.listTasks().find((t) => t.gateFor?.runId === run.id && t.gateFor.nodeId === node.id && t.createdAt >= at)
  if (gate && !needsStart(deps, gate)) return
  gate ??= store.createTask({
    title: runGateTaskTitle(wfNodeTitle(node), globalTaskTitle(run)),
    spec: runGateTaskSpec(taskContext(deps, run, node.instructions)),
    roleId: role.id,
    agent: role.agent,
    runId: run.id,
    gateFor: { runId: run.id, nodeId: node.id }
  })
  startStageWorker(deps, run, gate, 'проверка')
}

type DecisionNode = Extract<WfNode, { type: 'decision' }>

/** Пройденный путь по графу для задачи-решателя (последние записи `Run.stageHistory`, последняя — сама развилка). */
function runPath(deps: RunWorkflowDeps, run: Run): RunPathStep[] {
  const nodes = graphOf(deps, run.id).nodes
  return (run.stageHistory ?? []).slice(-30).map((h) => {
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
  const { at } = currentEntry(run)
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
function createDecision(deps: RunWorkflowDeps, run: Run, node: DecisionNode, roleId: string): void {
  const { store } = deps
  const role = deps.run(run.id).roles.find((r) => r.id === roleId)
  if (!role) {
    store.blockRunStage(run.id, `нода «${wfNodeTitle(node)}»: нет роли «${roleId}» в типе задачи`)
    return
  }
  let decider = currentDecider(deps, run, node.id)
  if (pendingDecisionRequest(deps, run.id, node.id) || (decider && !needsStart(deps, decider))) return
  decider ??= store.createTask({
    title: runDecisionTaskTitle(wfNodeTitle(node), globalTaskTitle(run)),
    spec: runDecisionTaskSpec({
      ...taskContext(deps, run, node.instructions),
      question: node.question,
      options: decisionOptions(node),
      path: runPath(deps, run)
    }),
    roleId: role.id,
    agent: role.agent,
    runId: run.id,
    gateFor: { runId: run.id, nodeId: node.id }
  })
  try {
    deps.startWorker(decider.id)
  } catch (e) {
    requestDecision(deps, run, node, 'start_failed', { problem: `агент-решатель (задача ${decider.id}) не запустился: ${message(e)}` })
  }
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
  const stages = taskContext(deps, run, undefined).stages ?? []
  const body = [
    `**Вопрос:** ${node.question.trim()}`,
    `**Варианты:**\n${options.map((o) => `- ${o.label}${o.description?.trim() ? ` — ${o.description.trim()}` : ''}`).join('\n')}`,
    FALLBACK_TEXT[fallback] + (extra.problem ? ` ${extra.problem}` : ''),
    note ? `**Комментарий агента:** ${note}` : undefined,
    stages.length > 0 ? `**Что сделано на прошлых этапах:**\n${stages.map((x) => `- «${x.title}»: ${x.summary.trim()}`).join('\n')}` : undefined,
    run.git ? `Ветка: \`${run.git.branch}\` (база \`${run.git.base}\`)` : undefined,
    'Выберите вариант — граф глобальной задачи пойдёт по его ветке.'
  ].filter(Boolean).join('\n\n')
  return deps.store.requestRunDecision(run.id, {
    nodeId: node.id, title: node.question.trim() || wfNodeTitle(node), body, fallback,
    options: options.map((o) => ({ id: o.id, label: o.label, ...(o.description?.trim() ? { hint: o.description.trim() } : {}) })),
    ...(note ? { agentNote: note } : {})
  })
}

/** Подзадачи последнего закрытого захода «Работы»: их итоги и показ человек видит на следующей ноде `human`. */
function lastWorkTasks(deps: RunWorkflowDeps, run: Run): Task[] {
  const nodes = graphOf(deps, run.id).nodes
  const entry = [...(run.stageHistory ?? [])].reverse().find((h) => nodes.find((n) => n.id === h.nodeId)?.type === 'work')
  if (!entry) return []
  return deps.store.listTasks().filter(
    (t) => t.runId === run.id && !t.gateFor && t.stageOf?.nodeId === entry.nodeId && t.stageOf.visit === (entry.visit ?? 1)
  )
}

/**
 * Нода `human`: approval уровня прогона (карточка встаёт на «Проверку»). В тексте — что решить, сводка этапа, итоги и
 * показ подзадач последней «Работы», ветка. `showcaseDispatchId` — последний запуск с файлами показа: renderer читает
 * их из worktree задачи, а после автомержа worktree убран — файлы остаются в ветке прогона.
 */
function requestHuman(deps: RunWorkflowDeps, run: Run, node: Extract<WfNode, { type: 'human' }>, note?: Note): void {
  const { store } = deps
  const tasks = lastWorkTasks(deps, run)
  const dispatches = tasks.flatMap((t) => {
    const d = t.dispatchId ? store.getDispatch(t.dispatchId) : undefined
    return d?.outcome === 'done' ? [{ task: t, dispatch: d }] : []
  })
  const withShowcase = dispatches.filter((x) => x.dispatch.showcase)
  const summary = run.summary?.text.trim()
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
    '«Принять» — дальше по воркфлоу (обычно конец или мерж), «Вернуть» — с замечаниями: координатор получит их и создаст подзадачи доработки.'
  ].filter(Boolean).join('\n\n')
  const last = withShowcase.at(-1)
  store.requestRunApproval(run.id, {
    nodeId: node.id, title: `${wfNodeTitle(node)}: ${globalTaskTitle(run)}`, body,
    ...(last ? { showcaseDispatchId: last.dispatch.id } : {})
  })
}

/** Итог git-ноды прогона: `error` — git отказал (исход `error`), `blocked` — ошибка настройки (граф не двигается). */
type GitRun = { kind: 'ok' } | { kind: 'error'; text: string } | { kind: 'blocked'; reason: string }

/**
 * Нода `git` прогона: `commit` и `push` в worktree ветки глобальной задачи (`RunGit.worktree`, при необходимости
 * восстанавливается). `create_branch`/`checkout` в воркфлоу прогона не бывают (валидация) — здесь `blocked`. Шаблоны
 * подставляются по прогону: `{taskId}` — его id, `{title}` и `{slug}` — название. Отказ git или окружения — `error`.
 */
function runGitNode(deps: RunWorkflowDeps, run: Run, node: Extract<WfNode, { type: 'git' }>, a: Extract<WfAction, { type: 'git' }>): GitRun {
  const title = wfNodeTitle(node)
  if (a.operation !== 'commit' && a.operation !== 'push') {
    return { kind: 'blocked', reason: `нода «${title}»: операция «${a.operation}» не поддерживается в воркфлоу глобальной задачи — доступны commit и push` }
  }
  const vars = wfGitVars({ id: run.id, title: globalTaskTitle(run) })
  const commitMessage = a.message !== undefined ? renderGitTemplate(a.message, vars).trim() : undefined
  if (a.operation === 'commit' && !commitMessage) return { kind: 'blocked', reason: `нода «${title}»: сообщение коммита после подстановки пустое` }
  if (!run.git) return { kind: 'error', text: 'у глобальной задачи нет ветки — коммитить и пушить нечего (глобальная задача начата до веток)' }
  try {
    const g = ensureRunBranch(deps.store, deps.repoRoot, run.id) ?? run.git
    if (a.operation === 'commit') {
      if (!g.worktree) return { kind: 'error', text: 'у ветки глобальной задачи нет worktree — коммитить нечего' }
      gitCommit(g.worktree, commitMessage!)
    } else {
      const remote = a.remote ?? 'origin'
      if (!isBranchNameAcceptedByGit(deps.repoRoot, g.branch)) return { kind: 'error', text: `имя ветки «${g.branch}» недопустимо для git` }
      // Итог push — исход ноды (`ok` / `error` с текстом git): в `Run.git` его не пишем, поля push убраны (`migrateRunGit`).
      gitPush(deps.repoRoot, g.worktree && existsSync(g.worktree) ? g.worktree : undefined, remote, g.branch)
    }
  } catch (e) {
    return { kind: 'error', text: message(e) }
  }
  return { kind: 'ok' }
}

// ---------- решения человека и проверки ----------

/** Решение approval уровня прогона (нода `human`): переход по исходу, если прогон всё ещё стоит на этой ноде. */
function runApprovalResolved(deps: RunWorkflowDeps, request: HumanRequest): void {
  const run = deps.store.getRun(request.runId)
  const action = request.resolution?.action
  if (!run || run.workflowScope !== 'run' || !run.stage || (action !== 'accept' && action !== 'reject')) return
  if (request.nodeId !== undefined && run.stage.nodeId !== request.nodeId) return
  if (graphOf(deps, run.id).nodes.find((n) => n.id === run.stage!.nodeId)?.type !== 'human') return
  const text = request.resolution?.text?.trim() || undefined
  const images = request.resolution?.images
  try {
    advanceRun(deps, run.id, action, action === 'accept' ? (text ? { decision: text } : {}) : text ? { feedback: text, ...(images?.length ? { images } : {}) } : {})
  } catch (e) {
    deps.store.blockRunStage(run.id, `ошибка исполнителя воркфлоу: ${message(e)}`)
  }
}

/**
 * Approval «Конфликт мержа» от сборки без пути подзадачи (`SUBTASK_MERGE_NODE`): «Принять» — человек разрешил конфликт в
 * ветке задачи, задача входит в путь и идёт от «Работы» к мержу, как после `done`; «Вернуть» — замечания уже в
 * `feedback` задачи, воркер стартует заново (запуск сам вводит задачу в путь).
 */
function legacyConflictResolved(deps: RunWorkflowDeps, request: HumanRequest): void {
  const task = request.taskId !== undefined ? deps.store.getTask(request.taskId) : undefined
  const action = request.resolution?.action
  if (!task || task.stage || (action !== 'accept' && action !== 'reject')) return
  try {
    if (action === 'accept') {
      enterWork(deps, task.id)
      advance(deps, task.id, 'next')
    } else deps.startWorker(task.id)
  } catch (e) {
    deps.store.blockStage(task.id, `не удалось продолжить после конфликта мержа: ${message(e)}. Запустить заново: orca-board worker start --task ${task.id}`)
  }
}

/**
 * Решён запрос прогона (IPC `requests:resolve`, `request resolve`, «Подтвердить»/«Вернуть» на карточке): approval — прогон
 * идёт по исходу ноды `human`, decision — по ветке, выбранной человеком. `false` — approval на задаче: его ведёт движок по
 * подзадачам (`approvalResolved` в `workflow.ts`: нода `human` пути подзадачи, в том числе «Конфликт мержа»), кроме
 * устаревшего `SUBTASK_MERGE_NODE`.
 */
export function handleRunRequest(deps: RunWorkflowDeps, request: HumanRequest): boolean {
  if (request.kind === 'decision') {
    withStatusSource('workflow', () => runDecisionResolved(deps, request))
    return true
  }
  if (request.kind !== 'approval') return false
  if (request.taskId === undefined) {
    withStatusSource('workflow', () => runApprovalResolved(deps, request))
    return true
  }
  if (request.nodeId !== SUBTASK_MERGE_NODE || !isRunScope(deps.store, request.runId)) return false
  withStatusSource('workflow', () => legacyConflictResolved(deps, request))
  return true
}

/** «Подтвердить» на карточке прогона на «Проверке»: решение approval ноды `human` и переход по `accept`. */
export function acceptRun(deps: RunWorkflowDeps, runId: string, decision?: string): GlobalTask {
  return decideRun(deps, runId, (id) => deps.store.acceptGlobalTask(id, decision))
}

/**
 * «Вернуть в работу» с «Проверки»: решение `reject` с замечаниями. Дальше граф идёт по ребру `reject` (обычно в «Работу»):
 * координатор получает `stage_started` с замечаниями, а если он не жив — запускается заново.
 */
export function returnRun(deps: RunWorkflowDeps, runId: string, text: string, images?: string[]): GlobalTask {
  return decideRun(deps, runId, (id) => deps.store.returnGlobalTask(id, text, images))
}

function decideRun(deps: RunWorkflowDeps, runId: string, decide: (runId: string) => GlobalTask): GlobalTask {
  const { store } = deps
  if (!isRunScope(store, runId)) return decide(runId)
  const pending = store.pendingRequests(runId).find((r) => r.taskId === undefined && r.kind === 'approval')
  decide(runId)
  const request = pending ? store.getRequest(pending.id) : undefined
  if (request) handleRunRequest(deps, request)
  return store.getGlobalTask(runId)
}

/** Задача — проверка ветки глобальной задачи (`gateFor.runId`): её решение — исход ноды `gate`, а не приёмка задачи. */
export function isRunGate(task: Pick<Task, 'gateFor'> | undefined): boolean {
  return task?.gateFor?.runId !== undefined
}

/**
 * Проверка ещё должна вынести решение: прогон стоит на её ноде и это последняя проверка этой ноды (после `reject` →
 * «Работа» → новая проверка старая уже не в счёт).
 */
function gatePending(deps: RunWorkflowDeps, gate: Task): boolean {
  const { store } = deps
  const run = gate.gateFor?.runId !== undefined ? store.getRun(gate.gateFor.runId) : undefined
  if (!run || !gate.gateFor || run.stage?.nodeId !== gate.gateFor.nodeId || run.closedAt !== undefined) return false
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
export function runGateDecision(deps: RunWorkflowDeps, gateTaskId: string, outcome: 'accept' | 'reject', text?: string, images?: string[]): void {
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
    const node = run.stage ? graphOf(deps, runId).nodes.find((n) => n.id === run.stage!.nodeId) : undefined
    const where = node ? `на этапе «${wfNodeTitle(node)}»` : 'не на этапе проверки'
    throw new Error(`проверка ${gateTaskId} уже не актуальна: глобальная задача ${runId} сейчас ${where} — решение по ней принято или проверка заменена новой`)
  }
  const comment = text?.trim() || undefined
  advanceRun(deps, runId, outcome, comment ? (outcome === 'reject' ? { feedback: comment, ...(images?.length ? { images } : {}) } : { decision: comment }) : {})
  if (deps.store.columnKind(mustTask(deps, gateTaskId).status) === 'review') closeStageTask(deps, gate)
}

/** Закрыть служебную задачу этапа (проверку, вопрос): worktree и ветка — удалить (сливать нечего), задача — в done. */
function closeStageTask(deps: RunWorkflowDeps, task: Task): void {
  if (task.worktree && task.branch) {
    try {
      removeWorktree(deps.repoRoot, task.worktree, task.branch, task.branchForeign === true)
    } catch {
      /* worktree служебной задачи не критичен: задача всё равно закрывается */
    }
  }
  deps.store.acceptTask(task.id)
}

/**
 * Проверка сдала `done` или её воркер вышел. Решение уже есть — проверка закрывается. Нет решения после `done` —
 * `workflow_blocked` по прогону, проверка остаётся на ревью (её можно перезапустить). Воркер вышел без `done` и без
 * решения — ничего: эскалацию («Перезапустить» / «Скрыть») уже завёл store.
 */
function settleGate(deps: RunWorkflowDeps, gate: Task, why: 'done' | 'exit'): void {
  if (!gatePending(deps, gate)) {
    closeStageTask(deps, gate)
    return
  }
  if (why === 'done') {
    deps.store.blockRunStage(
      gate.gateFor!.runId!,
      `проверка ${gate.id} сдана без решения (нет review accept/reject по задаче ${gate.id}). ` +
        `Перезапустить проверку: orca-board task reopen --task ${gate.id} --start; или решите в приложении: «Принять» / «Вернуть» у задачи ${gate.id}`
    )
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
export function isRunDecider(deps: RunWorkflowDeps, task: Task | undefined): boolean {
  return task !== undefined && deciderNode(deps, task) !== undefined
}

/**
 * Решатель ещё отвечает за развилку: граф стоит на её ноде, прогон не закрыт и это задача текущего захода (после возврата
 * в развилку старая задача уже не в счёт). Ждущий запрос человеку здесь не учитывается — его проверяют вызывающие.
 */
function deciderCurrent(deps: RunWorkflowDeps, task: Task): { run: Run; node: DecisionNode } | undefined {
  const node = deciderNode(deps, task)
  const run = node ? deps.store.getRun(task.gateFor!.runId!) : undefined
  if (!node || !run || run.closedAt !== undefined || run.stage?.nodeId !== node.id) return undefined
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
function applyChoice(deps: RunWorkflowDeps, runId: string, node: DecisionNode, chosen: StageDecision): void {
  advanceRun(deps, runId, chosen.optionId, { chosen, decision: decisionText(node, chosen) })
}

/** Закрыть задачу-решатель, если её воркер уже не работает (сдал `done`, не запустился); живую закроет её `done`. */
function closeIdleDecider(deps: RunWorkflowDeps, task: Task | undefined): void {
  if (!task) return
  const kind = deps.store.columnKind(mustTask(deps, task.id).status)
  if (kind !== 'in_progress' && kind !== 'done') closeStageTask(deps, mustTask(deps, task.id))
}

/**
 * `decision choose` агента-решателя (сокет → `ProjectDeps.decide` в index.ts): вариант по id или метке, граф идёт по его
 * ветке, решение `by: 'agent'` с обоснованием — в историю развилки. Решение уже принято, граф ушёл, есть более новый
 * решатель или решение передано человеку — ошибка, граф не трогается. Неизвестный вариант — ошибка со списком id.
 */
export function runDecision(
  deps: RunWorkflowDeps, taskId: string, option: string, reason: string
): { runId: string; nodeId: string; optionId: string; label: string; to: string } {
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
  withStatusSource('workflow', () => applyChoice(deps, run.id, node, { optionId: picked.id, label: picked.label, reason: text, by: 'agent' }))
  if (deps.store.columnKind(mustTask(deps, taskId).status) === 'review') closeStageTask(deps, mustTask(deps, taskId))
  return { runId: run.id, nodeId: node.id, optionId: picked.id, label: picked.label, to }
}

/**
 * `decision escalate` агента-решателя: запрос `decision` человеку с теми же вариантами, `fallback: 'unsure'`, комментарий
 * агента — `agentNote`. Повтор при уже ждущем запросе возвращает его; решение уже принято — ошибка.
 */
export function escalateDecision(deps: RunWorkflowDeps, taskId: string, reason: string): { requestId: string } {
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
function settleDecision(deps: RunWorkflowDeps, task: Task, why: 'done' | 'exit', dispatchId?: string): void {
  if (dispatchId !== undefined && task.dispatchId !== dispatchId) return
  const current = deciderCurrent(deps, task)
  if (!current) {
    closeStageTask(deps, task)
    return
  }
  if (why === 'exit') return
  if (!pendingDecisionRequest(deps, current.run.id, current.node.id)) {
    const summary = task.dispatchId ? deps.store.getDispatch(task.dispatchId)?.summary : undefined
    requestDecision(deps, current.run, current.node, 'no_answer', summary?.trim() ? { agentNote: summary } : {})
  }
  closeStageTask(deps, task)
}

/**
 * Человек выбрал ветку по запросу `decision` (Инбокс, `request resolve --option`): переход по ней с решением `by: 'human'`,
 * `fallback` и комментарием агента из запроса; задача-решатель закрывается, если её воркер уже не работает. Граф ушёл с
 * развилки — ничего (store уже отменил бы запрос). Варианта больше нет в графе (граф поменяли) — `workflow_blocked`.
 */
function runDecisionResolved(deps: RunWorkflowDeps, request: HumanRequest): void {
  const run = deps.store.getRun(request.runId)
  const optionId = request.resolution?.optionId
  if (!run || run.workflowScope !== 'run' || !run.stage || request.taskId !== undefined || optionId === undefined) return
  if (request.nodeId === undefined || run.stage.nodeId !== request.nodeId || run.closedAt !== undefined) return
  const node = graphOf(deps, run.id).nodes.find((n) => n.id === request.nodeId)
  if (node?.type !== 'decision') return
  const option = decisionOptions(node).find((o) => o.id === optionId)
  if (!option) {
    deps.store.blockRunStage(run.id, `нода «${wfNodeTitle(node)}»: варианта «${optionId}» больше нет в воркфлоу — выберите ветку заново или верните граф руками`)
    return
  }
  const decider = currentDecider(deps, run, node.id)
  const text = request.resolution?.text?.trim()
  try {
    applyChoice(deps, run.id, node, {
      optionId: option.id, label: option.label, by: 'human',
      ...(text ? { reason: text.slice(0, DECISION_REASON_LIMIT) } : {}),
      ...(request.fallback ? { fallback: request.fallback } : {}),
      ...(request.agentNote ? { agentNote: request.agentNote } : {})
    })
    closeIdleDecider(deps, decider)
  } catch (e) {
    deps.store.blockRunStage(run.id, `ошибка исполнителя воркфлоу: ${message(e)}`)
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
function askDone(deps: RunWorkflowDeps, task: Task, dispatchId: string | undefined): void {
  // Сданный прошлый запуск (задачу уже перезапустили) переход не делает.
  if (dispatchId !== undefined && task.dispatchId !== dispatchId) return
  const run = mustRun(deps, task.runId!)
  const answers = answersText(deps, task.id)
  closeStageTask(deps, task)
  const stage = run.stage
  if (!stage || run.closedAt !== undefined || stage.nodeId !== task.stageOf?.nodeId || (stage.visits[stage.nodeId] ?? 1) !== task.stageOf.visit) return
  advanceRun(deps, run.id, 'next', answers ? { answers } : {})
}

/**
 * Человек ответил на вопрос с этапа `ask`, а агента уже нет (упал, перезапуск приложения): воркер стартует сам, ответ
 * попадает в его промпт. Живой воркер получает ответ через свой `ask`. Ошибка запуска — `workflow_blocked`.
 */
function restartAsk(deps: RunWorkflowDeps, task: Task, workerLive: boolean): void {
  if (workerLive || task.gateFor || !task.runId) return
  const node = deps.store.taskStageNode(task.id, { roleIds: deps.run(task.runId).roles.map((r) => r.id) })
  if (node?.type !== 'ask' || deps.store.columnKind(task.status) !== 'ready') return
  try {
    deps.startWorker(task.id)
  } catch (e) {
    deps.store.blockRunStage(task.runId, `воркер не запустился после ответа: ${message(e)}. Запустить заново: orca-board worker start --task ${task.id}`)
  }
}

/**
 * Подзадача, не привязанная к этапу «Работа» (заготовлена до входа в граф), сдала `done`: пути у неё нет, а сливать в
 * ветку прогона по графу нечем — задача ждёт ручной приёмки («Принять»: прежняя приёмка с мержем).
 */
function unboundSubtaskDone(deps: RunWorkflowDeps, task: Task): void {
  deps.store.blockStage(
    task.id,
    `подзадача не привязана к этапу «Работа» (создана до входа глобальной задачи в граф) — пути подзадачи у неё нет. ` +
      `Принять вручную: «Принять» в приложении или orca-board review accept --task ${task.id}`
  )
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
export function handleRunWorkflowEvents(deps: RunWorkflowDeps, events: readonly OrcaEvent[]): void {
  withStatusSource('workflow', () => {
    for (const e of events) {
      if (!e.taskId || (e.type !== 'worker_done' && e.type !== 'escalation' && e.type !== 'question_answered')) continue
      const task = deps.store.getTask(e.taskId)
      if (!task || task.answerFor || taskEngine(deps, task) !== 'run') continue
      try {
        if (e.type === 'question_answered') {
          restartAsk(deps, task, e.payload.workerLive === true)
        } else if (e.type === 'worker_done') {
          if (isRunDecider(deps, task)) settleDecision(deps, task, 'done', e.dispatchId)
          else if (isRunGate(task)) settleGate(deps, task, 'done')
          else if (!task.gateFor) {
            const node = task.stageOf ? deps.store.taskStageNode(task.id, { roleIds: deps.run(task.runId).roles.map((r) => r.id) }) : undefined
            if (node?.type === 'ask') askDone(deps, task, e.dispatchId)
            else if (e.dispatchId === undefined || task.dispatchId === e.dispatchId) unboundSubtaskDone(deps, task)
          }
        } else if (isRunDecider(deps, task) && e.payload.stuck !== true) {
          settleDecision(deps, task, 'exit')
        } else if (isRunGate(task) && e.payload.stuck !== true) {
          settleGate(deps, task, 'exit')
        }
      } catch (err) {
        deps.store.blockRunStage(task.runId!, `ошибка исполнителя воркфлоу: ${message(err)}`)
      }
    }
  })
}
