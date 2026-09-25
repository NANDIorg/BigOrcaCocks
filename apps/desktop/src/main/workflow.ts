import { existsSync } from 'node:fs'
import {
  gateTaskSpec, gateTaskTitle, isValidGitBranchName, renderGitTemplate, wfGitVars, wfNodeTitle, withStatusSource,
  type HumanRequest, type OrcaEvent, type Role, type RunWorkflowFallback, type Task, type TaskStore, type WfAction, type WfNode,
  type WfOutcome, type Workflow
} from '@orca-board/core'
import { acceptReview, mergeTaskBranch, type MergeTargetOf } from './review'
import { showcaseMarkdown } from '../shared/showcase'
import {
  commitWorktree, gitCheckout, gitCommit, gitCreateBranch, gitPush, isBranchNameAcceptedByGit, removeWorktree,
  removeWorktreeKeepBranch, taskWorktreePath
} from './git'

// Исполнитель воркфлоу (docs/workflow.md): store решает, куда задача переходит (`advanceStage`, чистый
// `nextStage` в core), здесь выполняются эффекты этапа — запуск воркера, задача-проверка, запрос человеку,
// мерж, конец. Координатор в жизненном цикле рабочей задачи больше не участвует.

export interface WorkflowDeps {
  store: TaskStore
  repoRoot: string
  /**
   * Тип прогона `runId` сейчас (`resolveRunType`): роли — для роли ноды «Работа» и гейта, граф типа — для прогона
   * без снимка графа. Без прогона («Входящие») — тип проекта по умолчанию.
   */
  run(runId: string | undefined): { roles: Role[]; workflow?: Workflow }
  /**
   * Запуск воркера задачи с проверками роли и агента (`runWorker` в index.ts). `roleId` — роль этапа «Вопрос
   * человеку»: она только на этот запуск, роль задачи не меняется (в отличие от роли «Работы»).
   */
  startWorker(taskId: string, opts?: { roleId?: string }): { ptyId: string; dispatchId: string }
  /**
   * Куда сливать ветку задачи на ноде `merge` и при приёмке вне графа (`mergeTarget` в `run-branch.ts`): ветка
   * глобальной задачи или текущая ветка корня, если она не защищённая. Нет — текущая ветка корня (тесты).
   */
  mergeTarget?: MergeTargetOf
}

/** Сколько переходов подряд без ожидания (мерж → условие → мерж…) допускается, прежде чем считать граф зациклившимся. */
const MAX_STEPS = 50

/** Запасной граф для store (`runWorkflow`): роли и граф типа прогона задачи. */
function fallback(deps: WorkflowDeps, task: Task): RunWorkflowFallback {
  const t = deps.run(task.runId)
  return { roleIds: t.roles.map((r) => r.id), ...(t.workflow ? { workflow: t.workflow } : {}) }
}

function rolesOf(deps: WorkflowDeps, task: Task): Role[] {
  return deps.run(task.runId).roles
}

function mustTask(deps: WorkflowDeps, taskId: string): Task {
  const task = deps.store.getTask(taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  return task
}

/** Нода, на которой стоит задача, в графе её прогона. */
function stageNode(deps: WorkflowDeps, task: Task): WfNode | undefined {
  if (!task.stage) return undefined
  return deps.store.runWorkflow(task.runId, fallback(deps, task)).nodes.find((n) => n.id === task.stage!.nodeId)
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Перенести задачу в колонку, если она есть на доске и задача ещё не там. */
function moveTo(deps: WorkflowDeps, taskId: string, status: string): void {
  const task = mustTask(deps, taskId)
  if (task.status !== status && deps.store.columnKind(status)) deps.store.moveTask(taskId, status)
}

/**
 * Перед запуском воркера рабочей задачи (`runWorker`): задача входит в граф или возвращается на этап
 * «Работа» (store.enterWork). Роль ноды «Работа», если задана, становится ролью задачи. Возвращает роль этапа
 * «Вопрос человеку» (если задача стоит на нём и роль задана): её `runWorker` передаёт в запуск, а на задачу
 * не переносит — иначе следующая «Работа» без своей роли запустилась бы ролью опросника.
 */
export function enterWork(deps: WorkflowDeps, taskId: string): { roleId?: string } {
  let action = deps.store.enterWork(taskId, fallback(deps, mustTask(deps, taskId)))
  // Первым этапом стоит нода «Git» (`start → git(create_branch) → work`): ветка и worktree готовятся до запуска
  // агента, а сам запуск остаётся за вызывающим (`runWorker`) — иначе воркер стартовал бы дважды.
  if (action?.type === 'git') action = prepareBeforeWork(deps, taskId, action)
  const node = stageNode(deps, mustTask(deps, taskId))
  if (node?.type === 'ask') return node.roleId ? { roleId: node.roleId } : {}
  if (action?.type === 'start_worker' && action.roleId) applyWorkRole(deps, taskId, action.roleId)
  return {}
}

/**
 * Выполнить git-ноды, стоящие перед первой «Работой»/«Вопросом человеку», и вернуть действие запуска воркера.
 * Цепочка ушла в другое место (ошибка git → человек, конец графа) или упёрлась в настройку — воркера здесь нет:
 * бросаем понятную причину, задача остаётся на своём этапе (запрос человеку уже создан), а не запускаем агента мимо графа.
 */
function prepareBeforeWork(deps: WorkflowDeps, taskId: string, first: WfAction): Extract<WfAction, { type: 'start_worker' }> {
  const parked = withStatusSource('workflow', () => executeSteps(deps, taskId, first, true))
  if (parked?.type === 'start_worker') return parked
  const task = mustTask(deps, taskId)
  const node = stageNode(deps, task)
  throw new Error(
    `воркер не запущен: до работы задача ${node ? `остановилась на этапе «${wfNodeTitle(node)}»` : 'вышла из воркфлоу'}` +
      ' — дальше по графу её ведёт приложение (запрос человеку, причина — в событии workflow_blocked / feedback задачи)'
  )
}

function applyWorkRole(deps: WorkflowDeps, taskId: string, roleId: string): void {
  const task = mustTask(deps, taskId)
  const role = rolesOf(deps, task).find((r) => r.id === roleId)
  if (role && task.roleId !== role.id) deps.store.updateTask(taskId, { roleId: role.id, agent: role.agent })
}

/** Исход текущего этапа задачи → переход по графу и эффекты новых этапов. */
export function advance(deps: WorkflowDeps, taskId: string, outcome: WfOutcome): void {
  const { action } = deps.store.advanceStage(taskId, outcome, fallback(deps, mustTask(deps, taskId)))
  execute(deps, taskId, action)
}

/**
 * Выполнить действие этапа. Мерж ждать не нужно — после него переход идёт сразу (ok / conflict), остальные
 * действия ждут воркера, проверку или человека. Любая ошибка эффекта — `workflow_blocked`, задача остаётся на этапе.
 */
function execute(deps: WorkflowDeps, taskId: string, first: WfAction): void {
  // Колонку дальше двигает граф, а не тот, чья команда дала исход: в истории статусов — workflow.
  withStatusSource('workflow', () => executeSteps(deps, taskId, first))
}

/**
 * `deferWorker` — не запускать воркера, а вернуть его действие (`enterWork`: воркера стартует вызывающий). Возвращает
 * отложенное действие; во всех остальных случаях — undefined.
 */
function executeSteps(deps: WorkflowDeps, taskId: string, first: WfAction, deferWorker = false): WfAction | undefined {
  const { store } = deps
  let action = first
  // Текст конфликта мержа или отказа git — в запрос человеку, если следующий этап — человек.
  let note: { title: string; text: string } | undefined
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const task = store.getTask(taskId)
    if (!task) return undefined
    const node = store.runWorkflow(task.runId, fallback(deps, task)).nodes.find((n) => n.id === action.nodeId)
    switch (action.type) {
      case 'start_worker':
        if (deferWorker) return action
        // «Вопрос человеку» роль на задачу не переносит: она только для этого запуска.
        if (node?.type !== 'ask' && action.roleId) applyWorkRole(deps, taskId, action.roleId)
        // Колонка «Работы» — «В работе», её ставит сам запуск; до него (и при ошибке) задача ждёт в ready.
        if (store.columnKind(task.status) !== 'in_progress') moveTo(deps, taskId, store.columnId('ready'))
        try {
          if (node?.type === 'ask') deps.startWorker(taskId, action.roleId ? { roleId: action.roleId } : undefined)
          else deps.startWorker(taskId)
        } catch (e) {
          store.blockStage(taskId, `воркер не запустился: ${message(e)}. Запустить заново: orca-board worker start --task ${taskId}`)
        }
        return
      case 'create_gate':
        if (node?.type === 'gate') createGate(deps, task, node)
        return
      case 'request_human':
        if (node?.type === 'human') requestHuman(deps, task, node, note)
        return
      case 'merge': {
        let result: ReturnType<typeof mergeTaskBranch>
        try {
          // Цель — только когда есть что сливать: защищённая ветка корня не должна останавливать задачу без ветки.
          const target = task.worktree && task.branch ? deps.mergeTarget?.(task) : undefined
          result = mergeTaskBranch(deps.repoRoot, task, target)
        } catch (e) {
          store.blockStage(taskId, `мерж не выполнен: ${message(e)}`)
          return
        }
        if (result.ok) {
          note = undefined
          if (task.worktree !== undefined || task.branch !== undefined) {
            store.updateTask(taskId, { worktree: undefined, branch: undefined, branchForeign: undefined })
          }
        } else note = { title: 'Мерж не удался', text: result.error }
        action = store.advanceStage(taskId, result.ok ? 'ok' : 'conflict', fallback(deps, task)).action
        continue
      }
      case 'git': {
        if (node?.type !== 'git') {
          store.blockStage(taskId, `нода «${action.nodeId}» не найдена в воркфлоу или это не нода «Git»`)
          return
        }
        const run = runGitNode(deps, task, node, action)
        if (run.kind === 'blocked') {
          store.blockStage(taskId, run.reason)
          return
        }
        const outcome: WfOutcome = run.kind === 'ok' ? 'ok' : 'error'
        if (run.kind === 'error') {
          // Как замечания при reject: если `error` ведёт в «Работу», воркер увидит причину в промпте.
          store.updateTask(taskId, { feedback: run.text })
          note = { title: `Git-операция «${action.operation}» не удалась`, text: run.text }
          if (!store.runWorkflow(task.runId, fallback(deps, task)).edges.some((e) => e.from === node.id && e.outcome === 'error')) {
            store.blockStage(taskId, `нода «${wfNodeTitle(node)}»: ${run.text}; у ноды нет перехода «error» — добавьте его в воркфлоу (например, к человеку)`)
            return
          }
        } else note = undefined
        action = store.advanceStage(taskId, outcome, fallback(deps, task)).action
        continue
      }
      case 'done':
        finish(deps, task)
        return
      case 'blocked':
        // Событие workflow_blocked уже отправил store (advanceStage).
        return
    }
  }
  store.blockStage(taskId, `больше ${MAX_STEPS} переходов подряд без ожидания — проверьте граф воркфлоу на цикл через мерж или git`)
}

/** Итог git-ноды: `error` — git отказал (исход `error`), `blocked` — ошибка настройки (граф не двигается). */
type GitRun = { kind: 'ok' } | { kind: 'error'; text: string } | { kind: 'blocked'; reason: string }

/**
 * Нода `git`: выполнить операцию в worktree задачи и обновить `Task.worktree`/`Task.branch`, если ветка сменилась —
 * дальше `merge`, `review info`, гейты и `push` работают с актуальной веткой. Шаблоны подставляются здесь. Отказ git
 * или окружения — `error` с текстом `git <команда>: <причина>`; недопустимое имя ветки после подстановки — `blocked`
 * (это настройка, отказать git не мог: он не запускался). Подробности — docs/workflow.md → «Нода Git».
 */
function runGitNode(deps: WorkflowDeps, task: Task, node: Extract<WfNode, { type: 'git' }>, a: Extract<WfAction, { type: 'git' }>): GitRun {
  const { store, repoRoot } = deps
  const title = wfNodeTitle(node)
  const vars = wfGitVars(task)
  const branch = a.branch !== undefined ? renderGitTemplate(a.branch, vars).trim() : undefined
  if (branch !== undefined && (!isValidGitBranchName(branch) || !isBranchNameAcceptedByGit(repoRoot, branch))) {
    return { kind: 'blocked', reason: `нода «${title}»: имя ветки «${branch}» после подстановки недопустимо для git (правила git check-ref-format)` }
  }
  const commitMessage = a.message !== undefined ? renderGitTemplate(a.message, vars).trim() : undefined
  if (a.operation === 'commit' && !commitMessage) {
    return { kind: 'blocked', reason: `нода «${title}»: сообщение коммита после подстановки пустое` }
  }
  // Worktree ещё нет (нода до первой «Работы») — операции создадут его по тому же пути, что и `startWorker`.
  const worktree = task.worktree ?? taskWorktreePath(repoRoot, task.id)
  try {
    switch (a.operation) {
      case 'create_branch': {
        // База по умолчанию — ветка глобальной задачи (туда сольёт `merge`), как у `orca/<id>` в `startWorker`. Worktree
        // уже есть — ветвимся от него (`base` не подставляем), иначе коммиты задачи остались бы в старой ветке.
        const runBranch = task.runId ? store.getRun(task.runId)?.git?.branch : undefined
        gitCreateBranch(repoRoot, worktree, branch!, a.base ?? (existsSync(worktree) ? undefined : runBranch), task.branch === branch)
        store.updateTask(task.id, { worktree, branch, branchForeign: undefined })
        break
      }
      case 'checkout': {
        gitCheckout(repoRoot, worktree, branch!)
        // Ветку `orca/<id>` или ту, что задача уже вела как свою, чужой не считаем: уборка её удалит, как обычно.
        const own = branch === `orca/${task.id}` || (branch === task.branch && task.branchForeign !== true)
        store.updateTask(task.id, { worktree, branch, branchForeign: own ? undefined : true })
        break
      }
      case 'commit':
        gitCommit(worktree, commitMessage!)
        break
      case 'push':
        if (!task.branch) return { kind: 'error', text: 'у задачи нет ветки — нечего пушить (поставьте create_branch, checkout или «Работу» раньше)' }
        gitPush(repoRoot, existsSync(worktree) ? worktree : undefined, a.remote ?? 'origin', task.branch)
        break
    }
  } catch (e) {
    return { kind: 'error', text: message(e) }
  }
  return { kind: 'ok' }
}

/** Нода gate: задача-проверка на ветку рабочей задачи и сразу её воркер. Рабочая задача — в колонку этапа (по умолчанию «Ревью»). */
function createGate(deps: WorkflowDeps, task: Task, node: Extract<WfNode, { type: 'gate' }>): void {
  const { store } = deps
  const role = rolesOf(deps, task).find((r) => r.id === node.roleId)
  if (!role) {
    store.blockStage(task.id, `нода «${wfNodeTitle(node)}»: нет роли «${node.roleId}» в типе задачи`)
    return
  }
  moveTo(deps, task.id, node.column ?? store.columnId('review'))
  const gate = store.createTask({
    title: gateTaskTitle(task, node),
    spec: gateTaskSpec(task, node),
    roleId: role.id,
    agent: role.agent,
    runId: task.runId,
    gateFor: { taskId: task.id, nodeId: node.id }
  })
  try {
    deps.startWorker(gate.id)
  } catch (e) {
    store.blockStage(task.id, `проверка ${gate.id} «${gate.title}» не запустилась: ${message(e)}. Запустить заново: orca-board worker start --task ${gate.id}`)
  }
}

/** Нода human: запрос approval в Инбокс; задача — в «Нужен ответ» (или в колонку этапа, если она задана). */
function requestHuman(deps: WorkflowDeps, task: Task, node: Extract<WfNode, { type: 'human' }>, note?: { title: string; text: string }): void {
  const { store } = deps
  const dispatch = task.dispatchId ? store.getDispatch(task.dispatchId) : undefined
  const summary = dispatch?.summary?.trim()
  // Показ последнего done рабочей задачи (нода «Работа» с showcase): гейт между ними — отдельная задача, не мешает.
  const showcase = dispatch?.outcome === 'done' ? dispatch.showcase : undefined
  const body = [
    node.instructions?.trim(),
    note ? `**${note.title}:**\n\n\`\`\`\n${note.text}\n\`\`\`` : undefined,
    summary ? `**Итог воркера:** ${summary}` : undefined,
    showcase ? showcaseMarkdown(showcase) : undefined,
    task.branch ? `Ветка: \`${task.branch}\`${task.worktree ? `, worktree: \`${task.worktree}\`` : ''}` : undefined,
    '«Принять» — дальше по воркфлоу (обычно мерж), «Вернуть» — с замечаниями.'
  ].filter(Boolean).join('\n\n')
  store.requestApproval(task.id, {
    nodeId: node.id, title: `${wfNodeTitle(node)}: ${task.title}`, body,
    ...(showcase && dispatch ? { showcaseDispatchId: dispatch.id } : {})
  })
  if (node.column) moveTo(deps, task.id, node.column)
}

/**
 * Нода end: задача в done. Ветка уже слита (мерж её удалил) — обычная приёмка. Не слита (конец без мержа) —
 * хвосты коммитятся, worktree убирается, а ветка остаётся: работа не попала в основную ветку, но и не потеряна.
 */
function finish(deps: WorkflowDeps, task: Task): void {
  const { store } = deps
  if (!task.branch) {
    store.acceptTask(task.id)
    return
  }
  try {
    if (task.worktree) {
      commitWorktree(task.worktree, `orca: ${task.title}`)
      removeWorktreeKeepBranch(deps.repoRoot, task.worktree)
    }
  } catch (e) {
    store.blockStage(task.id, `конец без мержа: не удалось убрать worktree — ${message(e)}`)
    return
  }
  store.updateTask(task.id, { status: store.columnId('done'), worktree: undefined })
}

/** Закрыть задачу-проверку: её worktree и ветку — удалить (сливать из неё нечего), задачу — в done. */
function closeGate(deps: WorkflowDeps, gate: Task): void {
  if (gate.worktree && gate.branch) {
    try {
      removeWorktree(deps.repoRoot, gate.worktree, gate.branch)
    } catch {
      /* worktree проверки не критичен: задача всё равно закрывается */
    }
  }
  deps.store.acceptTask(gate.id)
}

/**
 * Проверка ещё должна вынести решение: рабочая задача стоит на её ноде, и это последняя проверка этой ноды
 * (после reject → работа → снова проверка старая уже не в счёт).
 */
function gatePending(deps: WorkflowDeps, gate: Task): boolean {
  const { store } = deps
  const target = gate.gateFor ? store.getTask(gate.gateFor.taskId) : undefined
  if (!target || !gate.gateFor || target.stage?.nodeId !== gate.gateFor.nodeId || store.columnKind(target.status) === 'done') return false
  const latest = store.listTasks().filter((t) => t.gateFor?.taskId === target.id && t.gateFor.nodeId === gate.gateFor!.nodeId).at(-1)
  return latest?.id === gate.id
}

/**
 * Проверка сдала `done` или её воркер вышел. Решение уже есть — проверка закрывается. Нет решения после `done` —
 * `workflow_blocked` у рабочей задачи, проверка остаётся на ревью (её можно перезапустить). Воркер вышел без
 * `done` и без решения — ничего: эскалацию («Перезапустить» / «Скрыть») уже завёл store.
 */
function settleGate(deps: WorkflowDeps, gate: Task, why: 'done' | 'exit'): void {
  if (!gatePending(deps, gate)) {
    closeGate(deps, gate)
    return
  }
  if (why === 'done') {
    const target = gate.gateFor!.taskId
    deps.store.blockStage(
      target,
      `проверка ${gate.id} сдана без решения (нет review accept/reject по задаче ${target}). ` +
        `Перезапустить проверку: orca-board task reopen --task ${gate.id} --start; или решите в приложении: «Принять» / «Вернуть» у задачи ${target}`
    )
  }
}

/** Рабочая задача сдала `done`: этап «Работа» или «Вопрос человеку» → переход по `next`. */
function workDone(deps: WorkflowDeps, task: Task, dispatchId: string | undefined): void {
  // Сданный прошлый запуск (задачу уже перезапустили) переход не делает.
  if (dispatchId !== undefined && task.dispatchId !== dispatchId) return
  if (!task.stage) deps.store.enterWork(task.id, fallback(deps, task))
  const current = mustTask(deps, task.id)
  const node = stageNode(deps, current)
  if (node?.type !== 'work' && node?.type !== 'ask') {
    deps.store.blockStage(task.id, `воркер сдал работу, а задача на этапе «${node ? wfNodeTitle(node) : current.stage?.nodeId ?? '—'}», не на «Работе»`)
    return
  }
  advance(deps, task.id, 'next')
}

/**
 * События store → шаги воркфлоу (подписка `projects.onEvents` в index.ts, как `deliverAnswers`):
 * `worker_done` рабочей задачи — переход дальше, проверки — закрытие; `escalation` проверки — закрытие,
 * если решение уже есть; `question_answered` на этапе «Вопрос человеку» без живого воркера — автоперезапуск
 * (координатор в этом этапе не участвует). Задачи-ответы идут мимо воркфлоу. Ошибки не выбрасываются из подписки —
 * они становятся `workflow_blocked`.
 */
export function handleWorkflowEvents(deps: WorkflowDeps, events: readonly OrcaEvent[]): void {
  withStatusSource('workflow', () => handleEvents(deps, events))
}

function handleEvents(deps: WorkflowDeps, events: readonly OrcaEvent[]): void {
  for (const e of events) {
    if (!e.taskId || (e.type !== 'worker_done' && e.type !== 'escalation' && e.type !== 'question_answered')) continue
    const task = deps.store.getTask(e.taskId)
    if (!task || task.answerFor) continue
    try {
      if (e.type === 'question_answered') {
        restartAsk(deps, task, e.payload.workerLive === true)
      } else if (e.type === 'worker_done') {
        if (task.gateFor) settleGate(deps, task, 'done')
        else workDone(deps, task, e.dispatchId)
      } else if (task.gateFor && e.payload.stuck !== true) {
        settleGate(deps, task, 'exit')
      }
    } catch (err) {
      const target = task.gateFor?.taskId ?? task.id
      if (deps.store.getTask(target)) deps.store.blockStage(target, `ошибка исполнителя воркфлоу: ${message(err)}`)
    }
  }
}

/**
 * Человек ответил на вопрос с этапа «Вопрос человеку», а агента уже нет (упал, перезапуск приложения): воркер
 * стартует сам, ответ попадает в его промпт, этап не сбрасывается. Живой воркер получает ответ через свой `ask`.
 * Ошибка запуска — `workflow_blocked` (перехватывает вызывающий `handleEvents`).
 */
function restartAsk(deps: WorkflowDeps, task: Task, workerLive: boolean): void {
  if (workerLive || task.gateFor) return
  const node = stageNode(deps, task)
  if (node?.type !== 'ask') return
  // Задача не в ready (ушла в другую колонку, есть другой запрос) — запускать нечего.
  if (deps.store.columnKind(task.status) !== 'ready') return
  try {
    deps.startWorker(task.id, node.roleId ? { roleId: node.roleId } : undefined)
  } catch (e) {
    deps.store.blockStage(task.id, `воркер не запустился после ответа: ${message(e)}. Запустить заново: orca-board worker start --task ${task.id}`)
  }
}

/**
 * Решение по задаче на этапе проверки (gate или human) — `review accept/reject`, кнопки ревью в UI.
 * На ноде human это решение её запроса approval. Замечания при reject — в feedback для следующего запуска.
 */
function decide(deps: WorkflowDeps, task: Task, outcome: 'accept' | 'reject', text?: string): void {
  const node = stageNode(deps, task)
  if (node?.type !== 'gate' && node?.type !== 'human') {
    const where = node ? `«${wfNodeTitle(node)}»` : `«${task.stage?.nodeId ?? '—'}»`
    throw new Error(`задача ${task.id} на этапе ${where} — принимать или возвращать нечего: решение принимается на этапе проверки`)
  }
  const request = deps.store.pendingRequests().find((r) => r.taskId === task.id && r.kind === 'approval')
  const comment = text?.trim() || undefined
  if (request) deps.store.resolveRequest(request.id, { action: outcome, ...(comment ? { text: comment } : {}) })
  else if (outcome === 'reject' && comment) deps.store.updateTask(task.id, { feedback: comment })
  advance(deps, task.id, outcome)
}

/**
 * `review accept` / «Принять»: задача на этапе проверки — исход accept (дальше по графу, обычно мерж);
 * задача-проверка — её закрытие; задача-ответ и задача вне воркфлоу — прежняя приёмка (`acceptReview`).
 */
export function reviewAccept(deps: WorkflowDeps, taskId: string, decision?: string): void {
  const task = mustTask(deps, taskId)
  if (task.answerFor || !task.stage) {
    if (task.gateFor) closeGate(deps, task)
    else acceptReview(deps.store, deps.repoRoot, taskId, decision, deps.mergeTarget)
    return
  }
  decide(deps, task, 'accept', decision)
}

/**
 * `review reject` / «Вернуть»: задача на этапе проверки — исход reject с замечаниями (обычно обратно в работу,
 * воркер стартует сразу); остальные — прежний `rejectReview` (ready с замечаниями, у ответа — «Уточнить»).
 */
export function reviewReject(deps: WorkflowDeps, taskId: string, feedback: string): Task {
  const task = mustTask(deps, taskId)
  if (task.answerFor || task.gateFor || !task.stage) return deps.store.rejectReview(taskId, feedback)
  decide(deps, task, 'reject', feedback)
  return mustTask(deps, taskId)
}

/** Человек решил запрос approval (Инбокс, `request resolve`): переход по его исходу, если задача всё ещё на этой ноде. */
export function approvalResolved(deps: WorkflowDeps, request: HumanRequest): void {
  const action = request.resolution?.action
  if (request.kind !== 'approval' || (action !== 'accept' && action !== 'reject')) return
  const task = deps.store.getTask(request.taskId)
  if (!task?.stage || (request.nodeId !== undefined && task.stage.nodeId !== request.nodeId)) return
  advance(deps, task.id, action)
}
