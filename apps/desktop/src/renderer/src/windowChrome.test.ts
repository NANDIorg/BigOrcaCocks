import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { initWindowChrome, type WindowControlsOverlay } from './windowChrome'

class Overlay extends EventTarget implements WindowControlsOverlay {
  visible = true
  change(visible: boolean): void {
    this.visible = visible
    this.dispatchEvent(new Event('geometrychange'))
  }
}

function rootSurface() {
  const properties = new Map<string, string>()
  return {
    dataset: {} as DOMStringMap,
    properties,
    style: {
      setProperty(name: string, value: string): void { properties.set(name, value) },
      removeProperty(name: string): string {
        const value = properties.get(name) ?? ''
        properties.delete(name)
        return value
      }
    }
  }
}

describe('компоновка системных кнопок', () => {
  it('Windows включает свой резерв, сохраняет ширину rail и снимает отступы в fullscreen', () => {
    const root = rootSurface()
    const overlay = new Overlay()
    const stop = initWindowChrome('windows', root, overlay)
    assert.equal(root.dataset.windowChrome, 'windows')
    assert.equal(root.dataset.windowControls, 'visible')
    assert.ok(root.properties.has('--windows-chrome-height'))
    assert.equal(root.properties.has('--macos-rail-width'), false)
    overlay.change(false)
    assert.equal(root.dataset.windowControls, 'hidden')
    overlay.change(true)
    assert.equal(root.dataset.windowControls, 'visible')
    stop()
    overlay.change(false)
    assert.deepEqual(root.dataset, {})
    assert.equal(root.properties.size, 0)
  })

  it('Windows использует явное состояние fullscreen, даже когда WCO оставляет visible=true', () => {
    const root = rootSurface()
    const overlay = new Overlay()
    let change: ((fullscreen: boolean) => void) | undefined
    const stop = initWindowChrome('windows', root, overlay, (cb) => {
      change = cb
      return () => { change = undefined }
    })
    change?.(true)
    assert.equal(root.dataset.windowControls, 'hidden')
    overlay.change(true)
    assert.equal(root.dataset.windowControls, 'hidden')
    change?.(false)
    assert.equal(root.dataset.windowControls, 'visible')
    stop()
    assert.equal(change, undefined)
    assert.deepEqual(root.dataset, {})
    assert.equal(root.properties.size, 0)
  })

  it('в fullscreen убирает резерв под кнопки, при возврате восстанавливает его', () => {
    const root = rootSurface()
    const overlay = new Overlay()
    const stop = initWindowChrome('macos', root, overlay)
    assert.equal(root.dataset.windowChrome, 'macos')
    assert.equal(root.dataset.windowControls, 'visible')
    overlay.change(false)
    assert.equal(root.dataset.windowControls, 'hidden')
    overlay.change(true)
    assert.equal(root.dataset.windowControls, 'visible')
    stop()
  })

  it('старый preload и обычное окно не получают новые отступы', () => {
    for (const mode of [undefined, 'system'] as const) {
      const root = rootSurface()
      initWindowChrome(mode, root, new Overlay())()
      assert.deepEqual(root.dataset, {})
      assert.equal(root.properties.size, 0)
    }
  })

  it('без WCO сохраняет резерв для настоящих кнопок, а после HMR отписывается от старого overlay', () => {
    const root = rootSurface()
    const stopFallback = initWindowChrome('macos', root)
    assert.equal(root.dataset.windowControls, 'visible')
    assert.notEqual(root.properties.size, 0)
    stopFallback()
    const overlay = new Overlay()
    const stop = initWindowChrome('macos', root, overlay)
    assert.equal(root.dataset.windowControls, 'visible')
    stop()
    overlay.change(false)
    assert.deepEqual(root.dataset, {})
    assert.equal(root.properties.size, 0)
  })
})
