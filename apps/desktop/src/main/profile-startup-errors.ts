import { ProfileOwnershipError } from '@orca-board/runtime'
import type { MText } from './i18n'

/** Startup происходит до чтения настроек: общие codes переводятся host, техническая причина остаётся в логе. */
export function profileStartupMessage(error: unknown): MText {
  if (error instanceof ProfileOwnershipError) {
    switch (error.code) {
      case 'ownership.busy': return { key: 'runtime.profileBusy' }
      case 'ownership.unavailable': return { key: 'runtime.profileUnavailable' }
      case 'ownership.invalid': return { key: 'runtime.profileInvalid' }
      case 'ownership.schemaUnsupported': return { key: 'runtime.profileUnsupported' }
    }
  }
  return { key: 'runtime.startupFailed', params: { error: error instanceof Error ? error.message : String(error) } }
}
