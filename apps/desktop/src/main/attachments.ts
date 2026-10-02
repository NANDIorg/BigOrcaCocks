import { executionResources } from './execution-resources'

export const { ATTACHMENTS_DIR, attachmentCapabilities, coordinatorObjective, attachmentsRoot, pruneAttachments, writeAttachments, clearStartImages, saveReturnImages, discardReturnImages, imagesReferenced, workerImagesPlace, coordinatorImagesPlace, withReturnImages, stripResolutionImages, hasImageInput, resolveWithImages, rejectWithImages, returnRunWithImages } = executionResources
export type { PtyAlive, ReturnImagesPlace } from '@orca-board/runtime'
