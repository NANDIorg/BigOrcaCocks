import type { BrowserWindowConstructorOptions } from 'electron'
import { MACOS_WINDOW_CHROME_ARGUMENT, macosWindowChrome } from '../shared/window-chrome'

/** Обычная рамка на других ОС; на Mac AppKit оставляет настоящие кнопки над renderer. */
export function mainWindowChrome(platform: string): BrowserWindowConstructorOptions {
  if (platform !== 'darwin') return {}
  return {
    titleBarStyle: 'hidden',
    trafficLightPosition: { ...macosWindowChrome.trafficLightPosition },
    titleBarOverlay: { height: macosWindowChrome.height },
    webPreferences: { additionalArguments: [MACOS_WINDOW_CHROME_ARGUMENT] }
  }
}
