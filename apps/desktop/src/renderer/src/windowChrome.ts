import { macosWindowChrome, type WindowChromeMode } from '../../shared/window-chrome'

export interface WindowControlsOverlay extends EventTarget {
  readonly visible: boolean
}

interface ChromeRoot {
  dataset: DOMStringMap
  style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'>
}

/** Геометрия WCO уже учитывает zoom Chromium; fullscreen убирает только верхний резерв. */
export function initWindowChrome(mode: WindowChromeMode | undefined, root: ChromeRoot, overlay?: WindowControlsOverlay): () => void {
  if (mode !== 'macos') return () => {}
  root.dataset.windowChrome = mode
  root.style.setProperty('--macos-rail-width', `${macosWindowChrome.railWidth}px`)
  root.style.setProperty('--macos-chrome-height', `${macosWindowChrome.height}px`)
  const update = (): void => {
    root.dataset.windowControls = overlay?.visible === false ? 'hidden' : 'visible'
  }
  update()
  overlay?.addEventListener('geometrychange', update)
  return () => {
    overlay?.removeEventListener('geometrychange', update)
    delete root.dataset.windowChrome
    delete root.dataset.windowControls
    root.style.removeProperty('--macos-rail-width')
    root.style.removeProperty('--macos-chrome-height')
  }
}
