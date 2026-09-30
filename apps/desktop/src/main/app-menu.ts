import type { MenuItemConstructorOptions } from 'electron'
import type { AppMenuAction } from '../shared/ipc'
import { mt } from './i18n'

export const PROJECT_URL = 'https://github.com/NANDIorg/BigOrcaCocks'

export interface AppMenuHandlers {
  navigate(action: AppMenuAction): void
  about(): void
  open(): void
  quit(): void
  openExternal(url: string): void
}

export function applicationMenuTemplate(platform: NodeJS.Platform, development: boolean, handlers: AppMenuHandlers): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin'
  const separator: MenuItemConstructorOptions = { type: 'separator' }
  const about: MenuItemConstructorOptions = { id: 'about', label: mt('menu.about'), click: () => handlers.about() }
  const settings: MenuItemConstructorOptions = {
    id: 'settings', label: mt('menu.settings'), accelerator: 'CmdOrCtrl+,', click: () => handlers.navigate('settings')
  }
  const updates: MenuItemConstructorOptions = {
    id: 'check-updates', label: mt('menu.checkUpdates'), click: () => handlers.navigate('checkUpdates')
  }
  // У role=quit macOS игнорирует click: выход должен идти через общую проверку живых воркеров.
  const quit: MenuItemConstructorOptions = {
    id: 'quit', label: mt('menu.quit'), accelerator: 'CmdOrCtrl+Q', click: () => handlers.quit()
  }
  const menu: MenuItemConstructorOptions[] = []
  if (mac) menu.push({
    label: 'orca-board',
    submenu: [
      about, updates, separator, settings, separator,
      { role: 'services', label: mt('menu.services') }, separator,
      { role: 'hide', label: mt('menu.hide') },
      { role: 'hideOthers', label: mt('menu.hideOthers') },
      { role: 'unhide', label: mt('menu.unhide') }, separator, quit
    ]
  })
  menu.push(
    {
      id: 'file-menu', label: mt('menu.file'), submenu: [
        { id: 'add-project', label: mt('menu.addProject'), accelerator: 'CmdOrCtrl+O', click: () => handlers.navigate('addProject') },
        ...(!mac ? [separator, settings, updates] : []), separator,
        { role: 'close', label: mt('menu.close') }, ...(!mac ? [separator, quit] : [])
      ]
    },
    {
      label: mt('menu.edit'), submenu: [
        { role: 'undo', label: mt('menu.undo') }, { role: 'redo', label: mt('menu.redo') }, separator,
        { role: 'cut', label: mt('menu.cut') }, { role: 'copy', label: mt('menu.copy') },
        { role: 'paste', label: mt('menu.paste') }, { role: 'selectAll', label: mt('menu.selectAll') }
      ]
    },
    {
      label: mt('menu.view'), submenu: [
        { role: 'resetZoom', label: mt('menu.resetZoom') },
        { role: 'zoomIn', label: mt('menu.zoomIn') }, { role: 'zoomOut', label: mt('menu.zoomOut') }, separator,
        { role: 'togglefullscreen', label: mt('menu.fullscreen') },
        ...(development ? [separator,
          { role: 'reload' as const, label: mt('menu.reload') },
          { role: 'toggleDevTools' as const, label: mt('menu.devTools') }
        ] : [])
      ]
    },
    {
      role: 'windowMenu', label: mt('menu.window'), submenu: [
        { id: 'show-window', label: mt('menu.showWindow'), click: () => handlers.open() }, separator,
        { role: 'minimize', label: mt('menu.minimize') },
        ...(mac ? [{ role: 'zoom' as const, label: mt('menu.zoom') }, separator, { role: 'front' as const, label: mt('menu.front') }] : [])
      ]
    },
    {
      role: 'help', label: mt('menu.help'), submenu: [
        { id: 'guide', label: mt('menu.guide'), click: () => handlers.openExternal(`${PROJECT_URL}#readme`) },
        { id: 'releases', label: mt('menu.releases'), click: () => handlers.openExternal(`${PROJECT_URL}/releases`) },
        separator,
        { id: 'report-issue', label: mt('menu.reportIssue'), click: () => handlers.openExternal(`${PROJECT_URL}/issues/new`) },
        ...(!mac ? [separator, about] : [])
      ]
    }
  )
  return menu
}

/** Команда из фонового режима ждёт React-подписки, а не только did-finish-load. */
export class MenuActionQueue {
  private ready = false
  private pending: AppMenuAction | null = null

  request(action: AppMenuAction): AppMenuAction | null {
    if (this.ready) return action
    this.pending = action
    return null
  }

  connect(): AppMenuAction | null {
    this.ready = true
    const action = this.pending
    this.pending = null
    return action
  }

  disconnect(): void { this.ready = false }
  clear(): void { this.ready = false; this.pending = null }
}
