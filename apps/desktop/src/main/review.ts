import { reviewServices } from './workflow-services'

export const { getReview, mergeTaskBranch, acceptReview, resolveHumanRequest } = reviewServices
export type { MergeTargetOf, MergeResult, ResolveOutcome } from '@orca-board/runtime'
