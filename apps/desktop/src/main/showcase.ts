import { createShowcaseServices } from '@orca-board/runtime'
import { OrcaError } from './i18n'
import { previewServices } from './preview-protocol'

export const showcaseServices = createShowcaseServices({ messages: { Error: OrcaError }, preview: previewServices })
export const { showcaseRoot, showcaseSource, snapshotRoot, resolveShowcasePath, readShowcaseFile, showcasePreviewUrl, showcasePreviewBase } = showcaseServices
