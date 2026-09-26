// Только type-импорты: модуль тестируется node --test без бандлера.
import type { AgentSpec } from './agents'
import type { Question, Role, StageDecision, Task } from './types'
import type { WfDecisionOption, WfWorkStage } from './workflow'

/**
 * Какую служебную инструкцию Orca получает агент: `coordinator` — при запуске координатора
 * (skills/coordinator.md), `assistant` — ассистент доски (skills/assistant.md), `worker` — при старте задачи (skills/worker.md).
 */
export type BuiltinPromptKind = 'coordinator' | 'assistant' | 'worker'

/** Тексты служебных инструкций. Источник — skills/*.md, их отдаёт main-процесс (тот же текст, что при запуске). */
export type BuiltinPrompts = Record<BuiltinPromptKind, string>

/** Роль, которой запускается координатор. */
export const COORDINATOR_ROLE_ID = 'coordinator'

/** Роль, которой запускается ассистент доски. */
export const ASSISTANT_ROLE_ID = 'assistant'

/** Служебные роли: запускают агента вне задач (координатор, ассистент), задачам не назначаются. */
export const SERVICE_ROLE_IDS: readonly string[] = [COORDINATOR_ROLE_ID, ASSISTANT_ROLE_ID]

/** Роль можно назначить задаче: не служебная. */
export function isTaskRole(roleId: string): boolean {
  return !SERVICE_ROLE_IDS.includes(roleId)
}

/** Служебная инструкция роли: у coordinator — координаторская, у assistant — ассистента, у остальных — воркерская. */
export function builtinPromptKind(roleId: string): BuiltinPromptKind {
  if (roleId === COORDINATOR_ROLE_ID) return 'coordinator'
  if (roleId === ASSISTANT_ROLE_ID) return 'assistant'
  return 'worker'
}

/**
 * Роль запуска ассистента: роль assistant; в проектах, созданных до неё, — агент, модель и effort роли
 * coordinator (без её инструкций — они координаторские); нет и её — undefined (claude без модели).
 */
export function assistantRole(roles: readonly Role[]): Role | undefined {
  const own = roles.find((r) => r.id === ASSISTANT_ROLE_ID)
  if (own) return own
  const c = roles.find((r) => r.id === COORDINATOR_ROLE_ID)
  if (!c) return undefined
  return {
    id: ASSISTANT_ROLE_ID, title: 'Ассистент', agent: c.agent,
    ...(c.model ? { model: c.model } : {}), ...(c.effort ? { effort: c.effort } : {})
  }
}

/** Стартовое сообщение ассистента: задание приходит от человека в терминале, не при запуске. */
export const ASSISTANT_START_PROMPT = 'Поздоровайся одной строкой и жди запроса человека.'

/** Кому адресован ответ — для промпта воркера. */
const ANSWER_READER = { human: 'человек', coordinator: 'координатор' } as const

/**
 * Вопрос воркера с ответом — для промпта перезапуска. Живому воркеру ответ приходит через `orca-board ask`
 * (переподключение к тому же вопросу) или по пинку в терминал с командой `request get` (answerNudge в main).
 */
export type AnsweredQuestion = Pick<Question, 'question' | 'answer'>

/**
 * Раздел с ответами на вопросы по задаче: перезапущенный воркер не должен спрашивать заново, а воркер следующего
 * этапа получает ответы, которые человек дал на этапе «Вопрос человеку» (сам он ничего не спрашивал) —
 * поэтому заголовок нейтральный.
 */
function answersSection(answers: AnsweredQuestion[]): string[] {
  const done = answers.filter((q) => q.answer !== undefined)
  if (done.length === 0) return []
  return ['', '# Ответы на вопросы по задаче', '', ...done.map((q) => `- ${q.question}\n  Ответ: ${q.answer}`)]
}

/** Заголовок раздела этапа в промпте воркера; дальше — название ноды. */
export const WORKER_STAGE_HEADING = '# Этап:'

/** Правила воркера на этапе «Вопрос человеку»: общие для задачи подзадач и для одиночной задачи прогона. */
const ASK_STAGE_RULES = [
  'Твоя цель на этом этапе — задать вопрос(ы) человеку. Код не меняй и ничего не коммить. Изучай задачу и репозиторий только затем, чтобы спросить точно.',
  'Спрашивай штатным `orca-board ask --question "..." [--option "метка|пояснение" ...] [--recommend <номер|метка>] [--context-file why.md]`: ответ человека придёт в поле `answer`. Вопросы задавай по одному и учитывай ответ в следующем. На этом этапе отвечает человек, а не координатор.',
  'Когда выяснил всё, что нужно, — сдай `orca-board done --summary "что выяснил"`. Ответы на вопросы получит следующий этап.'
]

/**
 * Раздел об этапе «Вопрос человеку»: цель — спросить, а не делать. Без новых команд CLI: `orca-board ask` и
 * `done` уже описаны в инструкции воркера. `answered` — ответы уже есть (повторный заход, перезапуск).
 */
function askStageSection(stage: WfWorkStage, answered: boolean): string[] {
  const parts = ['', `${WORKER_STAGE_HEADING} ${stage.title}`]
  if (stage.instructions) parts.push('', stage.instructions)
  parts.push('', ...ASK_STAGE_RULES.flatMap((l, i) => (i === 0 ? [l] : ['', l])))
  if (answered) parts.push('', 'Ответы выше уже получены (этап запущен повторно): не переспрашивай, спрашивай только новое.')
  return parts
}

/**
 * Раздел об этапе «Работа» или «Вопрос человеку»: что сделать (`instructions` ноды) и что сдать на показ человеку
 * (`showcase`). Нечего сказать — пусто: промпт задач без настроек этапа не меняется (у `ask` раздел есть всегда).
 * Флаги `done` для показа — те же, что подсказывает ошибка `finishDispatch`.
 */
function stageSection(stage: WfWorkStage | undefined, answered = false): string[] {
  if (stage?.type === 'ask') return askStageSection(stage, answered)
  if (!stage || (!stage.instructions && !stage.showcase)) return []
  const parts = ['', `${WORKER_STAGE_HEADING} ${stage.title}`]
  if (stage.instructions) parts.push('', stage.instructions)
  if (stage.showcase) {
    parts.push(
      '',
      `## Результат для показа человеку${stage.showcase.required ? ' (обязательно)' : ''}`,
      '',
      stage.showcase.what,
      '',
      'После этого этапа результат смотрит человек и решает, что дальше. Файлы для показа (макеты, скриншоты, HTML) закоммить в ветку задачи.',
      'Сдай показ вместе с done: описание в markdown — файлом вне репозитория, файлы — путями от корня репозитория, флаг на каждый:',
      '`orca-board done --summary "..." --show-file <описание.md> --show <путь> --show <путь>`.'
    )
    if (stage.showcase.required) parts.push('Без показа done не пройдёт.')
  }
  return parts
}

/**
 * Стартовое задание воркера: название, описание, замечания после ревью и ответы на вопросы по задаче
 * (`answers` — если воркер спрашивал до перезапуска или человек отвечал на этапе «Вопрос человеку»). `stage` — этап «Работа» или «Вопрос человеку» графа (`TaskStore.taskWorkStage`):
 * его инструкция и требование показа идут разделом «Этап». У задачи-ответа (`answerFor`) — блок о том, что
 * результат — ответ в markdown, а замечания — уточнение к прошлому ответу (`previousAnswer`); этапа у неё нет.
 */
export function workerTaskPrompt(
  task: Pick<Task, 'title' | 'spec' | 'feedback' | 'answerFor'>,
  previousAnswer?: string,
  answers: AnsweredQuestion[] = [],
  stage?: WfWorkStage
): string {
  if (!task.answerFor) {
    const feedback = task.feedback ? `\n\n# Замечания после ревью\n\n${task.feedback}` : ''
    return [`# Задача: ${task.title}`, '', task.spec || '(описание не задано)', ...answersSection(answers), ...stageSection(stage, answers.some((q) => q.answer !== undefined)), feedback].join('\n')
  }
  const parts = [
    `# Задача: ${task.title}`,
    '',
    task.spec || '(описание не задано)',
    ...answersSection(answers),
    '',
    '# Результат — ответ, а не код',
    '',
    `Это задача-ответ: её результат читает ${ANSWER_READER[task.answerFor]}. Код не меняй и не коммить.`,
    'Ответ оформи в markdown (заголовки, списки, `путь:строка` на код) в файле вне репозитория и сдай его:',
    '`orca-board done --summary "<одна строка — суть ответа>" --answer-file <файл.md>`.'
  ]
  if (task.feedback) {
    if (previousAnswer) parts.push('', '# Прошлый ответ', '', previousAnswer)
    parts.push('', '# Уточнение к прошлому ответу', '', task.feedback, '', 'Дай новый полный ответ с учётом уточнения.')
  }
  return parts.join('\n')
}

// ---------- задачи прогона: проверка и вопрос человеку ----------

/** Сводка закрытого этапа «Работа» (`StageChange.summary` из `Run.stageHistory`): что получили следующие этапы. */
export interface RunStageSummary {
  title: string
  summary: string
}

/**
 * Что знает приложение о глобальной задаче, когда создаёт для неё задачу-проверку (`gate`) или задачу-вопрос (`ask`):
 * цель, ветка с базой (нет ветки — проект без git) и сводки прошлых этапов «Работа».
 */
export interface RunTaskContext {
  /** Цель глобальной задачи (описание, нет — название). */
  goal: string
  /** Название глобальной задачи — для заголовков спеки. */
  title: string
  /** Ветка глобальной задачи (`Run.git.branch`). */
  branch?: string
  /** База ветки (`Run.git.base`): дифф всей ветки считается против неё. */
  base?: string
  /** Сводки закрытых этапов «Работа», от старых к новым; этапы без сводки не передаём. */
  stages?: readonly RunStageSummary[]
  /** Инструкции самой ноды (`gate`: как проверять, `ask`: что выяснить). */
  instructions?: string
}

function goalSection(ctx: RunTaskContext): string[] {
  return ['## Цель глобальной задачи', '', ctx.goal.trim() || ctx.title]
}

function stageSummariesSection(stages: readonly RunStageSummary[] = []): string[] {
  const done = stages.filter((s) => s.summary.trim())
  if (done.length === 0) return []
  return ['## Что сделано на прошлых этапах', '', ...done.flatMap((s) => [`### «${s.title}»`, '', s.summary.trim(), ''])].slice(0, -1)
}

/** Название задачи-проверки прогона: «<название ноды>: <название глобальной задачи>». */
export function runGateTaskTitle(nodeTitle: string, runTitle: string): string {
  return `${nodeTitle}: ${runTitle}`
}

/**
 * Спека задачи-проверки ноды `gate` воркфлоу глобальной задачи: проверяется ветка глобальной задачи **целиком**
 * против её базы, а не ветка одной подзадачи. Общий шаблон для любого проекта; как проверять в конкретном
 * репозитории — в `instructions` ноды или системном промпте роли. Свой id проверяющий берёт из `$ORCA_TASK_ID`
 * (id задачи неизвестен, пока её не создали): `review accept|reject` по нему двигает граф прогона, а не подзадачи.
 */
export function runGateTaskSpec(ctx: RunTaskContext): string {
  const { branch, base } = ctx
  const against = base ? `относительно базы \`${base}\`` : 'относительно основной ветки'
  const steps: string[] = []
  if (branch) {
    steps.push(
      `1. Что вошло в ветку: коммиты — \`git log ${base ?? '<основная ветка>'}..${branch}\`, итоговый дифф — \`git diff ${base ?? '<основная ветка>'}...${branch}\` (для обзора \`--stat\`).`,
      `2. Проверь работу в своём worktree: слей ветку без коммита (\`git merge --no-commit ${branch}\`), проверь, затем отмени слияние (\`git merge --abort\`).`
    )
  } else {
    steps.push(
      '1. У глобальной задачи нет отдельной ветки: её работа слита в текущую ветку проекта. Посмотри, что изменилось, по `git log`.',
      '2. Проверь результат в своём worktree.'
    )
  }
  steps.push(
    '3. Сверь результат с целью глобальной задачи и сводками этапов ниже: сделано ли то, что просили, и всё ли работает вместе.',
    '4. Всё хорошо — `orca-board review accept --task "$ORCA_TASK_ID"`. Нет — `orca-board review reject --task "$ORCA_TASK_ID" --feedback "что исправить"`: замечания получит координатор, и граф вернётся на этап «Работа».',
    '5. Последней командой обязательно `orca-board done --summary "принято"` или `"отклонено: …"` — без неё проверка останется открытой.'
  )
  const parts = [
    branch
      ? `Проверь ветку \`${branch}\` глобальной задачи «${ctx.title}» целиком: всё, что в ней сделано ${against}. Проверяется вся работа, а не отдельная подзадача.`
      : `Проверь результат глобальной задачи «${ctx.title}» целиком. Проверяется вся работа, а не отдельная подзадача.`,
    steps.join('\n'),
    goalSection(ctx).join('\n')
  ]
  const stages = stageSummariesSection(ctx.stages)
  if (stages.length > 0) parts.push(stages.join('\n'))
  const own = ctx.instructions?.trim()
  if (own) parts.push(`## Как проверять\n\n${own}`)
  return parts.join('\n\n')
}

/** Название задачи-вопроса прогона: «<название ноды>: <название глобальной задачи>». */
export function runAskTaskTitle(nodeTitle: string, runTitle: string): string {
  return `${nodeTitle}: ${runTitle}`
}

/**
 * Спека задачи-вопроса ноды `ask` воркфлоу глобальной задачи: одна задача роли ноды, её вопросы идут человеку
 * напрямую, а ответы получит следующая «Работа» (координатор увидит их в `stage_started`). Спека самодостаточна
 * (правила этапа те же, что в разделе «# Этап» воркера) — отдельный раздел этапа к ней добавлять не нужно.
 */
export function runAskTaskSpec(ctx: RunTaskContext): string {
  const parts = [
    `Ты — этап «Вопрос человеку» воркфлоу глобальной задачи «${ctx.title}»: выясни у человека то, чего не хватает, прежде чем работа пойдёт дальше.`,
    goalSection(ctx).join('\n')
  ]
  const stages = stageSummariesSection(ctx.stages)
  if (stages.length > 0) parts.push(stages.join('\n'))
  if (ctx.branch) parts.push(`Ветка глобальной задачи: \`${ctx.branch}\`${ctx.base ? ` (от \`${ctx.base}\`)` : ''} — читать можно, менять нельзя.`)
  const own = ctx.instructions?.trim()
  if (own) parts.push(`## Что нужно выяснить\n\n${own}`)
  parts.push(`## Как спрашивать\n\n${ASK_STAGE_RULES.join('\n\n')}`)
  return parts.join('\n\n')
}

/**
 * Правила задачи-решателя ноды `decision`: выбрать ровно один вариант командой `decision choose` или передать решение
 * человеку (`decision escalate`), код не трогать. `done` без выбора — тоже передача человеку (фоллбэк `no_answer`).
 */
const DECISION_STAGE_RULES = [
  'Твоя цель — выбрать ровно один вариант из списка выше. Код не меняй и ничего не коммить: задачу, сводки и ветку изучай только затем, чтобы решить точно.',
  'Выбери вариант: `orca-board decision choose --task "$ORCA_TASK_ID" --option <id> --reason "почему этот вариант"`. `--reason` обязателен — коротко и по делу: обоснование увидят координатор и человек. Граф сразу пойдёт по ветке варианта. Ошибка «нет варианта» — возьми id из списка вариантов и повтори.',
  'Не можешь решить уверенно (не хватает данных, варианты равноценны) — передай решение человеку: `orca-board decision escalate --task "$ORCA_TASK_ID" --reason "что неясно"`. Человек выберет из тех же вариантов и увидит твой комментарий.',
  'Последней командой обязательно `orca-board done --summary "выбрано: <название варианта>"` (или `"передано человеку: …"`). `done` без выбора и без escalate тоже передаст решение человеку.'
]

/** Пройденный этап глобальной задачи для задачи-решателя: запись `Run.stageHistory` без коммита и сводки. */
export interface RunPathStep {
  title: string
  /** Какой по счёту заход в ноду. */
  visit?: number
  /** Исход, с которым граф пришёл в ноду (порт прошлой ноды или id варианта развилки). */
  outcome?: string
  /** Решение прошлого захода в развилку. */
  decision?: Pick<StageDecision, 'label' | 'reason' | 'by'>
}

/**
 * Что знает приложение, когда создаёт задачу-решатель ноды `decision`: общий контекст задач прогона плюс вопрос,
 * варианты и пройденный путь по графу (от старых записей к новым; последняя — сама развилка).
 */
export interface RunDecisionContext extends RunTaskContext {
  question: string
  options: readonly Pick<WfDecisionOption, 'id' | 'label' | 'description'>[]
  path?: readonly RunPathStep[]
}

/** Название задачи-решателя прогона: «<название ноды>: <название глобальной задачи>». */
export function runDecisionTaskTitle(nodeTitle: string, runTitle: string): string {
  return `${nodeTitle}: ${runTitle}`
}

function pathSection(path: readonly RunPathStep[] = []): string[] {
  if (path.length === 0) return []
  const lines = path.map((p, i) => {
    const notes = [
      p.visit !== undefined && p.visit > 1 ? `заход ${p.visit}` : '',
      p.outcome ? `пришли по исходу \`${p.outcome}\`` : ''
    ].filter(Boolean)
    const head = `${i + 1}. «${p.title}»${notes.length ? ` (${notes.join(', ')})` : ''}`
    if (!p.decision) return head
    const who = p.decision.by === 'human' ? 'решил человек' : 'решил агент'
    const reason = p.decision.reason?.trim() ? `: ${p.decision.reason.trim().replace(/\s+/g, ' ')}` : ''
    return `${head} — выбрано «${p.decision.label}» (${who})${reason}`
  })
  return ['## Путь по графу', '', ...lines]
}

/**
 * Спека задачи-решателя ноды `decision` воркфлоу глобальной задачи: агент отвечает на вопрос ноды по смыслу задачи и
 * выбирает ветку. Спека самодостаточна: вопрос, варианты (`id — метка — описание`), цель, сводки прошлых этапов, путь по
 * графу, «Как решать» (`instructions` ноды), ветка только для чтения и правила сдачи (`DECISION_STAGE_RULES`). Свой id
 * агент берёт из `$ORCA_TASK_ID` — задачу создают вместе с запуском.
 */
export function runDecisionTaskSpec(ctx: RunDecisionContext): string {
  const options = ctx.options.map((o) => `- \`${o.id}\` — ${o.label}${o.description?.trim() ? `: ${o.description.trim()}` : ''}`)
  const parts = [
    `Ты — нода «Решение ИИ» воркфлоу глобальной задачи «${ctx.title}»: ответь на вопрос по смыслу задачи и выбери ветку, по которой граф пойдёт дальше.`,
    `## Вопрос\n\n${ctx.question.trim()}`,
    `## Варианты\n\n${options.join('\n')}`,
    goalSection(ctx).join('\n')
  ]
  const stages = stageSummariesSection(ctx.stages)
  if (stages.length > 0) parts.push(stages.join('\n'))
  const path = pathSection(ctx.path)
  if (path.length > 0) parts.push(path.join('\n'))
  if (ctx.branch) parts.push(`Ветка глобальной задачи: \`${ctx.branch}\`${ctx.base ? ` (от \`${ctx.base}\`)` : ''} — читать можно (\`git log\`, \`git diff\`), менять нельзя.`)
  const own = ctx.instructions?.trim()
  if (own) parts.push(`## Как решать\n\n${own}`)
  parts.push(`## Как сдать решение\n\n${DECISION_STAGE_RULES.join('\n\n')}`)
  return parts.join('\n\n')
}

/**
 * Как агент получает системную инструкцию: `system` — отдельным system prompt (claude, `--append-system-prompt`),
 * `combined` — в начале стартового сообщения перед заданием, `none` — не получает (оболочка).
 * Выводится из `invoke` реестра, а не из отдельного списка.
 */
export type PromptChannel = 'system' | 'combined' | 'none'

export function promptChannel(spec: Pick<AgentSpec, 'invoke'> | undefined): PromptChannel {
  if (!spec) return 'none'
  const system = '\u0000orca-system\u0000'
  const { args } = spec.invoke(system, '\u0000orca-task\u0000', { permissionMode: 'auto', shell: 'sh' })
  if (args.includes(system)) return 'system'
  return args.some((a) => a.includes(system)) ? 'combined' : 'none'
}

/** Раздел skills/coordinator.md, на который ссылается цель повторного запуска. */
export const COORDINATOR_RESUME_SECTION = 'Повторный запуск'

/**
 * Заголовок блока цели повторного запуска с уточнением человека после «Вернуть в работу» на «Проверке».
 * Та же строка — в разделе «Повторный запуск» skills/coordinator.md (сверяет prompts.test.ts).
 */
export const COORDINATOR_RETURN_HEADING = 'Уточнение после проверки'

/**
 * Заголовок блока цели с этапом графа (воркфлоу глобальной задачи): вход в раздел «Повторный запуск» для
 * координатора, которого приложение перезапустило на этапе «Работа». Та же строка — в skills/coordinator.md.
 */
export const COORDINATOR_STAGE_HEADING = '# Этап:'

/**
 * Этап «Работа», на котором стоит глобальная задача: то, что несёт `stage_started`, но целиком (`TaskStore.runStage`).
 * Структурно совместим с `RunStageInfo`, поэтому store не импортируется.
 */
export interface CoordinatorStage {
  title: string
  /** Какой по счёту заход в этап: возврат по reject увеличивает. */
  visit: number
  /** Роли этапа; нет или пусто — любые рабочие роли типа, выбирает координатор. */
  roleIds?: readonly string[]
  instructions?: string
  /** Замечания проверки или человека, вернувших в этап. */
  feedback?: string
  /** Решение человека на прошлом этапе `human`. */
  decision?: string
  /** Ответы человека на этапе «Вопрос человеку». */
  answers?: string
  /** Id подзадач текущего захода: остальные подзадачи — прошлых заходов. */
  tasks?: readonly string[]
  /** Все подзадачи захода уже закрыты (`stage_tasks_done` уже отправлен). */
  tasksDone?: boolean
}

/**
 * Блок «# Этап» цели координатора: где стоит граф, роли, инструкции, что сказали человек и проверка, какие подзадачи
 * уже есть и что делать дальше. Что делать — раздел «Повторный запуск» инструкции, здесь только состояние.
 */
function coordinatorStageSection(
  stage: CoordinatorStage,
  subtasks: Array<Pick<Task, 'id' | 'title' | 'status'>>
): string[] {
  const roles = stage.roleIds ?? []
  const own = new Set(stage.tasks ?? [])
  const current = subtasks.filter((t) => own.has(t.id))
  const parts = [
    '',
    `${COORDINATOR_STAGE_HEADING} ${stage.title}`,
    '',
    `Глобальная задача стоит на этапе «Работа» «${stage.title}» (заход ${stage.visit}); ты перезапущен на нём — действуй по разделу «${COORDINATOR_RESUME_SECTION}» инструкции (вход — блок «${COORDINATOR_STAGE_HEADING}»).`,
    roles.length > 0
      ? `Роли этапа: ${roles.join(', ')} — подзадачи создавай только с ними.`
      : 'Роли этапа не заданы: роль каждой подзадачи выбирай сам из включённых рабочих ролей типа (`orca-board roles list`, по описанию).'
  ]
  if (stage.instructions?.trim()) parts.push('', '## Инструкции этапа', '', stage.instructions.trim())
  if (stage.feedback?.trim()) parts.push('', '## Замечания проверки или человека', '', stage.feedback.trim(), '', 'Это возврат в этап: создай подзадачи-исправления по замечаниям.')
  if (stage.decision?.trim()) parts.push('', '## Решение человека', '', stage.decision.trim())
  if (stage.answers?.trim()) parts.push('', '## Ответы человека на вопросы', '', stage.answers.trim())
  if (current.length > 0) {
    parts.push('', 'Подзадачи этого захода:', ...current.map((t) => `- ${t.id} [${t.status}] ${t.title}`))
  }
  parts.push(
    '',
    current.length === 0
      ? 'Подзадач в этом заходе ещё нет: `stage_started` ты не получил — создай подзадачи по инструкциям и запусти воркеров.'
      : stage.tasksDone
        ? 'Все подзадачи захода закрыты, `stage_tasks_done` уже отправлен: решай сразу — нужны ли ещё задачи, иначе `orca-board stage finish --summary "..."`.'
        : 'Есть незакрытые подзадачи: продолжи цикл (`worker start` для `ready`) и дождись `stage_tasks_done`.'
  )
  return parts
}

/**
 * Цель повторного запуска координатора на глобальной задаче: исходная цель, уточнения человека после
 * проверки (`returns` — последнее полностью, прошлые списком) и уже созданные подзадачи (`status` — название
 * колонки). Правила продолжения — раздел «Повторный запуск» встроенной инструкции, здесь только ссылка на него.
 * Нет ни подзадач, ни уточнений — цель без изменений.
 *
 * `stage` — воркфлоу глобальной задачи (`Run.workflowScope: 'run'`): координатор входит по блоку «# Этап» (граф ведёт
 * приложение, `runs finish` не нужен), замечания человека уже в `stage.feedback`, поэтому «Уточнение после проверки»
 * не добавляется. Подзадачи прошлых заходов — списком для контекста.
 */
export function resumeCoordinatorObjective(
  goal: string,
  subtasks: Array<Pick<Task, 'id' | 'title' | 'status'>>,
  returns: ReadonlyArray<{ text: string }> = [],
  stage?: CoordinatorStage
): string {
  if (stage) {
    const own = new Set(stage.tasks ?? [])
    const earlier = subtasks.filter((t) => !own.has(t.id))
    const parts = [goal, ...coordinatorStageSection(stage, subtasks)]
    if (earlier.length > 0) {
      parts.push('', 'Подзадачи прошлых заходов и этапов (уже сделаны, не создавай их заново):', ...earlier.map((t) => `- ${t.id} [${t.status}] ${t.title}`))
    }
    return parts.join('\n')
  }
  const parts = [goal]
  const last = returns[returns.length - 1]
  if (last) {
    parts.push(
      '',
      `${COORDINATOR_RETURN_HEADING}: человек проверил результат и вернул задачу в работу — действуй по разделу «${COORDINATOR_RESUME_SECTION}» инструкции:`,
      last.text
    )
    const earlier = returns.slice(0, -1)
    if (earlier.length > 0) parts.push('', 'Прошлые уточнения (уже учтены в прошлых запусках):', ...earlier.map((r) => `- ${r.text}`))
  }
  if (subtasks.length > 0) {
    parts.push(
      '',
      `${COORDINATOR_RESUME_SECTION}: у этой глобальной задачи уже есть подзадачи — действуй по разделу «${COORDINATOR_RESUME_SECTION}» инструкции (сверься с \`orca-board global tasks\`, не создавай дубли):`,
      ...subtasks.map((t) => `- ${t.id} [${t.status}] ${t.title}`),
      last
        ? 'Уточнение — новая работа: создай подзадачи по нему. Если оно правда не требует работы — сразу `orca-board runs finish --summary "..."` со сводкой и объяснением.'
        : 'Если все они в done и новых подзадач не нужно — run_done не придёт: сразу `orca-board runs finish --summary "..."` с итоговой сводкой.'
    )
  }
  return parts.join('\n')
}
