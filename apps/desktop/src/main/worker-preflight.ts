import { createWorkerPreflight } from '@orca-board/runtime'
import { assertAgentUsable } from './agents'
import { executionResources } from './execution-resources'
import { OrcaError } from './i18n'

/** Desktop сохраняет свои ошибки и adapters; порядок проверок задаёт общий runtime. */
const preflight = createWorkerPreflight({
  selection: { assertAgentUsable },
  launchPolicy: executionResources,
  messages: { error: (key, params) => new OrcaError(key, params) }
})
export const validateWorkerRole = preflight.validate
