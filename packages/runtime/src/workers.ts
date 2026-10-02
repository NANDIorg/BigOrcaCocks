import { randomUUID } from 'node:crypto'
import { delimiter } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { newId, getAgent, agentSystemPrompt, coordinatorPrompt, workerTaskPrompt,
  type AgentSpec, type AgentLanguage, type BuiltinPrompts, type AssistantSettings, type TaskStore,
  type Role, type Attachment, type RunTypeInput, type Workflow } from '@orca-board/core'
import { assistantEnv, assistantCwd, missingRoleText } from './launch-policy.ts'
import type { ExecutionResources } from './execution-resources.ts'
import type { ExecutionMessages } from './execution-messages.ts'
import type { createSessionRegistry, PtyCommand } from './sessions.ts'
import type { createAgentLauncher, LaunchOptions } from './agent-launch.ts'
import type { PermissionMode } from '@orca-board/contracts'

export interface WorkerEnvContext {
  socketPath: string
  projectId: string
  /** Режим разрешений типа задачи прогона (`resolveRunType`). */
  permissionMode: PermissionMode
  /** Роли типа задачи прогона: из них берутся агент и модель для задачи и координатора. */
  roles: Role[]
  /** Название типа задачи прогона — для ошибки «роли нет в типе задачи» (`missingRoleMessage`). */
  typeTitle: string
  /** Правила агентов типа задачи прогона: блок «Правила проекта» в системном промпте воркеров и координатора. */
  agentRules?: string
  /**
   * Граф типа прогона, который исполнитель может выполнить (`runnableWorkflow`): запасной для прогона без снимка
   * графа — по нему ищется этап «Работа» для промпта воркера. Нет — дефолтный по ролям.
   */
  workflow?: Workflow
  /** Тип нового прогона координатора: id, снимок и граф уходят в `Run.typeId`, `Run.taskType`, `Run.workflow`. */
  type?: RunTypeInput
  /**
   * Корень хранилища картинок глобальных задач (`runImagesRoot`). Нет — сохранённые картинки задачи координатору
   * не передаются (тесты, окружение без userData).
   */
  runImagesRoot?: string
}

export interface AssistantContext {
  socketPath: string
  settings: AssistantSettings
}

/** Все пути и настройки интерфейса передаёт host; runtime не обращается к Electron. */
export interface WorkerHostContext {
  dataDir: string
  cliBinDir: string
  nodePath?: string
  prompts: BuiltinPrompts
  language(): AgentLanguage
  shell(): string
  extraPathDirs(): string[]
  launchOptions(): LaunchOptions
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

export interface WorkerServiceDeps {
  host: WorkerHostContext
  resources: ExecutionResources
  messages: ExecutionMessages
  sessions: Pick<ReturnType<typeof createSessionRegistry>, 'spawnPty' | 'isAlive' | 'killPty'>
  launcher: Pick<ReturnType<typeof createAgentLauncher>, 'launchAgent'>
}

/** Воркеры, координатор и терминальный ассистент одного owner. */
export function createWorkerServices({ host, resources, messages, sessions, launcher }: WorkerServiceDeps) {
  const platform = host.platform ?? process.platform
  const { spawnPty, isAlive, killPty } = sessions
  const { launchAgent } = launcher
  const { addTaskWorktree, assertHasCommits, projectBranchInfo, setupCommand, taskWorktreePath } = resources.git
  const { roleLaunchExtraArgs, assistantLaunch, resumeObjective, returnGlobalTaskToWork,
    ensureRunBranch, coordinatorImages, attachmentsRoot, clearStartImages, pruneAttachments, writeAttachments } = resources

  /** Windows env — обычный объект; Path и PATH означают одну переменную. */
  function workerPath(): string {
    const env = host.env ?? process.env
    const key = platform === 'win32' ? Object.keys(env).find(key => key.toUpperCase() === 'PATH') : 'PATH'
    const path = key === undefined ? '' : env[key] ?? ''
    const sep = platform === 'win32' ? ';' : delimiter
    return [host.cliBinDir, ...path.split(sep).filter(Boolean), ...host.extraPathDirs()].join(sep)
  }

  function shellQuote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`
  }

  /**
   * Подготовка worktree на Windows — отдельным шагом перед агентом (spawnPty `before`), чтобы не
   * склеивать её с агентом в одну cmd-строку. Команда короткая (setupCommand), без пользовательского текста.
   * Агент стартует после неё с любым кодом выхода — как `;` на unix.
   */
  function win32Setup(setup: string): PtyCommand {
    return { command: 'cmd.exe', args: `/d /s /c "echo [orca] ${setup} & ${setup}"` }
  }

  function baseEnv(ctx: WorkerEnvContext): Record<string, string> {
    return {
      // В собранном приложении внешнего Node может не быть — обёртка orca-board использует Node из Electron.
      ...(host.nodePath ? { ORCA_NODE: host.nodePath } : {}),
      ORCA_SOCKET: ctx.socketPath,
      ORCA_PROJECT: ctx.projectId,
      PATH: workerPath()
    }
  }

  /**
   * Id сессии агента для статистики (docs/architecture.md → «Статистика»): uuid задаётся агенту при запуске, и
   * main находит его транскрипт без догадок. Агент, которому id не задать, — `undefined` (codex ищется по cwd).
   */
  function agentSessionId(spec: AgentSpec): string | undefined {
    return spec.acceptsSessionId ? randomUUID() : undefined
  }

  /**
   * Старт воркера: git worktree на ветке задачи → подготовка → PTY с агентом → dispatch.
   * Worktree создаётся рядом с репозиторием: <repo>/../.orca-worktrees/<taskId>. Ветка `orca/<taskId>` ответвляется
   * от ветки глобальной задачи (`ensureRunBranch`), а без неё — от текущего HEAD корня, как раньше.
   */
  function startWorker(
    store: TaskStore,
    repoRoot: string,
    ctx: WorkerEnvContext,
    taskId: string,
    cols = 120,
    rows = 30,
    roleId?: string
  ): { ptyId: string; dispatchId: string; worktree: string; branch: string } {
    const task = store.getTask(taskId)
    if (!task) {
      // Карточка глобальной задачи — не подзадача: на ней работает координатор, а не воркер.
      if (store.getRun(taskId)) throw new Error(`${taskId} — глобальная задача, воркер на ней не запускается (координатор: global start)`)
      throw new Error(`task not found: ${taskId}`)
    }
    if (store.columnKind(task.status) === 'in_progress') throw new Error(`task already in progress: ${taskId}`)
    // Роль этапа «Вопрос человеку» — только на этот запуск: задача сохраняет свою роль (`store.updateTask` ниже).
    const runRoleId = roleId ?? task.roleId
    const role = ctx.roles.find((r) => r.id === runRoleId)
    if (!role) throw messages.error('worker.cannotStart', { reason: missingRoleText(runRoleId, { title: ctx.typeTitle, roles: ctx.roles }) })
    const spec = getAgent(role.agent)
    if (!spec) throw new Error(`неизвестный агент: ${role.agent}`)
    // Флаги запуска роли разбираются до worktree и dispatch: с негодной строкой задача не должна уйти «в работу».
    const extraArgs = roleLaunchExtraArgs(role, 'worker.cannotStart')

    // Ветку и worktree могла уже назначить нода воркфлоу «Git» (`create_branch`/`checkout`): работаем на них, а не
    // заводим `orca/<id>`. Нет worktree на диске (конец без мержа, удалили руками) — ставим на ту же ветку.
    const branch = task.branch ?? `orca/${task.id}`
    const worktree = task.worktree ?? taskWorktreePath(repoRoot, task.id)
    const runGit = ensureRunBranch(store, repoRoot, task.runId)
    let fresh = false
    if (!existsSync(worktree)) {
      addTaskWorktree(repoRoot, worktree, branch, runGit?.branch)
      fresh = true
    }
    // Агент задачи синхронизируется с ролью: роль могли перенастроить после создания задачи. Роль этапа «Вопрос
    // человеку» задачу не меняет (агент задачи остаётся прежним).
    store.updateTask(task.id, { ...(roleId ? {} : { agent: role.agent }), worktree, branch })

    const dispatchId = newId('disp')
    // Уточнение к задаче-ответу идёт вместе с прошлым ответом: воркер отвечает заново, а не с нуля.
    const snap = store.snapshot()
    const previousAnswer = snap.dispatches.filter((d) => d.taskId === task.id && d.answer).at(-1)?.answer
    // Ответы на вопросы прошлых запусков: перезапуск после ответа человека не должен спрашивать заново.
    const answers = snap.questions.filter((q) => q.taskId === task.id && q.answeredAt).sort((a, b) => a.createdAt - b.createdAt)
    // Этап «Работа» графа: его инструкция и требование показа человеку — раздел «Этап» в задании.
    const stage = task.answerFor
      ? undefined
      : store.taskWorkStage(task.id, { roleIds: ctx.roles.map((r) => r.id), ...(ctx.workflow ? { workflow: ctx.workflow } : {}) })
    const sessionId = agentSessionId(spec)
    const inv = spec.invoke(agentSystemPrompt(host.prompts.worker, { projectRules: ctx.agentRules, role, language: host.language() }), workerTaskPrompt(task, previousAnswer, answers, stage), { permissionMode: ctx.permissionMode, shell: host.shell(), model: role.model, effort: role.effort, sessionId, extraArgs })

    // Свежий worktree без node_modules — ставим зависимости в том же PTY, потом exec агента.
    // Worktree, который создала нода «Git» до первого запуска, тоже «свежий»: зависимостей в нём ещё нет.
    const setup = fresh || !snap.dispatches.some((d) => d.taskId === task.id) ? setupCommand(worktree) : null
    const ptyId = launchAgent(inv, worktree, (launch, onExit) => {
      const unixSetup = platform !== 'win32' && setup && Array.isArray(launch.args)
        ? {
            command: host.shell(),
            args: ['-c', `echo "[orca] ${setup}"; ${setup}; exec ${[launch.command, ...launch.args].map(shellQuote).join(' ')}`]
          }
        : undefined
      return spawnPty(
        {
          meta: { role: 'worker', label: task.title, taskId: task.id, projectId: ctx.projectId },
          cwd: worktree,
          command: unixSetup?.command ?? launch.command,
          args: unixSetup?.args ?? launch.args,
          ...(platform === 'win32' && setup ? { before: win32Setup(setup) } : {}),
          cols,
          rows,
          env: { ...baseEnv(ctx), ...launch.env, ORCA_TASK_ID: task.id, ORCA_DISPATCH_ID: dispatchId }
        },
        onExit
      )
    }, (id, code) => store.ptyExited(id, code), host.launchOptions())
    store.startDispatch(task.id, ptyId, dispatchId, { roleId: role.id, agent: role.agent, model: role.model, sessionId })
    return { ptyId, dispatchId, worktree, branch }
  }

  /**
   * Координатор: агент роли coordinator (нет такой роли — claude без модели) с инструкцией и целью — в worktree ветки
   * глобальной задачи (`ensureRunBranch`), а без неё — в корне репозитория.
   * Без `runId` запуск создаёт новый прогон = глобальную задачу; с `runId` — повторный запуск на существующей
   * (цель — её описание и список подзадач, см. `resumeObjective`). Id прогона уходит координатору в ORCA_RUN_ID.
   * `images` — вложения любого типа (уже проверенные `validateAttachments`): сохраняются файлами на время прогона,
   * в промпт уходят только их пути — содержимое через терминал не передаётся.
   */
  /**
   * PTY координатора закрылся: его открытые вопросы больше некому разбирать — они уходят человеку
   * (запросы к человеку). Прогон могли удалить, пока терминал жил, — тогда нечего эскалировать.
   */
  function escalateAfterCoordinator(store: TaskStore, runId: string): void {
    if (!store.getRun(runId)) return
    store.escalateOpenQuestions(runId)
    // Вышел после run_done без `runs finish` — прогон закрывается, карточка на «Проверку».
    store.settleIdleRuns(isAlive)
  }

  function startCoordinator(
    store: TaskStore,
    repoRoot: string,
    ctx: WorkerEnvContext,
    objective: string,
    cols = 120,
    rows = 30,
    images: Attachment[] = [],
    runId?: string
  ): { ptyId: string; runId: string } {
    // Роль coordinator можно удалить из типа задачи («Настройки» → «Типы задач»); молча запускать claude вместо неё нельзя — человек её убрал.
    const role = ctx.roles.find((r) => r.id === 'coordinator')
    if (!role) throw messages.error('coordinator.cannotStart', { reason: missingRoleText('coordinator', { title: ctx.typeTitle, roles: ctx.roles }) })
    const spec = getAgent(role.agent)
    if (!spec) throw new Error(`неизвестный агент: ${role.agent}`)
    // Флаги запуска роли — до `createRun`: с негодной строкой карточка создалась бы и тут же закрылась пустой.
    const extraArgs = roleLaunchExtraArgs(role, 'coordinator.cannotStart')
    const resume = runId !== undefined ? resumeObjective(store, runId, isAlive) : undefined
    if (resume) objective = resume.objective
    // Вложения, сохранённые у задачи, идут координатору при каждом запуске (первом, повторном и «Вернуть в работу»):
    // сохранённые первыми, потом приложенные при запуске. Сумма — в тех же лимитах: превышение — ошибка до старта
    // агента (молча отбрасывать чьи-то файлы нельзя). Пришедшие в `images` в задаче не сохраняются.
    if (resume && ctx.runImagesRoot) {
      const merged = coordinatorImages(ctx.runImagesRoot, ctx.projectId, resume.run, images)
      if (merged.missing.length > 0) resources.logger.warn(`[orca] у задачи ${runId} нет на диске сохранённых вложений: ${merged.missing.map((m) => m.id).join(', ')}`)
      images = merged.images
    }
    // Репозиторий без коммитов — отказ до `createRun`: иначе карточка создалась бы и тут же закрылась пустой.
    if (!resume && projectBranchInfo(repoRoot).isGitRepo) assertHasCommits(repoRoot)
    const run = resume?.run ?? store.createRun(objective, undefined, ctx.type)
    let ptyId: string
    let root: string | undefined
    const sessionId = agentSessionId(spec)
    try {
      // Ветка фичи заводится до координатора: он декомпозирует по коду этой ветки, воркеры ответвятся от неё.
      const cwd = ensureRunBranch(store, repoRoot, run.id)?.worktree ?? repoRoot
      root = images.length > 0 ? attachmentsRoot(cwd) : undefined
      if (root) pruneAttachments(store, root, isAlive)
      // Вложения прошлого запуска этой глобальной задачи: координатор не жив (проверено), файлы не нужны. Возвраты
      // в работу (`returns/`) остаются: на них ссылаются `Run.stageInput.images` и `Run.returns`.
      if (root && resume) clearStartImages(root, run.id)
      const paths = root ? writeAttachments(root, run.id, images) : []
      const inv = spec.invoke(agentSystemPrompt(host.prompts.coordinator, { projectRules: ctx.agentRules, role, language: host.language() }), coordinatorPrompt(objective, paths), {
        permissionMode: ctx.permissionMode,
        shell: host.shell(),
        model: role.model,
        effort: role.effort,
        sessionId,
        extraArgs
      })
      ptyId = launchAgent(inv, cwd, (launch, onExit) => spawnPty({
        meta: { role: 'coordinator', label: 'координатор', projectId: ctx.projectId, runId: run.id },
        cwd,
        command: launch.command,
        args: launch.args,
        cols,
        rows,
        env: {
          ...baseEnv(ctx),
          ...launch.env,
          ORCA_ROLE: 'coordinator',
          ORCA_RUN_ID: run.id,
          // Таймауты Bash-инструмента Claude Code: координатор подолгу ждёт воркеров в check --wait/--follow.
          BASH_DEFAULT_TIMEOUT_MS: '1800000',
          BASH_MAX_TIMEOUT_MS: '3600000'
        }
      }, onExit), (id) => {
        store.coordinatorExited(run.id, id)
        escalateAfterCoordinator(store, run.id)
      }, host.launchOptions())
    } catch (e) {
      // Координатор не запустился — пустой прогон не оставляем висеть открытым, его файлы не храним.
      // Существующую глобальную задачу не трогаем: она жила и до этого запуска.
      if (!resume) store.closeRun(run.id)
      if (root) clearStartImages(root, run.id, !resume)
      throw e
    }
    store.setRunPty(run.id, ptyId, role.agent, { roleId: role.id, agent: role.agent, model: role.model, sessionId })
    return { ptyId, runId: run.id }
  }

  /**
   * «Вернуть в работу» с «Проверки»: уточнение человека сохраняется в прогоне (`returnGlobalTask`), и координатор
   * запускается повторно — уточнение он получит в цели (`resumeObjective` → `resumeCoordinatorObjective`).
   * Прежний координатор, если его терминал ещё жив, закрывается после правки стора (`returnGlobalTaskToWork`):
   * иначе возврат был бы недоступен, пока агент сам не выйдет.
   * Упал запуск после возврата — карточка остаётся «В работе» с уточнением, «Запустить координатора» его подхватит.
   * `images` — пути картинок к уточнению, уже сохранённые в cwd координатора (`withReturnImages`): они лежат в `Run.returns`
   * и попадают в цель повторного запуска.
   */
  function returnToWork(
    store: TaskStore,
    repoRoot: string,
    ctx: WorkerEnvContext,
    runId: string,
    text: string,
    cols = 120,
    rows = 30,
    images: string[] = []
  ): { ptyId: string; runId: string } {
    returnGlobalTaskToWork(store, runId, text, isAlive, killPty, images)
    return startCoordinator(store, repoRoot, ctx, '', cols, rows, [], runId)
  }

  /**
   * Контекст ассистента: он один на приложение и к типу задачи не относится — агент, модель, effort и инструкции
   * из `AppSettings.assistant`, режим разрешений фиксированный (`ASSISTANT_PERMISSION_MODE`). Правил проекта у него
   * нет: они относятся к агентам, работающим в репозитории проекта.
   */
  /**
   * Ассистент доски: интерактивный агент из настроек приложения (`AppSettings.assistant`).
   * Один на всё приложение: работает со всеми проектами через orca-board --project (без флага — активный в UI).
   * cwd — нейтральный userData/assistant, а не репозиторий: файлового доступа к проектам у ассистента нет.
   * Прогон не создаётся и ORCA_RUN_ID нет (skills/assistant.md). Установлен ли агент, проверяет вызывающий (`AssistantSession`).
   *
   * Amp/Shell остаются PTY с отдельной кнопкой вкладки терминалов. Остальные агенты идут через
   * assistant-conversation.ts; этот запуск не используется новым двусторонним чатом.
   */
  function startAssistant(ctx: AssistantContext, cols = 120, rows = 30, onExit?: (id: string, code: number) => void): { ptyId: string; sessionId?: string } {
    const l = assistantLaunch(ctx.settings, host.prompts.assistant, host.language())
    const spec = getAgent(l.agent)
    if (!spec) throw new Error(`неизвестный агент: ${l.agent}`)
    const sessionId = agentSessionId(spec)
    const inv = spec.invoke(l.system, l.prompt, {
      permissionMode: l.permissionMode,
      shell: host.shell(),
      model: l.model,
      effort: l.effort,
      sessionId,
      extraArgs: l.extraArgs
    })
    const cwd = assistantCwd(host.dataDir)
    mkdirSync(cwd, { recursive: true })
    const ptyId = launchAgent(inv, cwd, (launch, exited) => spawnPty(
      {
        meta: { role: 'assistant', label: 'ассистент' },
        cwd,
        command: launch.command,
        args: launch.args,
        cols,
        rows,
        env: {
          ...assistantEnv({ socketPath: ctx.socketPath, path: workerPath(), nodePath: host.nodePath }),
          ...launch.env
        }
      },
      exited
    ), onExit, host.launchOptions())
    return { ptyId, sessionId }
  }

  return { startWorker, startCoordinator, returnToWork, startAssistant, workerPath }
}

export type WorkerServices = ReturnType<typeof createWorkerServices>
