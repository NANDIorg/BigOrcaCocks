import type { OrcaApi } from '@orca-board/client/legacy-api'
import { composeUiApi, type LegacyUiClient, type PlatformAdapter } from '@orca-board/client/platform'

let resolve: () => OrcaApi = () => { throw new Error('Orca UI host is not configured') }
let release = { version: '', releaseNotes: '' }
/** Host/test harness задаёт resolver явно; UI не читает window.orca. */
export function setUiApiResolver(resolver: () => OrcaApi): void { resolve = resolver }
export function configureUiHost(host: { client: LegacyUiClient; platform: PlatformAdapter; release?: typeof release }): void {
  const api = composeUiApi(host.client, host.platform); setUiApiResolver(() => api)
  release = host.release ?? { version: '', releaseNotes: '' }
}
export function getUiApi(): OrcaApi { return resolve() }
export function getUiRelease() { return release }
