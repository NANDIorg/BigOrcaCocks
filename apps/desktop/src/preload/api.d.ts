import type { OrcaApi } from '../shared/ipc'

declare global {
  interface Window {
    orca: OrcaApi
  }
}
export {}
