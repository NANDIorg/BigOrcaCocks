export type WindowChromeMode = 'system' | 'macos'

/** Одна геометрия для AppKit и CSS; размеры ОС остаются нативными. */
export const macosWindowChrome = {
  height: 52,
  railWidth: 96,
  trafficLightPosition: { x: 18, y: 18 }
} as const

export const MACOS_WINDOW_CHROME_ARGUMENT = '--orca-macos-window-chrome'

/** Флаг передаёт main: один лишь macOS не означает, что заголовок уже интегрирован. */
export function windowChromeMode(platform: string, args: readonly string[]): WindowChromeMode {
  return platform === 'darwin' && args.includes(MACOS_WINDOW_CHROME_ARGUMENT) ? 'macos' : 'system'
}
