import { createReviewServices, createTaskWorkflowServices, type WorkflowMessages } from '@orca-board/runtime'
import { executionResources } from './execution-resources'
import { OrcaError, mt } from './i18n'

/** Desktop сохраняет свои error codes, язык UI и русские причины для agent socket. */
export const workflowMessages: WorkflowMessages = {
  error: (key, params) => new OrcaError(key, params),
  text: (key, params) => mt(key, params),
  displayError: error => error instanceof OrcaError ? mt(error.key, error.params)
    : error instanceof Error ? error.message : String(error)
}

export const reviewServices = createReviewServices({ resources: executionResources, messages: workflowMessages })
export const taskWorkflowServices = createTaskWorkflowServices({ resources: executionResources, review: reviewServices, messages: workflowMessages })
