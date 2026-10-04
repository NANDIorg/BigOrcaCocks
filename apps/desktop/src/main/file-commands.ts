import type { DocViewOptions, FileCommands, ShowcasePreviewOptions } from '@orca-board/contracts'
import { createDesktopProjectCommandAdapter, type DesktopCommandHandle, type DesktopProjectCommandHost } from './project-command-adapter'

export interface DesktopFileCommandHost<Event> extends DesktopProjectCommandHost<Event> { commands: FileCommands }

export function registerDesktopFileCommands<Event>(handle: DesktopCommandHandle<Event>, host: DesktopFileCommandHost<Event>): void {
  const { commands } = host
  const { context, explicit, selected, invoke } = createDesktopProjectCommandAdapter(host)
  handle('docs:list', event => invoke(() => {
    const ctx = selected(event)
    return ctx ? commands.listDocs(ctx) : []
  }))
  handle('docs:read', (event, source: string, path: string) => invoke(() => commands.readDoc(context(event), source, path)))
  handle('docs:view', (event, source: string, path: string, options?: DocViewOptions | null) => invoke(() => commands.viewDoc(context(event), source, path, options ?? undefined)))
  handle('docs:bytes', (event, source: string, path: string) => invoke(() => commands.docBytes(context(event), source, path)))
  handle('docs:previewUrl', (event, source: string, path: string) => invoke(() => commands.docPreview(context(event), source, path)))
  handle('docs:open', (event, source: string, path: string) => invoke(() => commands.openDoc(context(event), source, path)))
  handle('docs:reveal', (event, source: string, path: string) => invoke(() => commands.revealDoc(context(event), source, path)))
  handle('showcase:read', (event, taskId: string, path: string, dispatchId?: string | null) => invoke(() => commands.readShowcase(context(event), taskId, path, dispatchId)))
  handle('showcase:open', (event, taskId: string, path: string, dispatchId?: string | null) => invoke(() => commands.openShowcase(context(event), taskId, path, dispatchId)))
  handle('showcase:reveal', (event, taskId: string, path: string, dispatchId?: string | null) => invoke(() => commands.revealShowcase(context(event), taskId, path, dispatchId)))
  handle('showcase:previewUrl', (event, dispatchId: string, path: string, options?: ShowcasePreviewOptions | null) => invoke(() => commands.showcasePreview(context(event), dispatchId, path, options ?? undefined)))
  handle('showcase:previewBase', (event, dispatchId: string) => invoke(() => commands.showcaseBase(context(event), dispatchId)))
  handle('files:list', (event, projectId: unknown, dir?: string | null) => invoke(() => commands.listDir(explicit(event, projectId), dir ?? '')))
  handle('files:reveal', (event, projectId: unknown, path: string) => invoke(() => commands.revealFile(explicit(event, projectId), path)))
}
