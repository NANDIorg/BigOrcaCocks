import type { OrcaApi } from '../shared/ipc'

declare global {
  interface Window {
    /** Общий контракт включает двусторонний assistantChat; его версия проверяется снимком.
     * app.onMenuAction, app.getMenu, app.invokeMenu, app.dismissMenu, app.onWindowFullscreen и read-only app.windowChrome опциональны для старого preload. */
    orca: OrcaApi
  }
}
export {}
