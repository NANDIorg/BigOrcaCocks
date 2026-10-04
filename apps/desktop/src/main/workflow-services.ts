import { createWorkflowServices, type WorkflowMessages } from '@orca-board/runtime'
import { executionResources } from './execution-resources'
import { OrcaError, mt } from './i18n'

/** Desktop сохраняет свои error codes, язык UI и русские причины для agent socket. */
export const workflowMessages: WorkflowMessages = {
  error: (key, params) => new OrcaError(key, params),
  text: (key, params) => mt(key, params),
  displayError: error => error instanceof OrcaError ? mt(error.key, error.params)
    : error instanceof Error ? error.message : String(error)
}

export const workflowServices = createWorkflowServices({ resources: executionResources, messages: workflowMessages })
export const reviewServices = workflowServices.review
export const taskWorkflowServices = workflowServices.task
export const runWorkflowServices = workflowServices.run
