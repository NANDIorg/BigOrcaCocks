import { BrowserWindow, shell } from 'electron'
import { readFileSync } from 'node:fs'
import { aboutExternalUrl, buildAboutHtml } from './about-content'
import { mainLocale, mt, type MainLocale } from './i18n'
import { getAppTheme } from '../shared/theme'
import { normalizeAppearance, type AppearanceSettings } from '../shared/appearance'

interface AboutWindowOptions {
  parent: BrowserWindow
  iconPath: string
  version: string
  appearance?: AppearanceSettings
}

let window: BrowserWindow | null = null
let content: AboutWindowOptions | null = null
let displayedLocale: MainLocale | null = null
let displayedAppearance = ''

function loadContent(created: BrowserWindow, options: AboutWindowOptions): void {
  displayedLocale = mainLocale()
  const appearance = normalizeAppearance(options.appearance)
  displayedAppearance = JSON.stringify(appearance)
  created.setBackgroundColor(getAppTheme(appearance.theme).colors.page)
  const html = buildAboutHtml({ locale: displayedLocale, version: options.version, iconPng: readFileSync(options.iconPath), appearance })
  created.setTitle(mt('menu.about'))
  void created.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
}

function openProjectLink(url: string): void {
  const allowed = aboutExternalUrl(url)
  if (allowed) void shell.openExternal(allowed)
}

/** Одно дочернее окно с настоящими controls ОС; повторный пункт меню только возвращает фокус. */
export function showAboutWindow(options: AboutWindowOptions): BrowserWindow {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore()
    if (!window.webContents.isLoading()) window.show()
    window.focus()
    return window
  }
  const created = new BrowserWindow({
    parent: options.parent,
    width: 480,
    height: 490,
    useContentSize: true,
    show: false,
    title: mt('menu.about'),
    icon: options.iconPath,
    backgroundColor: getAppTheme(options.appearance?.theme).colors.page,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    minimizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      disableDialogs: true,
      devTools: false
    }
  })
  window = created
  content = options
  if (process.platform !== 'darwin') created.setMenu(null)
  // About не держит приложение открытым после закрытия основного окна и не переживает своего владельца.
  const closeWithParent = (): void => { if (!created.isDestroyed()) created.close() }
  options.parent.once('closed', closeWithParent)
  created.on('closed', () => {
    options.parent.removeListener('closed', closeWithParent)
    if (window === created) { window = null; content = null; displayedLocale = null }
    if (!options.parent.isDestroyed() && options.parent.isVisible()) options.parent.focus()
  })
  created.once('ready-to-show', () => { created.show(); created.focus() })
  created.webContents.setWindowOpenHandler(({ url }) => {
    openProjectLink(url)
    return { action: 'deny' }
  })
  created.webContents.on('will-frame-navigate', (event) => {
    event.preventDefault()
    if (event.isMainFrame) openProjectLink(event.url)
  })
  created.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && !input.isComposing && (input.key === 'Escape' || (
      input.key.toLowerCase() === 'w' && (process.platform === 'darwin' ? input.meta : input.control)
    ))) {
      event.preventDefault()
      created.close()
    }
  })
  loadContent(created, options)
  return created
}

/** Меняем уже открытое содержимое вместе с языком меню, включая настройки через CLI. */
export function refreshAboutWindow(appearance?: AppearanceSettings): void {
  if (!window || window.isDestroyed() || !content) return
  content = { ...content, appearance }
  if (displayedLocale !== mainLocale() || displayedAppearance !== JSON.stringify(normalizeAppearance(appearance))) loadContent(window, content)
}
