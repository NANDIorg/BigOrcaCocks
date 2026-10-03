import { createDocViewServices } from '@orca-board/runtime'
import { OrcaError } from './i18n'
import { projectFileServices } from './project-files'
import { previewServices } from './preview-protocol'

export type { DocFileRef } from '@orca-board/runtime'
export const docViewServices = createDocViewServices({ messages: { Error: OrcaError }, files: projectFileServices, preview: previewServices })
export const { resolveDocFile, viewDoc, viewResolved, readDocBytes, docsPreviewUrl, docsOpenPath, docsRevealPath, sniffText } = docViewServices
