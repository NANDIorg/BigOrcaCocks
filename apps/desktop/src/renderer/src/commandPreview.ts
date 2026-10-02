import { getAgent, parseExtraArgs, type AgentKind, type BuiltinPromptKind } from '@orca-board/core'
import type { TFunction } from './i18n'

// Превью команды запуска без React — чтобы тестировать node --test (commandPreview.test.ts).

/** Кто запускается: агент, модель, effort и флаги запуска — поля и роли, и настроек ассистента. */
export interface Executor {
  agent: AgentKind
  model?: string
  effort?: string
  /** Флаги пользователя к команде запуска — строка как введена (`Role.extraArgs`). */
  extraArgs?: string
}

/** Аргумент для превью команды: плейсхолдеры ‹…› как есть, остальное со спецсимволами — в кавычках. */
function shellArg(arg: string): string {
  const flat = arg.replace(/\s*\n\s*/g, ' ')
  if (flat.includes('‹') || !/[\s'"*()$&|;<>]/.test(flat)) return flat
  return `'${flat.replace(/'/g, `'\\''`)}'`
}

/**
 * Строка запуска агента — из того же `invoke` реестра, что и реальный запуск; тексты — плейсхолдерами.
 * `prompt` — стартовое сообщение (или его плейсхолдер), `permissionMode` — известный режим, иначе плейсхолдер.
 * Флаги пользователя разбираются тем же `parseExtraArgs`; неразобранные в запуск не попадут — на их месте пометка.
 */
export function commandPreview(
  t: TFunction, exec: Executor & { systemPrompt?: string }, kind: BuiltinPromptKind, prompt: string, permissionMode?: string
): string {
  const spec = getAgent(exec.agent)
  if (!spec) return t('config.roles.agentUnknownCmd', { agent: exec.agent })
  const system = t(exec.systemPrompt ? 'config.roles.ph.systemWithRole' : 'config.roles.ph.system', { kind })
  const extra = parseExtraArgs(exec.extraArgs ?? '')
  const { command, args, env, settingsFile } = spec.invoke(system, prompt, {
    permissionMode: permissionMode ?? t('config.roles.ph.permission'), shell: '$SHELL', model: exec.model, effort: exec.effort,
    extraArgs: extra.ok ? extra.args : [t('config.roles.ph.extraArgsBad')]
  })
  const argv = settingsFile
    ? [...args.slice(0, -1), settingsFile.flag, t('config.roles.ph.permissionSettings', { settings: JSON.stringify(settingsFile.overrides) }), ...args.slice(-1)]
    : args
  return [...Object.entries(env ?? {}).map(([key, value]) => `${key}=${shellArg(value)}`), ...[command, ...argv].map(shellArg)].join(' ')
}
