import type { OrcaApi } from '../shared/ipc'

declare global {
  interface Window {
    /** Общий контракт включает assistantChat.sendWithWorkflow, workflowAssistant.save/onSaved и taskTypes.patch/rename;
     * новые методы проверяются перед вызовом после HMR; его версия проверяется снимком.
     * app.onMenuAction, app.getMenu, app.invokeMenu, app.dismissMenu, app.onWindowFullscreen и read-only app.windowChrome опциональны для старого preload. */
    orca: OrcaApi
  }
}
export {}
