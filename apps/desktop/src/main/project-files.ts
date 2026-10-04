import { createProjectFileServices } from '@orca-board/runtime'
import { OrcaError } from './i18n'
import { gitCheckIgnore } from './git'

export { PROJECT_FILES_OS_NOISE, PROJECT_FILES_FALLBACK_HIDDEN, PROJECT_FILES_IGNORE_INPUT_LIMIT } from '@orca-board/runtime'
export const projectFileServices = createProjectFileServices({ messages: { Error: OrcaError }, gitCheckIgnore })
export const { splitSafeSegments, resolveProjectPath, listProjectDir } = projectFileServices
