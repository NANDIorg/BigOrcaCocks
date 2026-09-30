import {
  EXTRA_ARGS_MAX_COUNT, EXTRA_ARGS_MAX_LENGTH, parseExtraArgs, reservedFlagsIn,
  type AgentInfo, type ExtraArgsError, type ReservedFlagReason
} from '@orca-board/core'
import type { TFunction, TKey } from './i18n'

// Подписи поля «Флаги запуска» (`ExecutorFields`) без React — чтобы тестировать node --test (extraArgsHints.test.ts).

/**
 * Main умеет сохранять флаги: признак выставляет `agents:list` у каждого агента. Старый main поле молча стирает
 * при сохранении, поэтому без признака поле недоступно и просит перезапустить приложение.
 */
export function extraArgsSupported(agents: readonly AgentInfo[]): boolean {
  return agents.some((a) => a.supportsExtraArgs === true)
}

const ERROR_TEXT: Record<ExtraArgsError, TKey> = {
  quote: 'config.roles.extraArgsError.quote',
  separator: 'config.roles.extraArgsError.separator',
  notFlag: 'config.roles.extraArgsError.notFlag',
  control: 'config.roles.extraArgsError.control',
  length: 'config.roles.extraArgsError.length',
  count: 'config.roles.extraArgsError.count'
}

const RESERVED_TEXT: Record<ReservedFlagReason, TKey> = {
  model: 'config.roles.extraArgsReserved.model',
  effort: 'config.roles.extraArgsReserved.effort',
  permission: 'config.roles.extraArgsReserved.permission',
  session: 'config.roles.extraArgsReserved.session',
  print: 'config.roles.extraArgsReserved.print',
  systemPrompt: 'config.roles.extraArgsReserved.systemPrompt'
}

/** Предел, с которым сравнивается `detail` ошибки; у остальных ошибок его нет. */
const ERROR_MAX: Partial<Record<ExtraArgsError, number>> = { length: EXTRA_ARGS_MAX_LENGTH, count: EXTRA_ARGS_MAX_COUNT }

/** Предупреждение о флаге, которым управляет приложение: `text` — фраза с `{flag}` на месте флага (`withCode`). */
export interface ExtraArgsWarning {
  flag: string
  text: string
}

/** Что показать под полем: ошибка разбора (тогда флагов в запуске нет) или предупреждения. */
export interface ExtraArgsCheck {
  /** Разобранные флаги; при ошибке — []. */
  args: string[]
  error?: string
  warnings: ExtraArgsWarning[]
}

/**
 * Проверка введённых флагов тем же разбором, что и в main: причину отказа человек видит сразу, не дожидаясь
 * ответа автосохранения. Зарезервированные флаги — только предупреждения, сохранению они не мешают.
 */
export function checkExtraArgs(t: TFunction, agent: string, text: string | undefined): ExtraArgsCheck {
  const parsed = parseExtraArgs(text ?? '')
  if (!parsed.ok) {
    return { args: [], error: t(ERROR_TEXT[parsed.error], { detail: parsed.detail ?? '', max: ERROR_MAX[parsed.error] ?? '' }), warnings: [] }
  }
  return {
    args: parsed.args,
    warnings: reservedFlagsIn(agent, parsed.args).map((r) => ({ flag: r.flag, text: t(RESERVED_TEXT[r.reason]) }))
  }
}
