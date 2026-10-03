import { runWorkflowServices } from './workflow-services'

export const { isRunScope, startRunWorkflow, advanceRun, finishRunStage, settleIdleRunStages, hasIdleStage, handleRunRequest, acceptRun, returnRun, isRunGate, runGateDecision, isRunDecider, runDecision, escalateDecision, handleRunWorkflowEvents } = runWorkflowServices
export { SUBTASK_MERGE_NODE } from '@orca-board/runtime'
export type { RunWorkflowDeps } from '@orca-board/runtime'
