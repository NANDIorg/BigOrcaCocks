import type { OrcaApi } from '../shared/ipc'

declare global {
  interface Window {
    /** Включает app.onMenuAction и read-only app.windowChrome; оба опциональны для старого preload. */
    orca: OrcaApi
  }
}
export {}
