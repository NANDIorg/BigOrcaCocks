import type React from 'react'
import { useState } from 'react'
import { Icon } from './icons'
import { useT } from './i18n'
import { ipcErrorMessage } from './ipcError'

/** В скрытой рамке Windows Electron не рисует menu bar; команды открываются нативным popup. */
export function WindowMenu(): React.JSX.Element | null {
  const t = useT()
  const [error, setError] = useState<string | null>(null)
  if (window.orca?.app?.windowChrome !== 'windows') return null
  const openMenu = async (): Promise<void> => {
    setError(null)
    const showMenu = window.orca?.app?.showMenu
    if (!showMenu) { setError(t('common.staleApp')); return }
    try { await showMenu() } catch (e) { setError(ipcErrorMessage(e)) }
  }
  return <>
    <button className="icon" type="button" title={t('shell.rail.menu')} aria-label={t('shell.rail.menu')} aria-haspopup="menu" onClick={() => { void openMenu() }}><Icon.menu /></button>
    {error && <div className="window-menu-error" role="alert">{error}</div>}
  </>
}
