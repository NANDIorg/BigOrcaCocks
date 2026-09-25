import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  globalTaskTitle, renderGitTemplate, runAskTaskSpec, runAskTaskTitle, runGateTaskSpec, runGateTaskTitle, wfGitVars, wfNodeTitle, withStatusSource,
  type GlobalTask, type HumanRequest, type OrcaEvent, type Role, type Run, type RunBranchSettings, type RunStageOptions, type RunTaskContext, type Task,
  type TaskStore, type WfAction, type WfNode, type WfOutcome, type Workflow
} from '@orca-board/core'
import { gitCommit, gitPush, isBranchNameAcceptedByGit, removeWorktree } from './git'
import { mergeTaskBranch, type MergeTargetOf } from './review'
import { ensureRunBranch, mergeRunBranch } from './run-branch'
import { showcaseMarkdown } from '../shared/showcase'

// Исполнитель воркфлоу глобальной задачи (docs/workflow.md → «Воркфлоу глобальной задачи»): позицию на графе хранит
// `Run.stage`, переходы делает store (`advanceRunStage`, `finishStage`), здесь выполняются эффекты нод — событие и
// перезапуск координатора на «Работе», задачи проверки и вопроса, approval человека, git, слияние ветки прогона в базу.
// Подзадачи по графу не ходят: воркер → `done` → автомерж в ветку прогона. Прогоны без `Run.workflowScope: 'run'` идут
// прежним движком по подзадачам (`workflow.ts`); этот модуль их не трогает.

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
  /** Настройки веток глобальных задач проекта: защищённые ветки, remote и шаблон имени. */
  gitSettings(): RunBranchSettings
  /** Куда сливать ветку подзадачи (`mergeTarget` в `run-branch.ts`). Нет — текущая ветка корня (тесты). */
  mergeTarget?: MergeTargetOf
}

/** Сколько переходов подряд без ожидания (мерж → условие → git…) допускается, прежде чем считать граф зациклившимся. */
const MAX_STEPS = 50

/**
 * Id ноды в approval «Конфликт мержа» подзадачи (запрос на задаче, а не на прогоне): его решает `subtaskConflictResolved`,
 * а не переход по графу — у подзадач своего этапа нет.
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

/** Опции переходов store: роли и граф типа (запасные), коммит входа в этап и то, что человек или проверка сказали. */
function stageOpts(deps: RunWorkflowDeps, runId: string, extra: Pick<RunStageOptions, 'feedback' | 'decision' | 'answers'> = {}): RunStageOptions {
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
 * причины `workflow_blocked` (защищённая база, роль проверки).
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
export function advanceRun(deps: RunWorkflowDeps, runId: string, outcome: WfOutcome, extra: Pick<RunStageOptions, 'feedback' | 'decision' | 'answers'> = {}): void {
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
      case 'request_human':
        if (node?.type === 'human') requestHuman(deps, run, node, note)
        return
      case 'merge': {
        const g = run.git
        if (!g) {
          store.blockRunStage(runId, 'слияние в базу невозможно: у глобальной задачи нет ветки (настройка веток выключена или прогон начат без ветки)')
          return
        }
        let result: ReturnType<typeof mergeRunBranch>
        try {
          result = mergeRunBranch(deps.repoRoot, g, deps.gitSettings(), `Merge orca run: ${globalTaskTitle(run)}`)
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
    store.blockRunStage(run.id, `нода «${wfNodeTitle(node)}»: у глобальной задачи нет ветки — проверять нечего (настройка веток выключена или прогон начат без ветки)`)
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
  if (!run.git) return { kind: 'error', text: 'у глобальной задачи нет ветки — коммитить и пушить нечего (настройка веток выключена или прогон начат без ветки)' }
  try {
    const g = ensureRunBranch(deps.store, deps.repoRoot, run.id, deps.gitSettings()) ?? run.git
    if (a.operation === 'commit') {
      if (!g.worktree) return { kind: 'error', text: 'у ветки глобальной задачи нет worktree — коммитить нечего' }
      gitCommit(g.worktree, commitMessage!)
    } else {
      const remote = a.remote ?? 'origin'
      if (!isBranchNameAcceptedByGit(deps.repoRoot, g.branch)) return { kind: 'error', text: `имя ветки «${g.branch}» недопустимо для git` }
      gitPush(deps.repoRoot, g.worktree && existsSync(g.worktree) ? g.worktree : undefined, remote, g.branch)
      deps.store.setRunGit(run.id, { pushedAt: Date.now(), pushError: undefined })
    }
  } catch (e) {
    const text = message(e)
    if (a.operation === 'push') deps.store.setRunGit(run.id, { pushError: text.slice(0, 2000) })
    return { kind: 'error', text }
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
  try {
    advanceRun(deps, run.id, action, action === 'accept' ? (text ? { decision: text } : {}) : text ? { feedback: text } : {})
  } catch (e) {
    deps.store.blockRunStage(run.id, `ошибка исполнителя воркфлоу: ${message(e)}`)
  }
}

/**
 * Approval «Конфликт мержа» подзадачи (`SUBTASK_MERGE_NODE`): «Принять» — человек разрешил конфликт в ветке задачи,
 * мерж повторяется; «Вернуть» — замечания уже в `feedback` задачи, воркер стартует заново.
 */
function subtaskConflictResolved(deps: RunWorkflowDeps, request: HumanRequest): void {
  const task = request.taskId !== undefined ? deps.store.getTask(request.taskId) : undefined
  const action = request.resolution?.action
  if (!task || (action !== 'accept' && action !== 'reject')) return
  try {
    if (action === 'accept') mergeSubtask(deps, task.id)
    else deps.startWorker(task.id)
  } catch (e) {
    deps.store.blockStage(task.id, `воркер не запустился после отказа: ${message(e)}. Запустить заново: orca-board worker start --task ${task.id}`)
  }
}

/**
 * Решён запрос approval (IPC `requests:resolve`, `request resolve`, «Подтвердить»/«Вернуть» на карточке): прогон идёт по
 * исходу ноды `human`, подзадача — по решению о конфликте мержа. `false` — запрос не из воркфлоу прогона: его ведёт
 * прежний движок (`approvalResolved` в `workflow.ts`).
 */
export function handleRunApproval(deps: RunWorkflowDeps, request: HumanRequest): boolean {
  if (request.kind !== 'approval') return false
  if (request.taskId === undefined) {
    withStatusSource('workflow', () => runApprovalResolved(deps, request))
    return true
  }
  if (request.nodeId !== SUBTASK_MERGE_NODE || !isRunScope(deps.store, request.runId)) return false
  withStatusSource('workflow', () => subtaskConflictResolved(deps, request))
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
export function returnRun(deps: RunWorkflowDeps, runId: string, text: string): GlobalTask {
  return decideRun(deps, runId, (id) => deps.store.returnGlobalTask(id, text))
}

function decideRun(deps: RunWorkflowDeps, runId: string, decide: (runId: string) => GlobalTask): GlobalTask {
  const { store } = deps
  if (!isRunScope(store, runId)) return decide(runId)
  const pending = store.pendingRequests(runId).find((r) => r.taskId === undefined && r.kind === 'approval')
  decide(runId)
  const request = pending ? store.getRequest(pending.id) : undefined
  if (request) handleRunApproval(deps, request)
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
export function runGateDecision(deps: RunWorkflowDeps, gateTaskId: string, outcome: 'accept' | 'reject', text?: string): void {
  const gate = mustTask(deps, gateTaskId)
  const runId = gate.gateFor?.runId
  if (runId === undefined) throw new Error(`задача ${gateTaskId} — не проверка ветки глобальной задачи`)
  if (!gatePending(deps, gate)) {
    const run = mustRun(deps, runId)
    const node = run.stage ? graphOf(deps, runId).nodes.find((n) => n.id === run.stage!.nodeId) : undefined
    const where = node ? `на этапе «${wfNodeTitle(node)}»` : 'не на этапе проверки'
    throw new Error(`проверка ${gateTaskId} уже не актуальна: глобальная задача ${runId} сейчас ${where} — решение по ней принято или проверка заменена новой`)
  }
  const comment = text?.trim() || undefined
  advanceRun(deps, runId, outcome, comment ? (outcome === 'reject' ? { feedback: comment } : { decision: comment }) : {})
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

// ---------- подзадачи: автомерж ----------

/**
 * Слить ветку подзадачи в ветку прогона и закрыть задачу. Не слилось (конфликт) — approval «Конфликт мержа» на самой
 * задаче: человек разрешает конфликт в её ветке и жмёт «Принять» (мерж повторяется) или «Вернуть». Ошибка не конфликтом
 * (защищённая ветка корня у прогона без ветки, не удалось убрать worktree) — `workflow_blocked` по задаче: вручную её
 * принимает человек («Принять» — прежняя приёмка).
 */
function mergeSubtask(deps: RunWorkflowDeps, taskId: string): void {
  const { store } = deps
  const task = mustTask(deps, taskId)
  if (store.columnKind(task.status) === 'done') return
  let result: ReturnType<typeof mergeTaskBranch>
  try {
    // Цель — только когда есть что сливать: защищённая ветка корня не должна останавливать задачу без ветки.
    const target = task.worktree && task.branch ? deps.mergeTarget?.(task) : undefined
    result = mergeTaskBranch(deps.repoRoot, task, target)
  } catch (e) {
    store.blockStage(taskId, `мерж подзадачи не выполнен: ${message(e)}. Принять вручную: «Принять» в приложении или orca-board review accept --task ${taskId}`)
    return
  }
  if (result.ok) {
    store.acceptTask(taskId)
    return
  }
  store.requestApproval(taskId, {
    nodeId: SUBTASK_MERGE_NODE,
    title: `Конфликт мержа: ${task.title}`,
    body: [
      `Ветка \`${task.branch}\` не слилась в ветку глобальной задачи.`,
      `**Мерж не удался:**\n\n\`\`\`\n${result.error}\n\`\`\``,
      `Разрешите конфликт в ветке задачи${task.worktree ? ` (worktree \`${task.worktree}\`)` : ''} и нажмите «Принять» — мерж повторится; «Вернуть» — воркер продолжит с вашими замечаниями.`
    ].join('\n\n')
  })
}

/** Подзадача сдала `done`: автомерж в ветку прогона (сданный прошлый запуск, задача уже в done — пропуск). */
function subtaskDone(deps: RunWorkflowDeps, task: Task, dispatchId: string | undefined): void {
  if (dispatchId !== undefined && task.dispatchId !== dispatchId) return
  mergeSubtask(deps, task.id)
}

/**
 * События store → шаги воркфлоу прогона (подписка `projects.onEvents` в index.ts): `worker_done` подзадачи — автомерж,
 * задачи `ask` — переход дальше, проверки — закрытие; `escalation` проверки — закрытие, если решение уже есть;
 * `question_answered` на этапе `ask` без живого воркера — автоперезапуск. Задачи-ответы идут мимо воркфлоу, задачи
 * прогонов старого формата — на прежнем движке (`handleWorkflowEvents`). Ошибки не выбрасываются из подписки — они
 * становятся `workflow_blocked`.
 */
export function handleRunWorkflowEvents(deps: RunWorkflowDeps, events: readonly OrcaEvent[]): void {
  withStatusSource('workflow', () => {
    for (const e of events) {
      if (!e.taskId || (e.type !== 'worker_done' && e.type !== 'escalation' && e.type !== 'question_answered')) continue
      const task = deps.store.getTask(e.taskId)
      if (!task || task.answerFor || !isRunScope(deps.store, task.runId)) continue
      try {
        if (e.type === 'question_answered') {
          restartAsk(deps, task, e.payload.workerLive === true)
        } else if (e.type === 'worker_done') {
          if (isRunGate(task)) settleGate(deps, task, 'done')
          else if (!task.gateFor) {
            const node = task.stageOf ? deps.store.taskStageNode(task.id, { roleIds: deps.run(task.runId).roles.map((r) => r.id) }) : undefined
            if (node?.type === 'ask') askDone(deps, task, e.dispatchId)
            else subtaskDone(deps, task, e.dispatchId)
          }
        } else if (isRunGate(task) && e.payload.stuck !== true) {
          settleGate(deps, task, 'exit')
        }
      } catch (err) {
        deps.store.blockRunStage(task.runId!, `ошибка исполнителя воркфлоу: ${message(err)}`)
      }
    }
  })
}
