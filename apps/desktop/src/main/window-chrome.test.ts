import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mainWindowChrome, windowsTitleBarOverlay } from './window-chrome'
import { windowChromeMode } from '../shared/window-chrome'
import { APP_THEMES, getAppTheme } from '../shared/theme'

describe('оболочка главного окна', () => {
  it('macOS оставляет системные кнопки поверх содержимого и сообщает preload об этом режиме', () => {
    const options = mainWindowChrome('darwin')
    assert.equal(options.titleBarStyle, 'hidden')
    assert.ok(options.titleBarOverlay)
    assert.ok(options.trafficLightPosition)
    assert.equal(windowChromeMode('darwin', options.webPreferences?.additionalArguments ?? []), 'macos')
  })

  it('Windows убирает заголовок, оставляя настоящие кнопки в цветах каждой темы и без постоянной строки меню', () => {
    for (const themeId of APP_THEMES) {
      const options = mainWindowChrome('win32', themeId)
      const theme = getAppTheme(themeId)
      assert.equal(options.titleBarStyle, 'hidden')
      assert.equal(options.autoHideMenuBar, true)
      assert.equal(options.trafficLightPosition, undefined)
      assert.equal(options.frame, undefined)
      assert.ok(options.titleBarOverlay && typeof options.titleBarOverlay === 'object')
      assert.equal(options.titleBarOverlay.color, theme.colors.frame)
      assert.equal(options.titleBarOverlay.symbolColor, theme.colors.text)
      assert.equal(windowChromeMode('win32', options.webPreferences?.additionalArguments ?? []), 'windows')
    }
  })

  it('Linux сохраняет системный заголовок', () => {
    assert.deepEqual(mainWindowChrome('linux'), {})
  })

  it('fullscreen не оставляет резерв кнопок даже при смене темы, выход восстанавливает его', () => {
    for (const themeId of APP_THEMES) {
      const fullscreen = windowsTitleBarOverlay(themeId, true)
      assert.equal(fullscreen.height, 0)
      assert.equal(fullscreen.color, getAppTheme(themeId).colors.frame)
      assert.ok((windowsTitleBarOverlay(themeId, false).height ?? 0) > 0)
    }
  })

  it('старый main и чужая платформа не включают macOS-компоновку в новом preload', () => {
    assert.equal(windowChromeMode('darwin', []), 'system')
    const argumentsForMac = mainWindowChrome('darwin').webPreferences?.additionalArguments ?? []
    assert.equal(windowChromeMode('linux', argumentsForMac), 'system')
    assert.equal(windowChromeMode('win32', argumentsForMac), 'system')
    assert.equal(windowChromeMode('win32', []), 'system')
    const argumentsForWindows = mainWindowChrome('win32').webPreferences?.additionalArguments ?? []
    assert.equal(windowChromeMode('darwin', argumentsForWindows), 'system')
    assert.equal(windowChromeMode('linux', argumentsForWindows), 'system')
  })
})
