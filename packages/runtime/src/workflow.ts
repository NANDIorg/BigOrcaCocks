import { existsSync } from 'node:fs'
import {
  gateTaskSpec, gateTaskTitle, isValidGitBranchName, renderGitTemplate, wfGitVars, wfNodeTitle, statusSource, withStatusSource,
  type StatusSource, type HumanRequest, type OrcaEvent, type Role, type RunWorkflowFallback, type Task, type TaskStore, type WfAction, type WfNode,
  type WfOutcome, type Workflow
} from '@orca-board/core'
import { showcaseMarkdown } from '@orca-board/contracts'
import type { MergeTargetOf, ReviewServices } from './review.ts'
import type { ExecutionResources } from './execution-resources.ts'
import type { WorkflowMessages } from './workflow-messages.ts'
import { executionProject, obsoleteEffect, type ExecutionContext } from './execution-context.ts'
import type { EffectScope } from './effect-scope.ts'
import { CommandError } from './project-commands.ts'

export interface WorkflowDeps extends ExecutionContext {
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
  startWorker(taskId: string, opts?: { roleId?: string }): { ptyId: string; dispatchId: string } | Promise<{ ptyId: string; dispatchId: string }>
  /**
   * Куда сливать ветку задачи на ноде `merge` и при приёмке вне графа (`mergeTarget` в `run-branch.ts`): ветка
   * глобальной задачи или текущая ветка корня. Нет — текущая ветка корня (тесты).
   */
  mergeTarget?: MergeTargetOf
}

export interface WorkerPreparationOptions {
  /** Явная роль этого запуска имеет приоритет над ролью ask и ролью задачи. */
  roleId?: string
  /** Синхронная проверка выбранной роли; callback не должен менять store или конфигурацию. */
  validateRole?: (roleId: string) => void
  /** Перед возвратом Promise host снимает guard подготовленной позиции без новых store writes. */
  onPrepared?: () => void
}

export type TaskEngine = 'legacy' | 'path' | 'run'
export interface TaskWorkflowServiceDeps {
  resources: ExecutionResources
  review: ReviewServices
  messages: WorkflowMessages
}

/** Граф legacy-задачи или пути подзадачи; host передаёт запуск и ресурсы. */
export function createTaskWorkflowServices({ resources, review, messages }: TaskWorkflowServiceDeps) {
  const { acceptReview, mergeTaskBranch } = review
  const { workflowGit, taskWorktreePath } = resources.git
  const capture = (deps: WorkflowDeps, taskId?: string, delegatedLaunch = false, source: StatusSource = 'workflow') => resources.effects.capture(executionProject(deps.store, deps.repoRoot, deps), taskId ? { taskId, ...(delegatedLaunch ? { taskResources: false as const } : {}) } : {}, { source })
  function commit<T>(deps: WorkflowDeps, operation: () => T, source: StatusSource = 'workflow'): T {
    const scope = capture(deps, undefined, false, source)
    try { return scope.commit(operation) } finally { scope.close() }
  }

  /** Сколько переходов подряд без ожидания (мерж → условие → мерж…) допускается, прежде чем считать граф зациклившимся. */
  const MAX_STEPS = 50

  /**
   * Исполнитель задачи: `legacy` — прежний воркфлоу по подзадачам (прогон старого формата, «Входящие»), `path` — путь
   * подзадачи этапа «Работа» (этот модуль), `run` — воркфлоу глобальной задачи (`workflow-run.ts`: проверки и вопросы
   * этапов, подзадачи вне этапа). `handleWorkflowEvents` берёт `legacy` и `path`, `handleRunWorkflowEvents` — `run`:
   * событие не обрабатывают оба и не пропускают оба.
   */

  function taskEngine(deps: Pick<WorkflowDeps, 'store' | 'run'>, task: Task): TaskEngine {
    const { store } = deps
    if (task.runId === undefined || store.getRun(task.runId)?.workflowScope !== 'run') return 'legacy'
    // Проверку ветки подзадачи создаёт только путь; проверка ветки прогона (`gateFor.runId`) — граф прогона.
    if (task.gateFor) return task.gateFor.taskId !== undefined ? 'path' : 'run'
    if (task.answerFor || !task.stageOf) return 'run'
    return stageOfNode(deps, task)?.type === 'work' ? 'path' : 'run'
  }

  /** Нода графа прогона, к которой привязана подзадача (`Task.stageOf`). */
  function stageOfNode(deps: Pick<WorkflowDeps, 'store' | 'run'>, task: Task): WfNode | undefined {
    return deps.store.runWorkflow(task.runId, fallback(deps, task)).nodes.find((n) => n.id === task.stageOf?.nodeId)
  }

  /** Запасной граф для store (`runWorkflow`): роли и граф типа прогона задачи. */
  function fallback(deps: Pick<WorkflowDeps, 'run'>, task: Task): RunWorkflowFallback {
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

  /** Граф, по которому ходит задача: путь ноды «Работа» у подзадачи прогона, иначе граф её прогона (`TaskStore.taskWorkflow`). */
  function graphOf(deps: WorkflowDeps, task: Task): Workflow {
    return deps.store.taskWorkflow(task, fallback(deps, task))
  }

  /** Нода, на которой стоит задача, в её графе. */
  function stageNode(deps: WorkflowDeps, task: Task): WfNode | undefined {
    if (!task.stage) return undefined
    return graphOf(deps, task).nodes.find((n) => n.id === task.stage!.nodeId)
  }

  function message(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
  }

  /** Перенести задачу в колонку, если она есть на доске и задача ещё не там. */
  function moveTo(deps: WorkflowDeps, taskId: string, status: string): void {
    const task = mustTask(deps, taskId)
    if (task.status !== status && deps.store.columnKind(status)) commit(deps, () => deps.store.moveTask(taskId, status))
  }

  /**
   * Перед запуском воркера рабочей задачи (`runWorker`): задача входит в граф или возвращается на этап
   * «Работа» (store.enterWork). Роль ноды «Работа», если задана, становится ролью задачи. Возвращает роль этапа
   * «Вопрос человеку» (если задача стоит на нём и роль задана): её `runWorker` передаёт в запуск, а на задачу
   * не переносит — иначе следующая «Работа» без своей роли запустилась бы ролью опросника.
   */
  async function enterWork(deps: WorkflowDeps, taskId: string, opts: WorkerPreparationOptions = {}): Promise<{ roleId?: string }> {
    let prepared = false
    const preparation = { ...opts, onPrepared: () => { prepared = true; opts.onPrepared?.() } }
    const task = mustTask(deps, taskId)
    const fb = fallback(deps, task)
    const preview = deps.store.previewEnterWork(taskId, fb)?.action
    // Проверяем запуск только там, где граф действительно ведёт к воркеру. Для Git override известен заранее.
    if (!preview || preview.type === 'start_worker' || (preview.type === 'git' && opts.roleId !== undefined)) {
      validateWorkerRole(deps, task, preview, opts)
    }
    let action = commit(deps, () => deps.store.enterWork(taskId, fb))
    // Первым этапом стоит нода «Git» (`start → git(create_branch) → work`): ветка и worktree готовятся до запуска
    // агента, а сам запуск остаётся за вызывающим (`runWorker`) — иначе воркер стартовал бы дважды.
    if (action && (action.type === 'git' || (opts.validateRole && action.type !== 'start_worker'))) {
      action = await prepareBeforeWork(deps, taskId, action, preparation)
    }
    const node = prepared && action ? graphOf(deps, task).nodes.find(n => n.id === action.nodeId) : stageNode(deps, mustTask(deps, taskId))
    if (!prepared && action?.type === 'start_worker' && node?.type !== 'ask' && action.roleId) applyWorkRole(deps, taskId, action.roleId)
    if (!prepared) preparation.onPrepared()
    if (node?.type === 'ask') return node.roleId ? { roleId: node.roleId } : {}
    return {}
  }

  function validateWorkerRole(deps: WorkflowDeps, task: Task, action: WfAction | undefined, opts: WorkerPreparationOptions): void {
    if (!opts.validateRole) return
    const ask = stageNode(deps, task)
    const stageRole = action?.type === 'start_worker' ? action.roleId : ask?.type === 'ask' ? ask.roleId : undefined
    opts.validateRole(opts.roleId ?? stageRole ?? task.roleId)
  }

  function validateNextWorker(deps: WorkflowDeps, taskId: string, outcome: WfOutcome, opts: WorkerPreparationOptions): void {
    if (!opts.validateRole) return
    const task = mustTask(deps, taskId)
    const next = deps.store.previewAdvanceStage(taskId, outcome, fallback(deps, task)).action
    if (next.type === 'start_worker') validateWorkerRole(deps, task, next, opts)
  }

  /**
   * Выполнить эффекты перед первой «Работой»/«Вопросом человеку» и вернуть действие запуска воркера.
   * Цепочка ушла в другое место (ошибка git → человек, конец графа) или упёрлась в настройку — воркера здесь нет:
   * бросаем понятную причину, задача остаётся на своём этапе (запрос человеку уже создан), а не запускаем агента мимо графа.
   */
  async function prepareBeforeWork(deps: WorkflowDeps, taskId: string, first: WfAction, opts: WorkerPreparationOptions): Promise<Extract<WfAction, { type: 'start_worker' }>> {
    const parked = await executeSteps(deps, taskId, first, true, opts)
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
    if (role && task.roleId !== role.id) commit(deps, () => deps.store.updateTask(taskId, { roleId: role.id, agent: role.agent }))
  }

  /** Исход текущего этапа задачи → переход по графу и эффекты новых этапов. */
  async function advance(deps: WorkflowDeps, taskId: string, outcome: WfOutcome): Promise<void> {
    const { action } = commit(deps, () => deps.store.advanceStage(taskId, outcome, fallback(deps, mustTask(deps, taskId))))
    await execute(deps, taskId, action)
  }

  /**
   * Выполнить действие этапа. Мерж ждать не нужно — после него переход идёт сразу (ok / conflict), остальные
   * действия ждут воркера, проверку или человека. Любая ошибка эффекта — `workflow_blocked`, задача остаётся на этапе.
   */
  async function execute(deps: WorkflowDeps, taskId: string, first: WfAction): Promise<void> {
    // Колонку дальше двигает граф, а не тот, чья команда дала исход: в истории статусов — workflow.
    await executeSteps(deps, taskId, first)
  }

  /**
   * `deferWorker` — не запускать воркера, а вернуть его действие (`enterWork`: воркера стартует вызывающий). Возвращает
   * отложенное действие; во всех остальных случаях — undefined.
   */
  async function executeSteps(deps: WorkflowDeps, taskId: string, first: WfAction, deferWorker = false, opts: WorkerPreparationOptions = {}): Promise<WfAction | undefined> {
    const { store } = deps
    let action = first
    let note: { title: string; text: string } | undefined
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const task = store.getTask(taskId)
      if (!task) return
      if (task.stage && task.stage.nodeId !== action.nodeId) throw new CommandError('command.stale', { taskId })
      const graph = graphOf(deps, task)
      const node = graph.nodes.find(n => n.id === action.nodeId)
      const scope = capture(deps, taskId)
      try {
        switch (action.type) {
          case 'start_worker': {
            if (deferWorker) {
              scope.commit(() => {
                if (node?.type !== 'ask' && action.type === 'start_worker' && action.roleId) applyWorkRole(deps, taskId, action.roleId)
                if (scope.signal.aborted) throw new CommandError('command.stale', { taskId })
                opts.onPrepared?.()
              })
              return action
            }
            scope.commit(() => {
              if (node?.type !== 'ask' && action.type === 'start_worker' && action.roleId) applyWorkRole(deps, taskId, action.roleId)
              if (store.columnKind(task.status) !== 'in_progress') moveTo(deps, taskId, store.columnId('ready'))
            })
            const launch = capture(deps, taskId, true)
            const launchOptions = node?.type === 'ask' && action.roleId ? { roleId: action.roleId } : undefined
            try {
              await withStatusSource('workflow', () => deps.startWorker(taskId, launchOptions))
            } catch (error) {
              if (obsoleteEffect(error)) throw error
              launch.guard()
              launch.commit(() => store.blockStage(taskId, `воркер не запустился: ${message(error)}. Запустить заново: orca-board worker start --task ${taskId}`))
            } finally { launch.close() }
            return
          }
          case 'create_gate': if (node?.type === 'gate') await createGate(deps, task, node); return
          case 'request_human': if (node?.type === 'human') scope.commit(() => requestHuman(deps, task, node, note)); return
          case 'merge': {
            let result: Awaited<ReturnType<typeof mergeTaskBranch>>
            try {
              const target = task.worktree && task.branch && deps.mergeTarget ? await scope.wait(() => Promise.resolve(deps.mergeTarget!(task))) : undefined
              result = await mergeTaskBranch(deps.repoRoot, task, target, scope)
            } catch (error) { scope.guard(); scope.commit(() => store.blockStage(taskId, `мерж не выполнен: ${message(error)}`)); return }
            action = scope.commit(() => {
              if (result.ok) {
                note = undefined
                if (task.worktree !== undefined || task.branch !== undefined) store.updateTask(taskId, { worktree: undefined, branch: undefined, branchForeign: undefined })
              } else note = { title: 'Мерж не удался', text: result.error }
              const outcome = result.ok ? 'ok' : 'conflict'
              if (deferWorker) validateNextWorker(deps, taskId, outcome, opts)
              return store.advanceStage(taskId, outcome, fallback(deps, task)).action
            })
            continue
          }
          case 'git': {
            if (node?.type !== 'git') { scope.commit(() => store.blockStage(taskId, `нода «${action.nodeId}» не найдена в воркфлоу или это не нода «Git»`)); return }
            const run = await runGitNode(deps, task, node, action, scope)
            if (run.kind === 'blocked') { scope.commit(() => store.blockStage(taskId, run.reason)); return }
            const next = scope.commit(() => {
              const outcome: WfOutcome = run.kind === 'ok' ? 'ok' : 'error'
              if (run.kind === 'ok' && run.patch) store.updateTask(task.id, run.patch)
              if (run.kind === 'error') {
                store.updateTask(taskId, { feedback: run.text })
                note = { title: `Git-операция «${action.type === 'git' ? action.operation : ''}» не удалась`, text: run.text }
                if (!graph.edges.some(e => e.from === node.id && e.outcome === 'error')) {
                  store.blockStage(taskId, `нода «${wfNodeTitle(node)}»: ${run.text}; у ноды нет перехода «error» — добавьте его в воркфлоу (например, к человеку)`)
                  return undefined
                }
              } else note = undefined
              if (deferWorker) validateNextWorker(deps, taskId, outcome, opts)
              return store.advanceStage(taskId, outcome, fallback(deps, task)).action
            })
            if (!next) return
            action = next; continue
          }
          case 'done': await finish(deps, task); return
          case 'blocked': return
        }
      } finally { scope.close() }
    }
    commit(deps, () => store.blockStage(taskId, `больше ${MAX_STEPS} переходов подряд без ожидания — проверьте граф воркфлоу на цикл через мерж или git`))
  }

  /** Итог git-ноды: `error` — git отказал (исход `error`), `blocked` — ошибка настройки (граф не двигается). */
  type GitRun = { kind: 'ok'; patch?: Pick<Task, 'worktree' | 'branch' | 'branchForeign'> } | { kind: 'error'; text: string } | { kind: 'blocked'; reason: string }

  /**
   * Нода `git`: выполнить операцию в worktree задачи и обновить `Task.worktree`/`Task.branch`, если ветка сменилась —
   * дальше `merge`, `review info`, гейты и `push` работают с актуальной веткой. Шаблоны подставляются здесь. Отказ git
   * или окружения — `error` с текстом `git <команда>: <причина>`; недопустимое имя ветки после подстановки — `blocked`
   * (это настройка, отказать git не мог: он не запускался). Подробности — docs/workflow.md → «Нода Git».
   */
  async function runGitNode(deps: WorkflowDeps, task: Task, node: Extract<WfNode, { type: 'git' }>, a: Extract<WfAction, { type: 'git' }>, scope: EffectScope): Promise<GitRun> {
    const { store, repoRoot } = deps
    const title = wfNodeTitle(node); const vars = wfGitVars(task)
    const branch = a.branch !== undefined ? renderGitTemplate(a.branch, vars).trim() : undefined
    const commitMessage = a.message !== undefined ? renderGitTemplate(a.message, vars).trim() : undefined
    if (branch !== undefined && !isValidGitBranchName(branch)) return { kind: 'blocked', reason: `нода «${title}»: имя ветки «${branch}» после подстановки недопустимо для git (правила git check-ref-format)` }
    if (a.operation === 'commit' && !commitMessage) return { kind: 'blocked', reason: `нода «${title}»: сообщение коммита после подстановки пустое` }
    const worktree = task.worktree ?? taskWorktreePath(repoRoot, task.id)
    try {
      return await scope.transaction(workflowGit, async repo => {
        if (branch !== undefined && !await repo.isBranchNameAcceptedByGit(branch)) return { kind: 'blocked', reason: `нода «${title}»: имя ветки «${branch}» после подстановки недопустимо для git (правила git check-ref-format)` }
        switch (a.operation) {
          case 'create_branch': {
            const runBranch = task.runId ? store.getRun(task.runId)?.git?.branch : undefined
            await repo.gitCreateBranch(worktree, branch!, a.base ?? (existsSync(worktree) ? undefined : runBranch), task.branch === branch)
            return { kind: 'ok', patch: { worktree, branch, branchForeign: undefined } }
          }
          case 'checkout': {
            await repo.gitCheckout(worktree, branch!)
            const own = branch === `orca/${task.id}` || (branch === task.branch && task.branchForeign !== true)
            return { kind: 'ok', patch: { worktree, branch, branchForeign: own ? undefined : true } }
          }
          case 'commit': await repo.gitCommit(worktree, commitMessage!); break
          case 'push':
            if (!task.branch) return { kind: 'error', text: 'у задачи нет ветки — нечего пушить (поставьте create_branch, checkout или «Работу» раньше)' }
            await repo.gitPush(existsSync(worktree) ? worktree : undefined, a.remote ?? 'origin', task.branch); break
        }
        return { kind: 'ok' }
      })
    } catch (error) { scope.guard(); return { kind: 'error', text: message(error) } }
  }

  /** Нода gate: задача-проверка на ветку рабочей задачи и сразу её воркер. Рабочая задача — в колонку этапа (по умолчанию «Ревью»). */
  async function createGate(deps: WorkflowDeps, task: Task, node: Extract<WfNode, { type: 'gate' }>): Promise<void> {
    const { store } = deps
    const role = rolesOf(deps, task).find((r) => r.id === node.roleId)
    if (!role) {
      commit(deps, () => store.blockStage(task.id, `нода «${wfNodeTitle(node)}»: нет роли «${node.roleId}» в типе задачи`))
      return
    }
    moveTo(deps, task.id, node.column ?? store.columnId('review'))
    const gate = commit(deps, () => store.createTask({
      title: gateTaskTitle(task, node),
      spec: gateTaskSpec(task, node),
      roleId: role.id,
      agent: role.agent,
      runId: task.runId,
      gateFor: { taskId: task.id, nodeId: node.id }
    }))
    const launch = capture(deps, task.id)
    try {
      await withStatusSource('workflow', () => deps.startWorker(gate.id))
    } catch (e) {
      if (obsoleteEffect(e)) throw e
      launch.guard()
      launch.commit(() => store.blockStage(task.id, `проверка ${gate.id} «${gate.title}» не запустилась: ${message(e)}. Запустить заново: orca-board worker start --task ${gate.id}`))
    } finally { launch.close() }
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
    commit(deps, () => store.requestApproval(task.id, {
      nodeId: node.id, title: `${wfNodeTitle(node)}: ${task.title}`, body,
      ...(showcase && dispatch ? { showcaseDispatchId: dispatch.id } : {})
    }))
    if (node.column) moveTo(deps, task.id, node.column)
  }

  /**
   * Нода end: задача в done. Ветка уже слита (мерж её удалил) — обычная приёмка. Не слита (конец без мержа) —
   * хвосты коммитятся, worktree убирается, а ветка остаётся: работа не попала в основную ветку, но и не потеряна.
   */
  async function finish(deps: WorkflowDeps, task: Task): Promise<void> {
    const scope = capture(deps, task.id)
    try {
      if (!task.branch) { scope.commit(() => deps.store.acceptTask(task.id)); return }
      try {
        if (task.worktree) await scope.transaction(workflowGit, async repo => {
          await repo.commitWorktree(task.worktree!, `orca: ${task.title}`)
          await repo.removeWorktreeKeepBranch(task.worktree!)
        })
      } catch (error) { scope.guard(); scope.commit(() => deps.store.blockStage(task.id, `конец без мержа: не удалось убрать worktree — ${message(error)}`)); return }
      scope.commit(() => deps.store.updateTask(task.id, { status: deps.store.columnId('done'), worktree: undefined }))
    } finally { scope.close() }
  }

  async function closeGate(deps: WorkflowDeps, gate: Task): Promise<void> {
    const scope = capture(deps, gate.id, false, deps.source ?? 'workflow')
    try {
      if (gate.worktree && gate.branch) {
        try { await scope.transaction(workflowGit, repo => repo.removeWorktree(gate.worktree!, gate.branch!)) }
        catch { scope.guard() }
      }
      scope.commit(() => deps.store.acceptTask(gate.id))
    } finally { scope.close() }
  }

  /**
   * Проверка ещё должна вынести решение: рабочая задача стоит на её ноде, и это последняя проверка этой ноды
   * (после reject → работа → снова проверка старая уже не в счёт).
   */
  function gatePending(deps: WorkflowDeps, gate: Task): boolean {
    const { store } = deps
    // Проверка ветки глобальной задачи (`gateFor.runId`) — воркфлоу прогона, этот движок её не ведёт.
    const target = gate.gateFor?.taskId !== undefined ? store.getTask(gate.gateFor.taskId) : undefined
    if (!target || !gate.gateFor || target.stage?.nodeId !== gate.gateFor.nodeId || store.columnKind(target.status) === 'done') return false
    const latest = store.listTasks().filter((t) => t.gateFor?.taskId === target.id && t.gateFor.nodeId === gate.gateFor!.nodeId).at(-1)
    return latest?.id === gate.id
  }

  /**
   * Проверка сдала `done` или её воркер вышел. Решение уже есть — проверка закрывается. Нет решения после `done` —
   * `workflow_blocked` у рабочей задачи, проверка остаётся на ревью (её можно перезапустить). Воркер вышел без
   * `done` и без решения — ничего: эскалацию («Перезапустить» / «Скрыть») уже завёл store.
   */
  async function settleGate(deps: WorkflowDeps, gate: Task, why: 'done' | 'exit'): Promise<void> {
    if (!gatePending(deps, gate)) {
      await closeGate(deps, gate)
      return
    }
    if (why === 'done') {
      const target = gate.gateFor!.taskId!
      commit(deps, () => deps.store.blockStage(
        target,
        `проверка ${gate.id} сдана без решения (нет review accept/reject по задаче ${target}). ` +
          `Перезапустить проверку: orca-board task reopen --task ${gate.id} --start; или решите в приложении: «Принять» / «Вернуть» у задачи ${target}`
      ))
    }
  }

  /** Рабочая задача сдала `done`: этап «Работа» или «Вопрос человеку» → переход по `next`. */
  async function workDone(deps: WorkflowDeps, task: Task, dispatchId: string | undefined): Promise<void> {
    // Сданный прошлый запуск (задачу уже перезапустили) переход не делает.
    if (dispatchId !== undefined && task.dispatchId !== dispatchId) return
    if (!task.stage) commit(deps, () => deps.store.enterWork(task.id, fallback(deps, task)))
    const current = mustTask(deps, task.id)
    const node = stageNode(deps, current)
    if (node?.type !== 'work' && node?.type !== 'ask') {
      commit(deps, () => deps.store.blockStage(task.id, `воркер сдал работу, а задача на этапе «${node ? wfNodeTitle(node) : current.stage?.nodeId ?? '—'}», не на «Работе»`))
      return
    }
    await advance(deps, task.id, 'next')
  }

  /**
   * События store → шаги воркфлоу (подписка `projects.onEvents` в index.ts, как `deliverAnswers`):
   * `worker_done` рабочей задачи — переход дальше, проверки — закрытие; `escalation` проверки — закрытие,
   * если решение уже есть; `question_answered` на этапе «Вопрос человеку» без живого воркера — автоперезапуск
   * (координатор в этом этапе не участвует). Задачи-ответы идут мимо воркфлоу. Ошибки не выбрасываются из подписки —
   * они становятся `workflow_blocked`.
   */
  async function handleWorkflowEvents(deps: WorkflowDeps, events: readonly OrcaEvent[]): Promise<void> {
    await handleEvents(deps, events)
  }

  async function handleEvents(deps: WorkflowDeps, events: readonly OrcaEvent[]): Promise<void> {
    for (const e of events) {
      if (!e.taskId || (e.type !== 'worker_done' && e.type !== 'escalation' && e.type !== 'question_answered')) continue
      const task = deps.store.getTask(e.taskId)
      if (!task || task.answerFor) continue
      // Граф прогона (проверки и вопросы этапов, подзадачи вне этапа) ведёт `workflow-run.ts`; путь подзадачи — этот модуль.
      if (taskEngine(deps, task) === 'run') continue
      // Запоздалые done/exit прошлого запуска не меняют новый dispatch, в том числе gate.
      if (e.type !== 'question_answered' && e.dispatchId !== undefined && task.dispatchId !== e.dispatchId) continue
      try {
        if (e.type === 'question_answered') {
          await restartAsk(deps, task, e.payload.workerLive === true)
        } else if (e.type === 'worker_done') {
          if (task.gateFor) await settleGate(deps, task, 'done')
          else await workDone(deps, task, e.dispatchId)
        } else if (task.gateFor && e.payload.stuck !== true) {
          await settleGate(deps, task, 'exit')
        }
      } catch (err) {
        if (obsoleteEffect(err)) continue
        const target = task.gateFor?.taskId ?? task.id
        if (deps.store.getTask(target)) commit(deps, () => deps.store.blockStage(target, `ошибка исполнителя воркфлоу: ${message(err)}`))
      }
    }
  }

  /**
   * Человек ответил на вопрос с этапа «Вопрос человеку», а агента уже нет (упал, перезапуск приложения): воркер
   * стартует сам, ответ попадает в его промпт, этап не сбрасывается. Живой воркер получает ответ через свой `ask`.
   * Ошибка запуска — `workflow_blocked` (перехватывает вызывающий `handleEvents`).
   */
  async function restartAsk(deps: WorkflowDeps, task: Task, workerLive: boolean): Promise<void> {
    if (workerLive || task.gateFor) return
    const node = stageNode(deps, task)
    if (node?.type !== 'ask') return
    // Задача не в ready (ушла в другую колонку, есть другой запрос) — запускать нечего.
    if (deps.store.columnKind(task.status) !== 'ready') return
    const launch = capture(deps, task.id, true)
    try {
      await withStatusSource('workflow', () => deps.startWorker(task.id, node.roleId ? { roleId: node.roleId } : undefined))
    } catch (e) {
      if (obsoleteEffect(e)) throw e
      launch.guard()
      launch.commit(() => deps.store.blockStage(task.id, `воркер не запустился после ответа: ${message(e)}. Запустить заново: orca-board worker start --task ${task.id}`))
    } finally { launch.close() }
  }

  /** Ноды-эффекты: на них не ждут ни воркера, ни проверки, ни человека — задача стоит тут, только если эффект не дошёл до конца. */
  function isEffectNode(node: WfNode | undefined): boolean {
    return node?.type === 'merge' || node?.type === 'git' || node?.type === 'end'
  }

  /** Название этапа задачи для текста ошибки: нода графа или её id. */
  function stageTitle(node: WfNode | undefined, task: Task): string {
    return node ? wfNodeTitle(node) : task.stage?.nodeId ?? '—'
  }

  /**
   * `worker_done` потерян: последний запуск сдан (`done`), живого воркера нет, задача в «Ревью», а этап всё ещё «Работа»
   * или «Вопрос человеку» — приложение вышло между сохранённым `done` и его обработкой (`runWorkflowEvents` — в `setImmediate`).
   */
  function lostWorkerDone(deps: WorkflowDeps, task: Task): boolean {
    const { store } = deps
    const last = task.dispatchId !== undefined ? store.getDispatch(task.dispatchId) : undefined
    return last?.outcome === 'done' && store.columnKind(task.status) === 'review' && !store.activeDispatches().some((d) => d.taskId === task.id)
  }

  /** Снять прошлую остановку перед повтором: новая остановка (если будет) — уже про этот повтор. */
  function clearStageBlock(deps: WorkflowDeps, taskId: string): void {
    if (mustTask(deps, taskId).stageBlock) commit(deps, () => deps.store.updateTask(taskId, { stageBlock: undefined }))
  }

  /**
   * Повторить эффект ноды, на которой стоит задача (`stageActionOf`): мерж, git-операцию, конец. Возвращает false, если у
   * задачи нет своего этапа. Ошибка эффекта — снова `workflow_blocked` и `stageBlock` (их ставит `executeSteps`).
   */
  async function repeatStage(deps: WorkflowDeps, taskId: string): Promise<boolean> {
    const action = deps.store.stageActionOf(taskId, fallback(deps, mustTask(deps, taskId)))
    if (!action) return false
    clearStageBlock(deps, taskId)
    await execute(deps, taskId, action)
    return true
  }

  /**
   * «Вернуть» со стоящего этапа (эффект не прошёл, потерян `worker_done`): замечания — в feedback, задача — на первую «Работу»
   * (`store.enterWork`, заходы копятся — лимит повторов их считает) и сразу воркер.
   */
  async function returnToWork(deps: WorkflowDeps, task: Task, text?: string, images?: string[]): Promise<void> {
    const comment = text?.trim() || undefined
    if (comment) commit(deps, () => deps.store.updateTask(task.id, { feedback: comment, feedbackImages: images?.length ? images : undefined }))
    clearStageBlock(deps, task.id)
    const fb = fallback(deps, task)
    // Уже на «Работе» (потерян `worker_done`) enterWork этап не меняет — запускаем действие текущей ноды.
    const action = commit(deps, () => deps.store.enterWork(task.id, fb), deps.source ?? statusSource()) ?? deps.store.stageActionOf(task.id, fb)
    if (action) await execute(deps, task.id, action)
  }

  /**
   * Решение по этапу задачи — `review accept/reject`, кнопки ревью в UI (docs/workflow.md → «Принять и Вернуть по этапам»):
   * - `gate`, `human` — исход проверки; на ноде human это решение её запроса approval. Замечания при reject — в feedback
   *   для следующего запуска, `images` — пути картинок к ним (в worktree задачи, их сохранил main);
   * - `merge`, `git`, `end` (эффект упал или прерван рестартом) — «Принять» повторяет эффект, «Вернуть» — в работу с замечаниями;
   * - «Работа»/«Вопрос человеку» с потерянным `worker_done` — «Принять» делает переход, как сделал бы `done`, «Вернуть» — перезапуск;
   * - иначе (воркер ещё работает) — `review.notReviewable`.
   * Без этой таблицы задача на «Мерже» была тупиком: кнопки показаны (колонка «Ревью»), а решение отвергалось.
   */
  async function decide(deps: WorkflowDeps, task: Task, outcome: 'accept' | 'reject', text?: string, images?: string[]): Promise<void> {
    const source = deps.source ?? statusSource()
    const node = stageNode(deps, task)
    const comment = text?.trim() || undefined
    const attached = outcome === 'reject' && comment && images?.length ? images : undefined
    if (node?.type === 'gate' || node?.type === 'human') {
      const request = deps.store.pendingRequests().find((r) => r.taskId === task.id && r.kind === 'approval')
      if (request) commit(deps, () => deps.store.resolveRequest(request.id, { action: outcome, ...(comment ? { text: comment } : {}), ...(attached ? { images: attached } : {}) }), source)
      else if (outcome === 'reject' && comment) commit(deps, () => deps.store.updateTask(task.id, { feedback: comment, feedbackImages: attached }), source)
      await advance(deps, task.id, outcome)
      return
    }
    const stalled = isEffectNode(node) || ((node?.type === 'work' || node?.type === 'ask') && lostWorkerDone(deps, task))
    if (!stalled) throw messages.error('review.notReviewable', { id: task.id, node: stageTitle(node, task) })
    if (outcome === 'reject') {
      await returnToWork(deps, task, comment, attached)
      return
    }
    if (isEffectNode(node)) {
      await repeatStage(deps, task.id)
      // Повтор снова встал — человеку причина сразу, а не молча та же карточка.
      const after = mustTask(deps, task.id)
      if (after.stageBlock) {
        throw messages.error('review.stageBlocked', { id: task.id, node: stageTitle(stageNode(deps, after), after), reason: after.stageBlock.reason })
      }
      return
    }
    await workDone(deps, task, undefined)
  }

  /**
   * Добор после запуска приложения (вызов — при открытии проекта, `index.ts`): подзадачи, чей эффект прервал выход или краш,
   * доводятся до ожидания. Трогаются только задачи этого движка (`legacy`/`path`), не в done, без живого воркера и **без
   * `stageBlock`** — остановленные ждут человека («Принять»/«Вернуть»), иначе каждый запуск заново слал бы `workflow_blocked`.
   * - `merge`/`git`/`end` — эффект повторяется;
   * - «Работа»/«Вопрос человеку» с потерянным `worker_done` — переход дальше;
   * - `gate` без незакрытой задачи-проверки — проверка создаётся; `human` без ждущего approval — запрос создаётся.
   * Идемпотентен: повторный вызов ничего не меняет. Ошибка одной задачи — её `workflow_blocked`, остальные идут дальше.
   */
  async function resumeStuckStages(deps: WorkflowDeps): Promise<void> {
    const { store } = deps
    for (const task of store.listTasks()) {
      if (!task.stage || task.stageBlock || task.answerFor || task.gateFor || store.columnKind(task.status) === 'done') continue
      if (taskEngine(deps, task) === 'run') continue
      if (store.activeDispatches().some((d) => d.taskId === task.id)) continue
      const node = stageNode(deps, task)
      {
        try {
          if (isEffectNode(node)) await repeatStage(deps, task.id)
          else if ((node?.type === 'work' || node?.type === 'ask') && lostWorkerDone(deps, task)) await workDone(deps, task, undefined)
          else if (node?.type === 'gate' && !openGate(deps, task, node.id)) await createGate(deps, task, node)
          else if (node?.type === 'human' && !store.pendingRequests().some((r) => r.taskId === task.id && r.kind === 'approval')) requestHuman(deps, task, node)
        } catch (e) {
          if (obsoleteEffect(e)) continue
          if (store.getTask(task.id)) commit(deps, () => store.blockStage(task.id, `ошибка исполнителя воркфлоу при доборе после запуска: ${message(e)}`))
        }
      }
    }
  }

  /** Незакрытая задача-проверка ноды `nodeId` у задачи: она и вынесет решение, вторую не создаём. */
  function openGate(deps: WorkflowDeps, task: Task, nodeId: string): boolean {
    const { store } = deps
    return store.listTasks().some((t) => t.gateFor?.taskId === task.id && t.gateFor.nodeId === nodeId && store.columnKind(t.status) !== 'done')
  }

  /**
   * Проверка ветки глобальной задачи (`gateFor.runId`) — не этого движка: её решение двигает граф прогона и делает эффекты
   * следующей ноды (`runGateDecision` в `workflow-run.ts`; вход — `reviewDecision` в index.ts). Тихо закрыть её прежней
   * приёмкой — потерять решение, поэтому вызов сюда — ошибка вызывающего.
   */
  function assertNotRunGate(task: Task): void {
    if (task.gateFor?.runId !== undefined) throw new Error(`задача ${task.id} — проверка ветки глобальной задачи: решение по ней принимает движок прогона (workflow-run.ts)`)
  }

  /**
   * `review accept` / «Принять»: задача на этапе проверки — исход accept (дальше по графу, обычно мерж); на остановленном
   * этапе — повтор эффекта (`decide`); задача-проверка — её закрытие; задача-ответ и задача вне воркфлоу — прежняя приёмка (`acceptReview`).
   */
  async function reviewAccept(deps: WorkflowDeps, taskId: string, decision?: string): Promise<void> {
    const task = mustTask(deps, taskId)
    assertNotRunGate(task)
    if (task.answerFor || !task.stage) {
      if (task.gateFor) await closeGate(deps, task)
      else await acceptReview(deps.store, deps.repoRoot, taskId, decision, deps.mergeTarget, deps)
      return
    }
    await decide(deps, task, 'accept', decision)
  }

  /**
   * `review reject` / «Вернуть»: задача на этапе проверки — исход reject с замечаниями (обычно обратно в работу,
   * воркер стартует сразу); на остановленном этапе — в работу с замечаниями (`decide`); остальные — прежний `rejectReview` (ready с замечаниями, у ответа — «Уточнить»).
   */
  async function reviewReject(deps: WorkflowDeps, taskId: string, feedback: string, images?: string[]): Promise<Task> {
    const task = mustTask(deps, taskId)
    assertNotRunGate(task)
    if (task.answerFor || task.gateFor || !task.stage) return commit(deps, () => deps.store.rejectReview(taskId, feedback, images), deps.source ?? statusSource())
    await decide(deps, task, 'reject', feedback, images)
    return mustTask(deps, taskId)
  }

  /** Человек решил запрос approval (Инбокс, `request resolve`): переход по его исходу, если задача всё ещё на этой ноде. */
  async function approvalResolved(deps: WorkflowDeps, request: HumanRequest): Promise<void> {
    const action = request.resolution?.action
    if (request.kind !== 'approval' || (action !== 'accept' && action !== 'reject')) return
    const task = request.taskId !== undefined ? deps.store.getTask(request.taskId) : undefined
    if (!task?.stage || (request.nodeId !== undefined && task.stage.nodeId !== request.nodeId)) return
    await advance(deps, task.id, action)
  }

  return { taskEngine, enterWork, advance, handleWorkflowEvents, resumeStuckStages, reviewAccept, reviewReject, approvalResolved }
}

export type TaskWorkflowServices = ReturnType<typeof createTaskWorkflowServices>
