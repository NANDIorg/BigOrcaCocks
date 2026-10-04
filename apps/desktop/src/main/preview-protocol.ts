import { createPreviewServices, createSchemePreviewAddress } from '@orca-board/runtime'

export { PreviewTokens, PREVIEW_TOKEN_LIMIT } from '@orca-board/runtime'
export type { PreviewGrant, PreviewRefusal, PreviewResolution } from '@orca-board/runtime'
export const PREVIEW_SCHEME = 'orca-preview'
export const previewServices = createPreviewServices(createSchemePreviewAddress(PREVIEW_SCHEME))
export const { previewBase, previewUrlFor, previewSegments, buildPreviewCsp, previewHeaders,
  resolvePreviewRequest, handlePreviewRequest, parseRange, allowFrameNavigation, isExternalWebUrl } = previewServices
