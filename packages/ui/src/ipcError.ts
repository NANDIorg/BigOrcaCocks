// Ошибки invoke из main: обёртка ipcRenderer, имя ошибки и стабильный код (docs/architecture.md → «Язык интерфейса»).
import { t } from './i18n'

const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*/
/** Имя ошибки main: обычное `Error` или `OrcaError[код]` (`ipcError` в main/i18n.ts). */
const ERROR_NAME = /^(?:OrcaError\[([\w.]+)\]|Error):\s*/

/**
 * Сообщение ошибки из main без обёртки ipcRenderer («Error invoking remote method '...': Error: ...»). Ошибки
 * main с кодом приходят как «OrcaError[код]: текст» — текст уже на языке интерфейса, имя с кодом срезается.
 */
export function ipcErrorMessage(e: unknown): string {
  if (e instanceof Error && e.name === 'OrcaClientError') {
    return t(e.message === 'command.stale' ? 'shell.web.stale' : e.message === 'command.forbidden' ? 'shell.web.forbidden' : e.message === 'protocol.capacity' ? 'shell.web.capacity' : e.message === 'web.authRequired' ? 'shell.web.expired' : 'shell.web.error')
  }
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(IPC_WRAPPER, '').replace(ERROR_NAME, '')
}

/**
 * Стабильный код ошибки main (`OrcaError[docs.notFound]` → `docs.notFound`). По нему, а не по тексту, узнают
 * конкретную ошибку: текст переведён на язык интерфейса. Нет кода (старый main, обычная ошибка) — undefined.
 */
export function ipcErrorCode(e: unknown): string | undefined {
  if (e instanceof Error && e.name === 'OrcaClientError') return e.message
  const msg = (e instanceof Error ? e.message : String(e)).replace(IPC_WRAPPER, '')
  return /^OrcaError\[([\w.]+)\]:/.exec(msg)?.[1]
}
