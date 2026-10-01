import type { BrowserWindowConstructorOptions, TitleBarOverlay } from 'electron'
import { MACOS_WINDOW_CHROME_ARGUMENT, WINDOWS_WINDOW_CHROME_ARGUMENT, macosWindowChrome, windowsWindowChrome } from '../shared/window-chrome'
import { getAppTheme, type AppTheme } from '../shared/theme'

/** Тот же фон, что у рабочей панели; смена темы обновляет нативный слой без пересоздания окна. */
export function windowsTitleBarOverlay(themeId?: AppTheme, fullscreen = false): TitleBarOverlay {
  const { colors } = getAppTheme(themeId)
  return { height: fullscreen ? 0 : windowsWindowChrome.height, color: colors.frame, symbolColor: colors.text }
}

/** AppKit и Windows сохраняют настоящие кнопки над renderer; Linux — обычную рамку. */
export function mainWindowChrome(platform: string, themeId?: AppTheme): BrowserWindowConstructorOptions {
  if (platform === 'win32') return {
    titleBarStyle: 'hidden',
    titleBarOverlay: windowsTitleBarOverlay(themeId),
    autoHideMenuBar: true,
    webPreferences: { additionalArguments: [WINDOWS_WINDOW_CHROME_ARGUMENT] }
  }
  if (platform !== 'darwin') return {}
  return {
    titleBarStyle: 'hidden',
    trafficLightPosition: { ...macosWindowChrome.trafficLightPosition },
    titleBarOverlay: { height: macosWindowChrome.height },
    webPreferences: { additionalArguments: [MACOS_WINDOW_CHROME_ARGUMENT] }
  }
}
