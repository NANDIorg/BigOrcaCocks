// Только type-импорты: модуль тестируется node --test без бандлера.
import type { AgentSpec } from './agents'
import type { Question, Role, Task } from './types'
import type { WfNodeType, WfWorkStage } from './workflow'

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

/**
 * Раздел об этапе «Вопрос человеку»: цель — спросить, а не делать. Без новых команд CLI: `orca-board ask` и
 * `done` уже описаны в инструкции воркера. `answered` — ответы уже есть (повторный заход, перезапуск).
 */
function askStageSection(stage: WfWorkStage, answered: boolean): string[] {
  const parts = ['', `${WORKER_STAGE_HEADING} ${stage.title}`]
  if (stage.instructions) parts.push('', stage.instructions)
  parts.push(
    '',
    'Твоя цель на этом этапе — задать вопрос(ы) человеку. Код не меняй и ничего не коммить. Изучай задачу и репозиторий только затем, чтобы спросить точно.',
    'Спрашивай штатным `orca-board ask --question "..." [--option "метка|пояснение" ...] [--recommend <номер|метка>] [--context-file why.md]`: ответ человека придёт в поле `answer`. Вопросы задавай по одному и учитывай ответ в следующем. На этом этапе отвечает человек, а не координатор.',
    'Когда выяснил всё, что нужно, — сдай `orca-board done --summary "что выяснил"`. Ответы на вопросы получит следующий этап.'
  )
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
 * Цель повторного запуска координатора на глобальной задаче: исходная цель, уточнения человека после
 * проверки (`returns` — последнее полностью, прошлые списком) и уже созданные подзадачи (`status` — название
 * колонки). Правила продолжения — раздел «Повторный запуск» встроенной инструкции, здесь только ссылка на него.
 * Нет ни подзадач, ни уточнений — цель без изменений.
 */
export function resumeCoordinatorObjective(
  goal: string,
  subtasks: Array<Pick<Task, 'id' | 'title' | 'status'>>,
  returns: ReadonlyArray<{ text: string }> = []
): string {
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

// ---------- воркфлоу глобальной задачи: блок «# Этап» в цели координатора ----------

/** Где стоит глобальная задача на графе — то, что координатору нужно знать при (пере)запуске (`TaskStore.runStage`). */
export interface CoordinatorStageInfo {
  nodeId: string
  type: WfNodeType
  title: string
  /** Какой по счёту заход в ноду (после `reject` растёт). */
  visit: number
  /** Роли этапа «Работа»; нет — любые рабочие роли типа. */
  roleIds?: readonly string[]
  instructions?: string
  feedback?: string
  decision?: string
  answers?: string
  /** Подзадачи текущего захода: `status` — название колонки. */
  tasks: ReadonlyArray<{ id: string; title: string; status: string }>
  /** Все подзадачи захода уже закрыты (`stage_tasks_done` ушёл раньше). */
  tasksDone: boolean
}

/** Заголовок блока цели с текущим этапом воркфлоу глобальной задачи. */
export const COORDINATOR_STAGE_HEADING = 'Этап'

/**
 * Блок «# Этап: …» цели координатора глобальной задачи с воркфлоу прогона. На этапе «Работа» это то же, что событие
 * `stage_started`, но целиком: роли, инструкции ноды, замечания проверки или человека, уже созданные подзадачи
 * захода. Приложение перезапускает координатора именно на входе в «Работу» (или человек запускает его руками),
 * а событие мог получить прошлый координатор — поэтому блок самодостаточен, а дубли подзадач запрещены.
 * На остальных этапах координатору делать нечего: этап ведёт приложение, он ждёт `stage_started` или `run_done`.
 */
export function coordinatorStageSection(stage: CoordinatorStageInfo): string {
  const where = `${COORDINATOR_STAGE_HEADING} «${stage.title}»${stage.visit > 1 ? ` (заход ${stage.visit})` : ''}`
  if (stage.type !== 'work') {
    return [
      `# ${where}`,
      '',
      'Воркфлоу этой глобальной задачи сейчас на этапе, который ведёт приложение (проверка, человек, git, мерж): подзадачи не создавай.',
      'Жди `stage_started` — следующий этап «Работа» — или `run_done` (воркфлоу дошёл до конца, тогда выходи).'
    ].join('\n')
  }
  const roles = stage.roleIds && stage.roleIds.length > 0
    ? `Роли подзадач: ${stage.roleIds.map((r) => `\`${r}\``).join(', ')} — других ролей \`task create\` не примет.`
    : 'Роли подзадач не заданы: выбери их сам из рабочих ролей типа задачи по их описаниям (\`orca-board roles list\`).'
  const parts = [
    `# ${where}`,
    '',
    'Ты — диспетчер этого этапа: нарежь работу на подзадачи и запусти воркеров; проверки, мерж и переходы по воркфлоу делает приложение.',
    roles
  ]
  if (stage.instructions?.trim()) parts.push('', 'Что сделать на этапе:', stage.instructions.trim())
  if (stage.feedback?.trim()) parts.push('', 'Замечания проверки или человека — учти их в новых подзадачах:', stage.feedback.trim())
  if (stage.decision?.trim()) parts.push('', 'Решение человека на прошлом этапе:', stage.decision.trim())
  if (stage.answers?.trim()) parts.push('', 'Ответы человека на вопросы прошлого этапа:', stage.answers.trim())
  if (stage.tasks.length > 0) {
    parts.push('', 'Подзадачи этого захода уже есть — не создавай дубли (сверься с `orca-board global tasks`):', ...stage.tasks.map((t) => `- ${t.id} [${t.status}] ${t.title}`))
  }
  parts.push(
    '',
    stage.tasksDone
      ? 'Все подзадачи захода уже закрыты: если работы больше нет — сразу закрой этап `orca-board stage finish --summary "что сделано и что проверить"`.'
      : 'Когда все подзадачи закрыты, придёт `stage_tasks_done`: реши, нужно ли ещё что-то, и закрой этап `orca-board stage finish --summary "что сделано и что проверить"`.'
  )
  return parts.join('\n')
}

/**
 * Цель повторного запуска координатора на глобальной задаче с воркфлоу прогона: исходная цель и блок этапа
 * (`coordinatorStageSection`). Уточнений «после проверки» здесь нет: «Вернуть» человека на ноде `human` — это `reject`,
 * его замечания приходят в блоке этапа как `feedback`. Нет позиции на графе (воркфлоу ещё не начат) — цель без изменений.
 */
export function runResumeCoordinatorObjective(goal: string, stage: CoordinatorStageInfo | undefined): string {
  return stage ? [goal, '', coordinatorStageSection(stage)].join('\n') : goal
}
