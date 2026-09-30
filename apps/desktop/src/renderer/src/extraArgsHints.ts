import {
  EXTRA_ARGS_MAX_COUNT, EXTRA_ARGS_MAX_LENGTH, parseExtraArgs, reservedFlagsIn,
  type AgentInfo, type ExtraArgsError, type ReservedFlagReason
} from '@orca-board/core'
import type { Executor } from './commandPreview'
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

/**
 * Причины, верные только при заполненном поле исполнителя: тогда приложение ставит свой флаг после флагов
 * пользователя и побеждает. При пустом поле своего флага нет — флаг пользователя действует, предупреждать не о чем.
 */
const FIELD_OF: Partial<Record<ReservedFlagReason, 'model' | 'effort'>> = { model: 'model', effort: 'effort' }

/** Что показать под полем: ошибка разбора (тогда введённые флаги не сохраняются) или предупреждения. */
export interface ExtraArgsCheck {
  /** Разобранные флаги; при ошибке — []. */
  args: string[]
  error?: string
  warnings: ExtraArgsWarning[]
}

/**
 * Проверка введённых флагов тем же разбором, что и в main: причину человек видит сразу. Негодные флаги в main не
 * отправляются (`withSavableExtraArgs`) — к причине дописано, что сохранены прежние, а остальные поля сохраняются.
 * Зарезервированные флаги — только предупреждения, сохранению они не мешают; про модель и effort — лишь когда
 * поле исполнителя заполнено (`FIELD_OF`).
 */
export function checkExtraArgs(t: TFunction, exec: Executor): ExtraArgsCheck {
  const text = exec.extraArgs ?? ''
  const parsed = parseExtraArgs(text)
  if (!parsed.ok) {
    const error = [
      t(ERROR_TEXT[parsed.error], { detail: parsed.detail ?? '', max: ERROR_MAX[parsed.error] ?? '' }),
      // Windows-путь `"C:\dir\"`: `\"` в двойных кавычках — экранированная кавычка, значение не закрылось.
      ...(parsed.error === 'quote' && parsed.detail === '"' && text.includes('\\"') ? [t('config.roles.extraArgsQuoteBackslash')] : []),
      t('config.roles.extraArgsUnsaved')
    ].join(' ')
    return { args: [], error, warnings: [] }
  }
  return {
    args: parsed.args,
    warnings: reservedFlagsIn(exec.agent, parsed.args)
      .filter((r) => {
        const field = FIELD_OF[r.reason]
        return !field || Boolean(exec[field])
      })
      .map((r) => ({ flag: r.flag, text: t(RESERVED_TEXT[r.reason]) }))
  }
}
