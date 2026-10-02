import { createAgentLauncher } from '@orca-board/runtime'
import { OrcaError } from './i18n'

const launcher = createAgentLauncher({
  settingsInvalid: path => OrcaError.of({ key: 'agentLaunch.settingsInvalid', params: { path } })
})
// Main может завершиться раньше PTY onExit: синхронный cleanup остаётся обязанностью хоста.
process.once('exit', launcher.dispose)

export const launchAgent = launcher.launchAgent
