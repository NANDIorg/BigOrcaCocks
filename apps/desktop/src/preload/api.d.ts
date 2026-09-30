import type { OrcaApi } from '../shared/ipc'

declare global {
  interface Window {
    /** Включает опциональную подписку app.onMenuAction на команды системного меню. */
    orca: OrcaApi
  }
}
export {}
