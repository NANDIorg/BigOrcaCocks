// Только type-импорты: модуль тестируется node --test без бандлера.
import type { AgentSpec } from './agents'
import type { Question, Role, Task } from './types'
import type { WfWorkStage } from './workflow'

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

/** Раздел с ответами на прошлые вопросы: перезапущенный воркер не должен спрашивать заново. */
function answersSection(answers: AnsweredQuestion[]): string[] {
  const done = answers.filter((q) => q.answer !== undefined)
  if (done.length === 0) return []
  return ['', '# Ответы на твои вопросы', '', ...done.map((q) => `- ${q.question}\n  Ответ: ${q.answer}`)]
}

/** Заголовок раздела этапа в промпте воркера; дальше — название ноды. */
export const WORKER_STAGE_HEADING = '# Этап:'

/**
 * Раздел об этапе «Работа»: что сделать (`instructions` ноды) и что сдать на показ человеку (`showcase`).
 * Нечего сказать — пусто: промпт задач без настроек этапа не меняется. Флаги `done` для показа — те же,
 * что подсказывает ошибка `finishDispatch`.
 */
function stageSection(stage: WfWorkStage | undefined): string[] {
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
 * (`answers` — если воркер спрашивал до перезапуска). `stage` — этап «Работа» графа (`TaskStore.taskWorkStage`):
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
    return [`# Задача: ${task.title}`, '', task.spec || '(описание не задано)', ...answersSection(answers), ...stageSection(stage), feedback].join('\n')
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
