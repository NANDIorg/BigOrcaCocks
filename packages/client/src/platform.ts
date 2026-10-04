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
  const nativeKeys = {
    app: ['windowChrome', 'testNotification', 'getMenu', 'invokeMenu', 'dismissMenu', 'onWindowFullscreen', 'onMenuAction'],
    projects: ['add', 'detectTaskType', 'onFocus'], taskTypes: ['export'], docs: ['open', 'reveal'], showcase: ['open', 'reveal', 'onFrameEscape'],
    files: ['reveal'], globalTasks: ['revealAttachment', 'openAttachment'], requests: ['onFocus']
  }
  const client: Record<string, unknown> = { ...api }; const platform: Record<string, unknown> = { updates: api.updates }
  for (const [group, keys] of Object.entries(nativeKeys)) {
    const source: unknown = api[group as keyof OrcaApi]
    // Старые preload могут не иметь целой группы: не создаём phantom capability после HMR.
    if (!source || typeof source !== 'object') { client[group] = source; platform[group] = source; continue }
    const entries = Object.entries(source)
    client[group] = Object.fromEntries(entries.filter(([key]) => !keys.includes(key)))
    platform[group] = Object.fromEntries(entries.filter(([key]) => keys.includes(key)))
  }
  delete client.updates
  return { client: client as unknown as LegacyUiClient, platform: platform as unknown as PlatformAdapter }
}
export function composeUiApi(client: LegacyUiClient, platform: PlatformAdapter): OrcaApi {
  const result: Record<string, unknown> = { ...client }
  for (const [group, native] of Object.entries(platform)) {
    const common = result[group]
    result[group] = group === 'updates' ? native : common || native ? { ...(common as object), ...(native as object) } : undefined
  }
  return result as unknown as OrcaApi
}
