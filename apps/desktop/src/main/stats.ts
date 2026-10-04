import { createStatsServices } from '@orca-board/runtime'
import { OrcaError } from './i18n'

export type { StatsDeps, ProjectStatsDeps, TaskStatsDeps, GlobalTaskStatsDeps } from '@orca-board/runtime'
export const statsServices = createStatsServices({ messages: { Error: OrcaError } })
export const { projectStats, taskStats, globalTaskStats } = statsServices
