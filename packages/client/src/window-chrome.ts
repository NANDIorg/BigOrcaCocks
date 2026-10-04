export type WindowChromeMode = 'system' | 'macos' | 'windows'

/** Одна геометрия для AppKit и CSS; размеры ОС остаются нативными. */
export const macosWindowChrome = {
  height: 52,
  railWidth: 96,
  trafficLightPosition: { x: 18, y: 18 }
} as const

export const MACOS_WINDOW_CHROME_ARGUMENT = '--orca-macos-window-chrome'
export const WINDOWS_WINDOW_CHROME_ARGUMENT = '--orca-windows-window-chrome'

/** Caption-кнопки Windows справа; ширину rail менять не нужно. */
export const windowsWindowChrome = { height: 36 } as const

/** Флаг передаёт main: одна лишь платформа не означает, что заголовок уже интегрирован. */
export function windowChromeMode(platform: string, args: readonly string[]): WindowChromeMode {
  if (platform === 'darwin' && args.includes(MACOS_WINDOW_CHROME_ARGUMENT)) return 'macos'
  if (platform === 'win32' && args.includes(WINDOWS_WINDOW_CHROME_ARGUMENT)) return 'windows'
  return 'system'
}
