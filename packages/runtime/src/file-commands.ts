import type { FileCommands, FileCommandName } from '@orca-board/contracts'
import { CommandError } from './project-commands.ts'
import { createAsyncProjectCommandExecutor, type AsyncCommandScope, type AsyncProjectCommandHost } from './async-project-commands.ts'
import { commandFields, commandInputError, commandString } from './command-input.ts'
import type { RegisteredProject } from './project-scope.ts'
import type { ProjectFileServices } from './project-files.ts'
import type { DocServices } from './docs.ts'
import type { DocViewServices } from './docs-view.ts'
import type { ShowcaseServices } from './showcase.ts'
import type { ShowcaseSnapshots } from './showcase-snapshot.ts'
import type { PreviewTokens } from './preview.ts'

export interface FileCommandHost extends AsyncProjectCommandHost<RegisteredProject, FileCommandName> {
  files: ProjectFileServices
  docs: DocServices
  view: DocViewServices
  showcase: ShowcaseServices
  tokens: PreviewTokens
  snapshots(projectId: string): ShowcaseSnapshots
  branch(project: RegisteredProject): string | Promise<string>
  native: { open(path: string): void | Promise<void>; reveal(path: string): void | Promise<void> }
}
type Source = { root: string; current(): boolean }

export function createFileCommands(host: FileCommandHost): FileCommands {
  const execute = createAsyncProjectCommandExecutor(host)
  const pathFrom = (raw: unknown, empty = false) => {
    if (typeof raw !== 'string' || (!empty && !raw.length)) commandInputError('path')
    host.files.splitSafeSegments(raw)
    return raw
  }
  const optionsFrom = (raw: unknown, key: 'source' | 'network') => {
    if (raw === undefined) return undefined
    const value = commandFields(raw, [key])
    if (value[key] !== undefined && typeof value[key] !== 'boolean') commandInputError(key)
    return value[key] === undefined ? {} : { [key]: value[key] as boolean }
  }
  const dispatchFrom = (raw: unknown) => raw === undefined || raw === null ? undefined : commandString(raw, 'dispatchId')
  const docSource = (project: RegisteredProject, source: string): Source => {
    const selected = source === 'project' ? undefined : host.docs.docTask(project.store, source)
    const root = host.docs.docSourceRoot(source, project.root, selected ? [selected] : [])
    const task = source === 'project' ? undefined : project.store.getTask(source)
    return { root, current: () => {
      if (source === 'project') return true
      return project.store.getTask(source) === task && host.docs.docTask(project.store, source)?.worktree === root
    } }
  }
  const showcaseSource = (project: RegisteredProject, taskId: string, dispatchId?: string): Source => {
    const root = host.showcase.showcaseSource(project.store, taskId, dispatchId, host.snapshots(project.id))
    const task = project.store.getTask(taskId)
    const selected = dispatchId ?? task?.dispatchId
    const dispatch = selected ? project.store.getDispatch(selected) : undefined
    return { root, current: () => {
      if (project.store.getTask(taskId) !== task || (selected && project.store.getDispatch(selected) !== dispatch)) return false
      if (!dispatchId && task?.dispatchId !== selected) return false
      try { return host.showcase.showcaseSource(project.store, taskId, dispatchId, host.snapshots(project.id)) === root } catch { return false }
    } }
  }
  const check = (scope: AsyncCommandScope, source?: Source) => scope.commit(() => {
    if (source && !source.current()) throw new CommandError('command.stale')
  })
  const read = async <T>(scope: AsyncCommandScope, source: Source | undefined, operation: () => T | Promise<T>): Promise<T> => {
    try { return await operation() } finally { check(scope, source) }
  }
  const doc = <T>(command: FileCommandName, context: unknown, source: unknown, rawPath: unknown,
    operation: (root: string, path: string, scope: AsyncCommandScope, capture: Source) => T | Promise<T>, validate = () => {}) => execute(context, command, () => {
    const id = commandString(source, 'source'); const path = pathFrom(rawPath); validate()
    return (project, _context, scope) => {
      const capture = docSource(project, id)
      return read(scope, capture, () => operation(capture.root, path, scope, capture))
    }
  })
  const show = <T>(command: FileCommandName, context: unknown, taskId: unknown, rawPath: unknown, rawDispatch: unknown,
    operation: (root: string, path: string) => T | Promise<T>) => execute(context, command, () => {
    const id = commandString(taskId, 'taskId'); const path = pathFrom(rawPath); const dispatchId = dispatchFrom(rawDispatch)
    return (project, _context, scope) => {
      const capture = showcaseSource(project, id, dispatchId)
      return read(scope, capture, () => operation(capture.root, path))
    }
  })
  const nativeDoc = (kind: 'open' | 'reveal', context: unknown, source: unknown, path: unknown) => doc(`files.${kind}Doc`, context, source, path,
    async (root, path, scope, capture) => {
      const target = await (kind === 'open' ? host.view.docsOpenPath(root, path) : host.view.docsRevealPath(root, path))
      check(scope, capture)
      await scope.commit(() => host.native[kind](target))
    })
  const nativeShowcase = (kind: 'open' | 'reveal', context: unknown, taskId: unknown, path: unknown, dispatchId: unknown) => execute(context, `files.${kind}Showcase`, () => {
    const id = commandString(taskId, 'taskId'); const rel = pathFrom(path); const dispatch = dispatchFrom(dispatchId)
    return (project, _context, scope) => {
      const capture = showcaseSource(project, id, dispatch)
      const target = host.showcase.resolveShowcasePath(capture.root, rel)
      return read(scope, capture, () => {
        check(scope, capture)
        return scope.commit(() => host.native[kind](target))
      })
    }
  })
  return {
    listDir: (context, dir = '') => execute(context, 'files.listDir', () => {
      const path = pathFrom(dir, true)
      return (project, _context, scope) => read(scope, undefined, () => host.files.listProjectDir(project.root, path))
    }),
    listDocs: context => execute(context, 'files.listDocs', () => async (project, _context, scope) => {
      const tasks = host.docs.docTasks(project.store)
      const captures = tasks.map(task => docSource(project, task.id))
      const source: Source = { root: project.root, current: () => captures.every(value => value.current()) }
      return read(scope, source, async () => {
        const branch = await host.branch(project); check(scope, source)
        return host.docs.listDocGroups(project.root, branch, tasks)
      })
    }),
    readDoc: (context, source, path) => doc('files.readDoc', context, source, path, (root, path) => host.docs.readDoc(root, path)),
    viewDoc: (context, source, path, options) => {
      let value: ReturnType<typeof optionsFrom>
      return doc('files.viewDoc', context, source, path, (root, path) => host.view.viewDoc(root, path, value), () => { value = optionsFrom(options, 'source') })
    },
    docBytes: (context, source, path) => doc('files.docBytes', context, source, path, (root, path) => host.view.readDocBytes(root, path)),
    docPreview: (context, source, path) => doc('files.docPreview', context, source, path,
      (root, path, scope, capture) => host.view.docsPreviewUrl(host.tokens, root, path, () => {
        check(scope, capture); return scope.commit(() => host.tokens.issue(root, false))
      })),
    openDoc: (context, source, path) => nativeDoc('open', context, source, path),
    revealDoc: (context, source, path) => nativeDoc('reveal', context, source, path),
    revealFile: (context, path) => execute(context, 'files.revealFile', () => {
      const rel = pathFrom(path, true)
      return (project, _context, scope) => read(scope, undefined, async () => {
        const target = await host.files.resolveProjectPath(project.root, rel, false)
        await scope.commit(() => host.native.reveal(target))
      })
    }),
    readShowcase: (context, taskId, path, dispatchId) => show('files.readShowcase', context, taskId, path, dispatchId, (root, path) => host.showcase.readShowcaseFile(root, path)),
    showcasePreview: (context, dispatchId, path, options) => execute(context, 'files.showcasePreview', () => {
      const id = commandString(dispatchId, 'dispatchId'); const rel = pathFrom(path); const value = optionsFrom(options, 'network')
      return (project, _context, scope) => {
        const dispatch = project.store.getDispatch(id)
        // Service сохраняет прежний dispatchNotFound и порядок domain guards.
        const capture = dispatch ? showcaseSource(project, dispatch.taskId, id) : undefined
        const result = scope.commit(() => host.showcase.showcasePreviewUrl(project.store, host.tokens, id, rel, value, host.snapshots(project.id)))
        return read(scope, capture, () => result)
      }
    }),
    showcaseBase: (context, dispatchId) => execute(context, 'files.showcaseBase', () => {
      const id = commandString(dispatchId, 'dispatchId')
      return (project, _context, scope) => {
        const dispatch = project.store.getDispatch(id)
        const task = dispatch ? project.store.getTask(dispatch.taskId) : undefined
        const rootOf = () => {
          if (!dispatch) return undefined
          try { return host.showcase.showcaseSource(project.store, dispatch.taskId, id, host.snapshots(project.id)) } catch { return undefined }
        }
        const root = rootOf()
        const capture: Source = { root: root ?? '', current: () => project.store.getDispatch(id) === dispatch
          && (!task || project.store.getTask(task.id) === task) && rootOf() === root }
        const result = scope.commit(() => host.showcase.showcasePreviewBase(project.store, host.tokens, id, host.snapshots(project.id)))
        return read(scope, capture, () => result)
      }
    }),
    openShowcase: (context, taskId, path, dispatchId) => nativeShowcase('open', context, taskId, path, dispatchId),
    revealShowcase: (context, taskId, path, dispatchId) => nativeShowcase('reveal', context, taskId, path, dispatchId)
  }
}
