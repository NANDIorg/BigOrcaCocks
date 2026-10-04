import { parseLaunchExtraArgs, type ExtraArgsMessage } from '@orca-board/runtime'
import { OrcaError, type MText } from './i18n'
import { executionResources } from './execution-resources'
export { extraArgsReason, extraArgsProblem, withoutExtraArgs } from '@orca-board/runtime'

/** Сохранённый callback Desktop локализует nested reason тем же OrcaError. */
export function launchExtraArgs(text: string | undefined, error: (reason: MText) => MText): string[] {
  return parseLaunchExtraArgs(text, (reason: ExtraArgsMessage) => OrcaError.of(error(reason)))
}
export const roleLaunchExtraArgs = executionResources.roleLaunchExtraArgs
