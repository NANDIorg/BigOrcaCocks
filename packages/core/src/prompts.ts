// Только type-импорты: модуль тестируется node --test без бандлера.
import type { AgentSpec } from './agents'
import type { Question, Task } from './types'

/**
 * Какую служебную инструкцию Orca получает агент: `coordinator` — при запуске координатора
 * (skills/coordinator.md), `worker` — при старте задачи (skills/worker.md).
 */
export type BuiltinPromptKind = 'coordinator' | 'worker'

/** Тексты служебных инструкций. Источник — skills/*.md, их отдаёт main-процесс (тот же текст, что при запуске). */
export type BuiltinPrompts = Record<BuiltinPromptKind, string>

/** Роль, которой запускается координатор. */
export const COORDINATOR_ROLE_ID = 'coordinator'

/** Служебная инструкция роли: у coordinator — координаторская, у остальных — воркерская. */
export function builtinPromptKind(roleId: string): BuiltinPromptKind {
  return roleId === COORDINATOR_ROLE_ID ? 'coordinator' : 'worker'
}

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

/**
 * Стартовое задание воркера: название, описание, замечания после ревью и ответы на вопросы по задаче
 * (`answers` — если воркер спрашивал до перезапуска). У задачи-ответа (`answerFor`) — блок о том, что
 * результат — ответ в markdown, а замечания — уточнение к прошлому ответу (`previousAnswer`).
 */
export function workerTaskPrompt(
  task: Pick<Task, 'title' | 'spec' | 'feedback' | 'answerFor'>,
  previousAnswer?: string,
  answers: AnsweredQuestion[] = []
): string {
  if (!task.answerFor) {
    const feedback = task.feedback ? `\n\n# Замечания после ревью\n\n${task.feedback}` : ''
    return [`# Задача: ${task.title}`, '', task.spec || '(описание не задано)', ...answersSection(answers), feedback].join('\n')
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
 * Цель повторного запуска координатора на глобальной задаче: исходная цель плюс уже созданные подзадачи
 * (`status` — название колонки). Правила продолжения — раздел «Повторный запуск» встроенной инструкции,
 * здесь только ссылка на него. Подзадач нет — цель без изменений.
 */
export function resumeCoordinatorObjective(goal: string, subtasks: Array<Pick<Task, 'id' | 'title' | 'status'>>): string {
  if (subtasks.length === 0) return goal
  return [
    goal,
    '',
    `${COORDINATOR_RESUME_SECTION}: у этой глобальной задачи уже есть подзадачи — действуй по разделу «${COORDINATOR_RESUME_SECTION}» инструкции (сверься с \`orca-board global tasks\`, не создавай дубли):`,
    ...subtasks.map((t) => `- ${t.id} [${t.status}] ${t.title}`),
    'Если все они в done и новых подзадач не нужно — run_done не придёт: сводка и сразу `orca-board runs finish`.'
  ].join('\n')
}
