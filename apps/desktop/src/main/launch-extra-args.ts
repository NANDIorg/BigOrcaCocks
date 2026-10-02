// Флаги пользователя к команде запуска агента (`Role.extraArgs`, `AssistantSettings.extraArgs`) на стороне main:
// текст ошибки разбора на языке интерфейса, разбор перед запуском и вырезание поля из ответов сокета.
// Без electron и PTY — чтобы проверять node:test (worker.ts тянет electron).
import { parseExtraArgs, type ExtraArgsParse, type Role } from '@orca-board/core'
import { OrcaError, type MText } from './i18n'
import { extraArgsReason } from '@orca-board/runtime'
export { extraArgsReason, extraArgsProblem, withoutExtraArgs } from '@orca-board/runtime'

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
