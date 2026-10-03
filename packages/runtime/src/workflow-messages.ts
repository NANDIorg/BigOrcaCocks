/** Коды общих исполнителей; перевод и класс ошибки задаёт host. */
export type WorkflowErrorKey =
  | 'review.noBranch'
  | 'review.notReviewable'
  | 'review.stageBlocked'
  | 'git.noCommits'
  | 'git.mergeTargetMissing'
  | 'request.alreadyCancelled'
  | 'request.alreadyResolved'
  | 'global.approvalAmbiguous'

export type WorkflowTextKey = 'runApproval.acceptHint' | 'runApproval.acceptHintLane' | 'runApproval.laneTitle'
export type WorkflowMessageParams = Record<string, string | number>

export interface WorkflowMessages {
  error(key: WorkflowErrorKey, params?: WorkflowMessageParams): Error
  text(key: WorkflowTextKey, params?: WorkflowMessageParams): string
  /** UI получает перевод; исходная причина ошибки отдельно сохраняется в журнале. */
  displayError(error: unknown): string
}
