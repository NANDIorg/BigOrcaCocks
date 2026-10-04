import { createDocServices } from '@orca-board/runtime'
import { OrcaError, mt } from './i18n'
import { gitProcesses } from './git'

export { DOC_MAX_BYTES, PROJECT_SOURCE, DOCS_STAT_CONCURRENCY, isInside } from '@orca-board/runtime'
export type { DocTask, ProjectFileList } from '@orca-board/runtime'
export const docServices = createDocServices({ messages: { Error: OrcaError, text: mt }, processes: gitProcesses })
export const { resolveDocPath, readDoc, listProjectFiles, listWorktreeDocs, docTasks, docSourceRoot, listDocGroups } = docServices
