// Флаги пользователя к команде запуска агента (`Role.extraArgs`, `AssistantSettings.extraArgs`) на стороне main:
// текст ошибки разбора на языке интерфейса, разбор перед запуском и вырезание поля из ответов сокета.
// Без electron и PTY — чтобы проверять node:test (worker.ts тянет electron).
import { EXTRA_ARGS_MAX_COUNT, EXTRA_ARGS_MAX_LENGTH, parseExtraArgs, type ExtraArgsParse, type Role } from '@orca-board/core'
import { OrcaError, type MText } from './i18n'

/** Сколько символов чужого токена показываем в ошибке: строка флагов бывает до `EXTRA_ARGS_MAX_LENGTH`. */
const DETAIL_LIMIT = 40

/** Причина отказа `parseExtraArgs` непереведённой — параметр `{reason}` ошибок `*.extraArgsInvalid`. */
export function extraArgsReason(parse: Extract<ExtraArgsParse, { ok: false }>): MText {
  const detail = parse.detail ?? ''
  const max = parse.error === 'length' ? EXTRA_ARGS_MAX_LENGTH : EXTRA_ARGS_MAX_COUNT
  return {
    key: `extraArgs.${parse.error}`,
    params: { detail: detail.length > DETAIL_LIMIT ? `${detail.slice(0, DETAIL_LIMIT)}…` : detail, max }
  }
}

/**
 * Проверка строки флагов при сохранении: undefined — строка годится, иначе причина отказа.
 * Сама строка хранится как введена — разбор повторяется при запуске (`launchExtraArgs`).
 */
export function extraArgsProblem(text: string): MText | undefined {
  const parse = parseExtraArgs(text)
  return parse.ok ? undefined : extraArgsReason(parse)
}

/**
 * Флаги пользователя для `AgentSpec.invoke`. Разбор повторяется при каждом запуске, а не доверяет сохранению:
 * строку могли испортить в projects.json руками, а снимок типа в прогоне (`Run.taskType`) валидацию не проходит.
 * `error` оборачивает причину в сообщение вызывающего («воркер не запустится: …»).
 */
export function launchExtraArgs(text: string | undefined, error: (reason: MText) => MText): string[] {
  if (text === undefined) return []
  // Не строка — только из правленного руками файла или снимка; показываем как «не флаг», а не падаем на `.length`.
  const parse: ExtraArgsParse = typeof text === 'string' ? parseExtraArgs(text) : { ok: false, error: 'notFlag', detail: String(text) }
  if (!parse.ok) throw OrcaError.of(error(extraArgsReason(parse)))
  return parse.args
}

/** Флаги роли для запуска воркера или координатора; негодная строка — «… не запустится: роль «id»: флаги запуска: …». */
export function roleLaunchExtraArgs(role: Pick<Role, 'id' | 'extraArgs'>, cannotStart: 'worker.cannotStart' | 'coordinator.cannotStart'): string[] {
  return launchExtraArgs(role.extraArgs, (reason) => ({
    key: cannotStart,
    params: { reason: { key: 'role.extraArgsInvalid', params: { id: role.id, reason } } }
  }))
}

/**
 * Замена для `JSON.stringify` ответов сокета: поле `extraArgs` не уходит ни в один ответ — ни в роли (`roles.*`,
 * `types.*`), ни в настройки ассистента (`settings.*`), ни в снимок типа внутри прогона (`runs.list`). Ответы сокета
 * читают агенты (координатор, ассистент — LLM над недоверенным текстом задач), а во флагах бывают пути и токены
 * (`--mcp-config`, `--header`). Флаги видит и меняет только человек в UI — через IPC.
 */
export function withoutExtraArgs(key: string, value: unknown): unknown {
  return key === 'extraArgs' ? undefined : value
}
