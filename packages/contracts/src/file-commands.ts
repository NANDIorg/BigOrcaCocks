import type { ProjectCommandContext } from './project-commands.ts'
import type { DocBytes, DocGroup, DocPreviewUrl, DocView, DocViewOptions, ProjectFilesListing,
  ShowcaseFileData, ShowcasePreviewOptions, ShowcasePreviewUrl } from './files.ts'

/** Пути только относительно разрешённого source; native paths остаются внутри trusted host. */
export interface FileCommands {
  listDir(context: ProjectCommandContext, dir?: string): Promise<ProjectFilesListing>
  listDocs(context: ProjectCommandContext): Promise<DocGroup[]>
  readDoc(context: ProjectCommandContext, source: string, path: string): Promise<string>
  viewDoc(context: ProjectCommandContext, source: string, path: string, options?: DocViewOptions): Promise<DocView>
  docBytes(context: ProjectCommandContext, source: string, path: string): Promise<DocBytes>
  docPreview(context: ProjectCommandContext, source: string, path: string): Promise<DocPreviewUrl>
  openDoc(context: ProjectCommandContext, source: string, path: string): Promise<void>
  revealDoc(context: ProjectCommandContext, source: string, path: string): Promise<void>
  revealFile(context: ProjectCommandContext, path: string): Promise<void>
  readShowcase(context: ProjectCommandContext, taskId: string, path: string, dispatchId?: string | null): Promise<ShowcaseFileData>
  showcasePreview(context: ProjectCommandContext, dispatchId: string, path: string, options?: ShowcasePreviewOptions): Promise<ShowcasePreviewUrl>
  showcaseBase(context: ProjectCommandContext, dispatchId: string): Promise<string | null>
  openShowcase(context: ProjectCommandContext, taskId: string, path: string, dispatchId?: string | null): Promise<void>
  revealShowcase(context: ProjectCommandContext, taskId: string, path: string, dispatchId?: string | null): Promise<void>
}
export type FileCommandName = `files.${keyof FileCommands}`
