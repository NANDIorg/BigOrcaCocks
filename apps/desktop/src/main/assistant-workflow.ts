import { createWorkflowAssistantServices } from '@orca-board/runtime'
import { OrcaError } from './i18n'

export const { saveWorkflowDraft, buildWorkflowAssistantContext } = createWorkflowAssistantServices({ messages: { Error: OrcaError } })
