import type { BrowserWindow, MenuItemConstructorOptions, WebContents } from 'electron'
import type { AppMenuAction, AppMenuItem } from '../shared/ipc'
import { mt } from './i18n'

export const PROJECT_URL = 'https://github.com/NANDIorg/BigOrcaCocks'

export interface AppMenuHandlers {
  navigate(action: AppMenuAction): void
  about(): void
  open(): void
  quit(): void
  openExternal(url: string): void
}

/** Нативная строка и авторский popup вызывают одни и те же продуктовые действия. */
function applicationMenuCommands(handlers: AppMenuHandlers): Record<string, () => void> {
  return {
    about: () => handlers.about(),
    settings: () => handlers.navigate('settings'),
    'check-updates': () => handlers.navigate('checkUpdates'),
    'add-project': () => handlers.navigate('addProject'),
    'show-window': () => handlers.open(),
    quit: () => handlers.quit(),
    guide: () => handlers.openExternal(`${PROJECT_URL}#readme`),
    releases: () => handlers.openExternal(`${PROJECT_URL}/releases`),
    'report-issue': () => handlers.openExternal(`${PROJECT_URL}/issues/new`)
  }
}

type MenuWindow = Pick<BrowserWindow, 'close' | 'minimize' | 'isFullScreen' | 'setFullScreen'> & {
  webContents: Pick<WebContents, 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'getZoomLevel' | 'setZoomLevel' | 'reload' | 'toggleDevTools'>
}

/** Публичные методы Electron вместо внутреннего MenuItem.click с недокументированной сигнатурой. */
export function windowMenuCommands(window: MenuWindow, handlers: AppMenuHandlers): Record<string, () => void> {
  const contents = window.webContents
  return {
    ...applicationMenuCommands(handlers),
    'role:undo': () => contents.undo(), 'role:redo': () => contents.redo(),
    'role:cut': () => contents.cut(), 'role:copy': () => contents.copy(),
    'role:paste': () => contents.paste(), 'role:selectall': () => contents.selectAll(),
    'role:resetzoom': () => contents.setZoomLevel(0),
    'role:zoomin': () => contents.setZoomLevel(contents.getZoomLevel() + 0.5),
    'role:zoomout': () => contents.setZoomLevel(contents.getZoomLevel() - 0.5),
    'role:togglefullscreen': () => window.setFullScreen(!window.isFullScreen()),
    'role:minimize': () => window.minimize(), 'role:close': () => window.close(),
    'role:reload': () => contents.reload(), 'role:toggledevtools': () => contents.toggleDevTools()
  }
}

interface MenuSourceItem {
  id?: string
  label?: string
  type?: string
  role?: string
  accelerator?: string | null
  enabled?: boolean
  visible?: boolean
  submenu?: readonly MenuSourceItem[] | { items: readonly MenuSourceItem[] }
}

/** Сочетания стандартных ролей Windows, которые Electron не записывает в свойство accelerator. */
const WINDOWS_ROLE_SHORTCUTS: Record<string, string> = {
  undo: 'Ctrl+Z', redo: 'Ctrl+Y', cut: 'Ctrl+X', copy: 'Ctrl+C', paste: 'Ctrl+V', selectall: 'Ctrl+A',
  resetzoom: 'Ctrl+0', zoomin: 'Ctrl++', zoomout: 'Ctrl+-', togglefullscreen: 'F11', close: 'Ctrl+W',
  reload: 'Ctrl+R', toggledevtools: 'Ctrl+Shift+I', minimize: 'Ctrl+M'
}

/** Сериализует и настоящий Electron Menu, и его шаблон для тестов; функции никогда не уходят через IPC. */
export function applicationMenuSnapshot(source: readonly MenuSourceItem[], parent = 'menu', disabled = false): AppMenuItem[] {
  const result: AppMenuItem[] = []
  let separator = false
  source.forEach((entry, index) => {
    if (entry.visible === false) return
    if (entry.type === 'separator') { separator = result.length > 0; return }
    const role = entry.role?.toLowerCase()
    const item: AppMenuItem = { id: entry.id || (role ? `role:${role}` : `${parent}:${index}`), label: entry.label ?? '' }
    if (disabled || entry.enabled === false) item.disabled = true
    if (separator) item.separatorBefore = true
    separator = false
    if (entry.submenu) {
      const children = 'items' in entry.submenu ? entry.submenu.items : entry.submenu
      item.children = applicationMenuSnapshot(children, item.id, item.disabled)
    } else {
      const hint = entry.accelerator?.replace(/CommandOrControl|CmdOrCtrl/g, 'Ctrl') || (role ? WINDOWS_ROLE_SHORTCUTS[role] : undefined)
      if (hint) item.hint = hint
    }
    result.push(item)
  })
  return result
}

/** Вызов только доступного листа актуального меню; существование функции само по себе не разрешает команду. */
export function runApplicationMenuCommand(items: readonly AppMenuItem[], id: unknown, commands: Record<string, () => void>): boolean {
  if (typeof id !== 'string' || !Object.hasOwn(commands, id)) return false
  const allowed = (list: readonly AppMenuItem[]): boolean => list.some((item) =>
    !item.disabled && (item.children ? allowed(item.children) : item.id === id))
  if (!allowed(items)) return false
  commands[id]()
  return true
}

export function applicationMenuTemplate(platform: NodeJS.Platform, development: boolean, handlers: AppMenuHandlers): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin'
  const commands = applicationMenuCommands(handlers)
  const separator: MenuItemConstructorOptions = { type: 'separator' }
  const about: MenuItemConstructorOptions = { id: 'about', label: mt('menu.about'), click: commands.about }
  const settings: MenuItemConstructorOptions = {
    id: 'settings', label: mt('menu.settings'), accelerator: 'CmdOrCtrl+,', click: commands.settings
  }
  const updates: MenuItemConstructorOptions = {
    id: 'check-updates', label: mt('menu.checkUpdates'), click: commands['check-updates']
  }
  // У role=quit macOS игнорирует click: выход должен идти через общую проверку живых воркеров.
  const quit: MenuItemConstructorOptions = {
    id: 'quit', label: mt('menu.quit'), accelerator: 'CmdOrCtrl+Q', click: commands.quit
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
        { id: 'add-project', label: mt('menu.addProject'), accelerator: 'CmdOrCtrl+O', click: commands['add-project'] },
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
        { id: 'show-window', label: mt('menu.showWindow'), click: commands['show-window'] }, separator,
        { role: 'minimize', label: mt('menu.minimize') },
        ...(mac ? [{ role: 'zoom' as const, label: mt('menu.zoom') }, separator, { role: 'front' as const, label: mt('menu.front') }] : [])
      ]
    },
    {
      role: 'help', label: mt('menu.help'), submenu: [
        { id: 'guide', label: mt('menu.guide'), click: commands.guide },
        { id: 'releases', label: mt('menu.releases'), click: commands.releases },
        separator,
        { id: 'report-issue', label: mt('menu.reportIssue'), click: commands['report-issue'] },
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
