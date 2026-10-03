import assert from 'node:assert/strict'
import * as runtime from '../../src/index.ts'

export class OrcaError extends Error {
  readonly key: string
  readonly params: Record<string, unknown>
  constructor(key: string, params: Record<string, unknown> = {}) {
    super(`${key} ${JSON.stringify(params)}`); this.key = key; this.params = params
  }
}
export function fileServices() {
  for (const name of ['createProjectFileServices', 'createDocServices', 'createDocViewServices', 'createShowcaseServices', 'createShowcaseSnapshotServices', 'createPreviewServices', 'createSchemePreviewAddress'] as const) {
    assert.equal(typeof runtime[name], 'function', name)
  }
  const messages = { Error: OrcaError, text: () => 'Проект' }
  const git = runtime.createGitOperations({ error: (key, params) => new OrcaError(key, params), untrackedLabel: () => 'untracked' })
  const projectFiles = runtime.createProjectFileServices({ messages, gitCheckIgnore: git.gitCheckIgnore })
  const preview = runtime.createPreviewServices(runtime.createSchemePreviewAddress('orca-preview'))
  const docs = runtime.createDocServices({ messages })
  const view = runtime.createDocViewServices({ messages, files: projectFiles, preview })
  const showcase = runtime.createShowcaseServices({ messages, preview })
  const snapshot = runtime.createShowcaseSnapshotServices()
  return { projectFiles, preview, docs, view, showcase, snapshot }
}
export const PreviewTokens = runtime.PreviewTokens
export type PreviewTokens = InstanceType<typeof runtime.PreviewTokens>
export const DOC_MAX_BYTES = 2 * 1024 * 1024
export const PROJECT_SOURCE = 'project'
export const PROJECT_FILES_IGNORE_INPUT_LIMIT = 20_000
export const PROJECT_FILES_OS_NOISE = ['.ds_store', 'thumbs.db', 'desktop.ini']
export const PROJECT_FILES_FALLBACK_HIDDEN = ['node_modules']
export const PREVIEW_TOKEN_LIMIT = 100
export const PREVIEW_SCHEME = 'orca-preview'
export const { removeShowcaseDir, showcaseSnapshotDir } = runtime
export const gitCheckIgnore = runtime.createGitOperations({ error: (key, params) => new OrcaError(key, params), untrackedLabel: () => 'untracked' }).gitCheckIgnore
export const splitSafeSegments = (...args: Parameters<ReturnType<typeof fileServices>['projectFiles']['splitSafeSegments']>) => fileServices().projectFiles.splitSafeSegments(...args)
export const resolveProjectPath = (...args: Parameters<ReturnType<typeof fileServices>['projectFiles']['resolveProjectPath']>) => fileServices().projectFiles.resolveProjectPath(...args)
export const listProjectDir = (...args: Parameters<ReturnType<typeof fileServices>['projectFiles']['listProjectDir']>) => fileServices().projectFiles.listProjectDir(...args)
export const resolveDocPath = (...args: Parameters<ReturnType<typeof fileServices>['docs']['resolveDocPath']>) => fileServices().docs.resolveDocPath(...args)
export const readDoc = (...args: Parameters<ReturnType<typeof fileServices>['docs']['readDoc']>) => fileServices().docs.readDoc(...args)
export const listProjectFiles = (...args: Parameters<ReturnType<typeof fileServices>['docs']['listProjectFiles']>) => fileServices().docs.listProjectFiles(...args)
export const listWorktreeDocs = (...args: Parameters<ReturnType<typeof fileServices>['docs']['listWorktreeDocs']>) => fileServices().docs.listWorktreeDocs(...args)
export const docTasks = (...args: Parameters<ReturnType<typeof fileServices>['docs']['docTasks']>) => fileServices().docs.docTasks(...args)
export const docSourceRoot = (...args: Parameters<ReturnType<typeof fileServices>['docs']['docSourceRoot']>) => fileServices().docs.docSourceRoot(...args)
export const listDocGroups = (...args: Parameters<ReturnType<typeof fileServices>['docs']['listDocGroups']>) => fileServices().docs.listDocGroups(...args)
export const resolveDocFile = (...args: Parameters<ReturnType<typeof fileServices>['view']['resolveDocFile']>) => fileServices().view.resolveDocFile(...args)
export const viewDoc = (...args: Parameters<ReturnType<typeof fileServices>['view']['viewDoc']>) => fileServices().view.viewDoc(...args)
export const viewResolved = (...args: Parameters<ReturnType<typeof fileServices>['view']['viewResolved']>) => fileServices().view.viewResolved(...args)
export const readDocBytes = (...args: Parameters<ReturnType<typeof fileServices>['view']['readDocBytes']>) => fileServices().view.readDocBytes(...args)
export const docsPreviewUrl = (...args: Parameters<ReturnType<typeof fileServices>['view']['docsPreviewUrl']>) => fileServices().view.docsPreviewUrl(...args)
export const docsOpenPath = (...args: Parameters<ReturnType<typeof fileServices>['view']['docsOpenPath']>) => fileServices().view.docsOpenPath(...args)
export const docsRevealPath = (...args: Parameters<ReturnType<typeof fileServices>['view']['docsRevealPath']>) => fileServices().view.docsRevealPath(...args)
export const sniffText = (...args: Parameters<ReturnType<typeof fileServices>['view']['sniffText']>) => fileServices().view.sniffText(...args)
export const showcaseRoot = (...args: Parameters<ReturnType<typeof fileServices>['showcase']['showcaseRoot']>) => fileServices().showcase.showcaseRoot(...args)
export const showcaseSource = (...args: Parameters<ReturnType<typeof fileServices>['showcase']['showcaseSource']>) => fileServices().showcase.showcaseSource(...args)
export const snapshotRoot = (...args: Parameters<ReturnType<typeof fileServices>['showcase']['snapshotRoot']>) => fileServices().showcase.snapshotRoot(...args)
export const resolveShowcasePath = (...args: Parameters<ReturnType<typeof fileServices>['showcase']['resolveShowcasePath']>) => fileServices().showcase.resolveShowcasePath(...args)
export const readShowcaseFile = (...args: Parameters<ReturnType<typeof fileServices>['showcase']['readShowcaseFile']>) => fileServices().showcase.readShowcaseFile(...args)
export const showcasePreviewUrl = (...args: Parameters<ReturnType<typeof fileServices>['showcase']['showcasePreviewUrl']>) => fileServices().showcase.showcasePreviewUrl(...args)
export const showcasePreviewBase = (...args: Parameters<ReturnType<typeof fileServices>['showcase']['showcasePreviewBase']>) => fileServices().showcase.showcasePreviewBase(...args)
export const planShowcaseSnapshot = (...args: Parameters<ReturnType<typeof fileServices>['snapshot']['planShowcaseSnapshot']>) => fileServices().snapshot.planShowcaseSnapshot(...args)
export const writeShowcaseSnapshot = (...args: Parameters<ReturnType<typeof fileServices>['snapshot']['writeShowcaseSnapshot']>) => fileServices().snapshot.writeShowcaseSnapshot(...args)
export const snapshotDispatchShowcase = (...args: Parameters<ReturnType<typeof fileServices>['snapshot']['snapshotDispatchShowcase']>) => fileServices().snapshot.snapshotDispatchShowcase(...args)
export const markdownRefs = (...args: Parameters<ReturnType<typeof fileServices>['snapshot']['markdownRefs']>) => fileServices().snapshot.markdownRefs(...args)
export const previewBase = (...args: Parameters<ReturnType<typeof fileServices>['preview']['previewBase']>) => fileServices().preview.previewBase(...args)
export const previewUrlFor = (...args: Parameters<ReturnType<typeof fileServices>['preview']['previewUrlFor']>) => fileServices().preview.previewUrlFor(...args)
export const previewSegments = (...args: Parameters<ReturnType<typeof fileServices>['preview']['previewSegments']>) => fileServices().preview.previewSegments(...args)
export const buildPreviewCsp = (...args: Parameters<ReturnType<typeof fileServices>['preview']['buildPreviewCsp']>) => fileServices().preview.buildPreviewCsp(...args)
export const previewHeaders = (...args: Parameters<ReturnType<typeof fileServices>['preview']['previewHeaders']>) => fileServices().preview.previewHeaders(...args)
export const resolvePreviewRequest = (...args: Parameters<ReturnType<typeof fileServices>['preview']['resolvePreviewRequest']>) => fileServices().preview.resolvePreviewRequest(...args)
export const handlePreviewRequest = (...args: Parameters<ReturnType<typeof fileServices>['preview']['handlePreviewRequest']>) => fileServices().preview.handlePreviewRequest(...args)
export const parseRange = (...args: Parameters<ReturnType<typeof fileServices>['preview']['parseRange']>) => fileServices().preview.parseRange(...args)
export const allowFrameNavigation = (...args: Parameters<ReturnType<typeof fileServices>['preview']['allowFrameNavigation']>) => fileServices().preview.allowFrameNavigation(...args)
export const isExternalWebUrl = (...args: Parameters<ReturnType<typeof fileServices>['preview']['isExternalWebUrl']>) => fileServices().preview.isExternalWebUrl(...args)
