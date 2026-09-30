import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mainWindowChrome } from './window-chrome'
import { windowChromeMode } from '../shared/window-chrome'

describe('оболочка главного окна', () => {
  it('macOS оставляет системные кнопки поверх содержимого и сообщает preload об этом режиме', () => {
    const options = mainWindowChrome('darwin')
    assert.equal(options.titleBarStyle, 'hidden')
    assert.ok(options.titleBarOverlay)
    assert.ok(options.trafficLightPosition)
    assert.equal(windowChromeMode('darwin', options.webPreferences?.additionalArguments ?? []), 'macos')
  })

  it('Windows и Linux сохраняют системный заголовок', () => {
    for (const platform of ['win32', 'linux']) {
      assert.deepEqual(mainWindowChrome(platform), {})
    }
  })

  it('старый main и чужая платформа не включают macOS-компоновку в новом preload', () => {
    assert.equal(windowChromeMode('darwin', []), 'system')
    const argumentsForMac = mainWindowChrome('darwin').webPreferences?.additionalArguments ?? []
    assert.equal(windowChromeMode('linux', argumentsForMac), 'system')
    assert.equal(windowChromeMode('win32', argumentsForMac), 'system')
  })
})
