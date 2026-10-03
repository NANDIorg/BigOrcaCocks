import { createExecutionResources } from '@orca-board/runtime'
import * as git from './git'
import { OrcaError } from './i18n'

/** Совместимый Desktop host: общие ресурсы сохраняют IPC codes и прежний класс ошибок. */
export const executionResources = createExecutionResources({
  messages: { error: (key, params) => new OrcaError(key, params) },
  git,
  logger: { warn: (message, detail) => { console.error(message, ...(detail === undefined ? [] : [detail])) } }
})
