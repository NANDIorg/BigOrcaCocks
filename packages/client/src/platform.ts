import type { OrcaApi } from './legacy-api.ts'

/** ОС-зависимые действия не являются командами owner/server. Web позже задаст свои adapters. */
export interface PlatformAdapter {
  app: Pick<OrcaApi['app'], 'windowChrome' | 'testNotification' | 'getMenu' | 'invokeMenu' | 'dismissMenu' | 'onWindowFullscreen' | 'onMenuAction'>
  updates: OrcaApi['updates']
  projects: Pick<OrcaApi['projects'], 'add' | 'detectTaskType' | 'onFocus'>
  taskTypes: Pick<OrcaApi['taskTypes'], 'export'>
  docs: Pick<OrcaApi['docs'], 'open' | 'reveal'>
  showcase: Pick<OrcaApi['showcase'], 'open' | 'reveal' | 'onFrameEscape'>
  files: Pick<OrcaApi['files'], 'reveal'>
  globalTasks: Pick<OrcaApi['globalTasks'], 'revealAttachment' | 'openAttachment'>
  requests: Pick<OrcaApi['requests'], 'onFocus'>
}
export type LegacyUiClient = Omit<OrcaApi, keyof PlatformAdapter> & {
  [K in keyof PlatformAdapter as K extends 'updates' ? never : K]: Omit<OrcaApi[K], keyof PlatformAdapter[K]>
}

/** Старый preload остаётся источником совместимости, общие компоненты получают явные ports. */
export function createLegacyBindings(api: OrcaApi): { client: LegacyUiClient; platform: PlatformAdapter } {
  const { windowChrome, testNotification, getMenu, invokeMenu, dismissMenu, onWindowFullscreen, onMenuAction, ...app } = api.app
  const { add, detectTaskType, onFocus: projectFocus, ...projects } = api.projects
  const { export: exportType, ...taskTypes } = api.taskTypes
  const { open: openDoc, reveal: revealDoc, ...docs } = api.docs
  const { open: openShowcase, reveal: revealShowcase, onFrameEscape, ...showcase } = api.showcase
  const { reveal: revealFile, ...files } = api.files
  const { revealAttachment, openAttachment, ...globalTasks } = api.globalTasks
  const { onFocus: requestFocus, ...requests } = api.requests
  return { client: { ...api, app, projects, taskTypes, docs, showcase, files, globalTasks, requests }, platform: {
    app: { windowChrome, testNotification, getMenu, invokeMenu, dismissMenu, onWindowFullscreen, onMenuAction }, updates: api.updates,
    projects: { add, detectTaskType, onFocus: projectFocus }, taskTypes: { export: exportType }, docs: { open: openDoc, reveal: revealDoc },
    showcase: { open: openShowcase, reveal: revealShowcase, onFrameEscape }, files: { reveal: revealFile }, globalTasks: { revealAttachment, openAttachment }, requests: { onFocus: requestFocus }
  } }
}
export function composeUiApi(client: LegacyUiClient, platform: PlatformAdapter): OrcaApi {
  return { ...client, app: { ...client.app, ...platform.app }, updates: platform.updates, projects: { ...client.projects, ...platform.projects },
    taskTypes: { ...client.taskTypes, ...platform.taskTypes }, docs: { ...client.docs, ...platform.docs }, showcase: { ...client.showcase, ...platform.showcase },
    files: { ...client.files, ...platform.files }, globalTasks: { ...client.globalTasks, ...platform.globalTasks }, requests: { ...client.requests, ...platform.requests } }
}
