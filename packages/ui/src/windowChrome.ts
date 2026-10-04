import { macosWindowChrome, windowsWindowChrome, type WindowChromeMode } from '@orca-board/client/window-chrome'

export interface WindowControlsOverlay extends EventTarget {
  readonly visible: boolean
}

interface ChromeRoot {
  dataset: DOMStringMap
  style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'>
}

/** Геометрия WCO уже учитывает zoom Chromium; fullscreen убирает только верхний резерв. */
export function initWindowChrome(mode: WindowChromeMode | undefined, root: ChromeRoot, overlay?: WindowControlsOverlay,
  onFullscreen?: (cb: (fullscreen: boolean) => void) => () => void): () => void {
  if (mode !== 'macos' && mode !== 'windows') return () => {}
  root.dataset.windowChrome = mode
  if (mode === 'macos') {
    root.style.setProperty('--macos-rail-width', `${macosWindowChrome.railWidth}px`)
    root.style.setProperty('--macos-chrome-height', `${macosWindowChrome.height}px`)
  } else {
    root.style.setProperty('--windows-chrome-height', `${windowsWindowChrome.height}px`)
  }
  let fullscreen = false
  const update = (): void => {
    const hidden = fullscreen || overlay?.visible === false
    root.dataset.windowControls = hidden ? 'hidden' : 'visible'
  }
  update()
  overlay?.addEventListener('geometrychange', update)
  const offFullscreen = mode === 'windows' ? onFullscreen?.((value) => { fullscreen = value; update() }) : undefined
  return () => {
    offFullscreen?.()
    overlay?.removeEventListener('geometrychange', update)
    delete root.dataset.windowChrome
    delete root.dataset.windowControls
    root.style.removeProperty('--macos-rail-width')
    root.style.removeProperty('--macos-chrome-height')
    root.style.removeProperty('--windows-chrome-height')
  }
}
