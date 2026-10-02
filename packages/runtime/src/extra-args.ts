import { EXTRA_ARGS_MAX_COUNT, EXTRA_ARGS_MAX_LENGTH, parseExtraArgs, type ExtraArgsParse } from '@orca-board/core'
import type { ProjectMessage } from './project-messages.ts'

export interface ExtraArgsMessage extends ProjectMessage {
  key: `extraArgs.${Extract<ExtraArgsParse, { ok: false }>['error']}`
  params: Record<string, string | number>
}

/** Сколько символов чужого токена показываем в ошибке: строка флагов бывает до `EXTRA_ARGS_MAX_LENGTH`. */
const DETAIL_LIMIT = 40

/** Причина отказа `parseExtraArgs` непереведённой — параметр `{reason}` ошибок `*.extraArgsInvalid`. */
export function extraArgsReason(parse: Extract<ExtraArgsParse, { ok: false }>): ExtraArgsMessage {
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
export function extraArgsProblem(text: string): ProjectMessage | undefined {
  const parse = parseExtraArgs(text)
  return parse.ok ? undefined : extraArgsReason(parse)
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
