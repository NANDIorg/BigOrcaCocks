import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { MenuItemConstructorOptions } from 'electron'
import { applicationMenuTemplate, applicationMenuSnapshot, runApplicationMenuCommand, windowMenuCommands, MenuActionQueue, type AppMenuHandlers } from './app-menu'
import { setMainLocale } from './i18n'

afterEach(() => setMainLocale('ru'))

function fixture(platform: NodeJS.Platform = 'darwin', development = false): { menu: MenuItemConstructorOptions[]; calls: string[] } {
  const calls: string[] = []
  const handlers: AppMenuHandlers = {
    navigate: (action) => { calls.push(action) },
    about: () => { calls.push('about') },
    open: () => { calls.push('open') },
    quit: () => { calls.push('quit') },
    openExternal: (url) => { calls.push(url) }
  }
  return { menu: applicationMenuTemplate(platform, development, handlers), calls }
}

describe('авторское меню Windows', () => {
  it('передаёт локализованное дерево без функций, с разделителями и сочетаниями', () => {
    const snapshot = applicationMenuSnapshot(fixture('win32').menu)
    assert.deepEqual(snapshot.map((entry) => entry.label), ['Файл', 'Правка', 'Вид', 'Окно', 'Справка'])
    assert.equal(snapshot[0].children?.find((entry) => entry.id === 'settings')?.hint, 'Ctrl+,')
    assert.equal(snapshot[1].children?.find((entry) => entry.id === 'role:copy')?.hint, 'Ctrl+C')
    assert.equal(snapshot[3].children?.find((entry) => entry.id === 'role:minimize')?.hint, 'Ctrl+M')
    assert.equal(snapshot[1].children?.find((entry) => entry.id === 'role:cut')?.separatorBefore, true)
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot)
    setMainLocale('en')
    assert.equal(applicationMenuSnapshot(fixture('win32').menu)[0].label, 'File')
  })

  it('команда проверяется по доступным листьям: скрытые, выключенные, родитель и dev-команды отклоняются', () => {
    const { menu } = fixture('win32')
    const calls: string[] = []
    const commands = { settings: () => calls.push('settings'), 'role:reload': () => calls.push('reload') }
    const snapshot = applicationMenuSnapshot(menu)
    assert.equal(runApplicationMenuCommand(snapshot, 'settings', commands), true)
    for (const invalid of ['role:reload', 'file-menu', '__proto__', 'toString', {}, null]) {
      assert.equal(runApplicationMenuCommand(snapshot, invalid, commands), false)
    }
    const unavailable = applicationMenuSnapshot([{ label: 'Hidden', visible: false, submenu: [{ id: 'settings', label: 'Settings' }] },
      { label: 'Disabled', enabled: false, submenu: [{ id: 'settings', label: 'Settings' }] }])
    assert.equal(runApplicationMenuCommand(unavailable, 'settings', commands), false)
    assert.deepEqual(calls, ['settings'])
  })

  it('выход и редактирование проходят через общие обработчики и исходное окно', () => {
    const calls: string[] = []
    const host = {
      close: () => calls.push('close'), minimize: () => calls.push('minimize'),
      isFullScreen: () => false, setFullScreen: (value: boolean) => calls.push(`fullscreen:${value}`),
      webContents: {
        undo: () => calls.push('undo'), redo: () => calls.push('redo'), cut: () => calls.push('cut'), copy: () => calls.push('copy'),
        paste: () => calls.push('paste'), selectAll: () => calls.push('selectAll'),
        getZoomLevel: () => 1, setZoomLevel: (level: number) => calls.push(`zoom:${level}`),
        reload: () => calls.push('reload'), toggleDevTools: () => calls.push('devTools')
      }
    }
    const handlers: AppMenuHandlers = { navigate: (action) => calls.push(action), about: () => calls.push('about'),
      open: () => calls.push('open'), quit: () => calls.push('guardedQuit'), openExternal: (url) => calls.push(url) }
    const commands = windowMenuCommands(host, handlers)
    const snapshot = applicationMenuSnapshot(applicationMenuTemplate('win32', false, handlers))
    for (const id of ['settings', 'quit', 'role:copy', 'role:undo', 'role:zoomin', 'role:togglefullscreen', 'role:close']) {
      assert.equal(runApplicationMenuCommand(snapshot, id, commands), true)
    }
    assert.deepEqual(calls, ['settings', 'guardedQuit', 'copy', 'undo', 'zoom:1.5', 'fullscreen:true', 'close'])
  })
})

function items(menu: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return menu.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? items(item.submenu) : [])])
}

function item(menu: MenuItemConstructorOptions[], id: string): MenuItemConstructorOptions {
  const found = items(menu).find((entry) => entry.id === id)
  assert.ok(found, `Нет пункта ${id}`)
  return found
}

function click(menu: MenuItemConstructorOptions[], id: string): void {
  const handler = item(menu, id).click
  assert.ok(handler, `Нет действия у ${id}`)
  Reflect.apply(handler, undefined, [])
}

describe('меню приложения', () => {
  it('macOS: настройки, обновления и окно «О приложении» вызывают действия Orca', () => {
    const { menu, calls } = fixture()
    assert.equal(menu[0].label, 'orca-board')
    assert.equal(item(menu, 'settings').accelerator, 'CmdOrCtrl+,')
    click(menu, 'settings')
    click(menu, 'check-updates')
    click(menu, 'about')
    assert.deepEqual(calls, ['settings', 'checkUpdates', 'about'])
  })

  it('добавление репозитория и восстановление окна доступны из меню', () => {
    const { menu, calls } = fixture()
    assert.equal(item(menu, 'add-project').accelerator, 'CmdOrCtrl+O')
    click(menu, 'add-project')
    click(menu, 'show-window')
    assert.deepEqual(calls, ['addProject', 'open'])
  })

  it('выход проходит через подтверждение, а системные команды сохраняют нативные роли', () => {
    const { menu, calls } = fixture()
    const quit = item(menu, 'quit')
    assert.equal(quit.role, undefined)
    assert.equal(quit.accelerator, 'CmdOrCtrl+Q')
    click(menu, 'quit')
    assert.deepEqual(calls, ['quit'])
    const roles = items(menu).map((entry) => entry.role)
    for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'services', 'hide', 'hideOthers', 'unhide', 'minimize', 'zoom', 'front', 'togglefullscreen']) {
      assert.ok(roles.includes(role as MenuItemConstructorOptions['role']), role)
    }
  })

  it('справка ведёт к руководству, релизам и issues Orca, а не Electron', () => {
    const { menu, calls } = fixture()
    click(menu, 'guide')
    click(menu, 'releases')
    click(menu, 'report-issue')
    assert.deepEqual(calls, [
      'https://github.com/NANDIorg/BigOrcaCocks#readme',
      'https://github.com/NANDIorg/BigOrcaCocks/releases',
      'https://github.com/NANDIorg/BigOrcaCocks/issues/new'
    ])
  })

  it('production не предлагает перезагрузить окно с агентами или открыть инструменты разработчика', () => {
    const production = items(fixture().menu).map((entry) => entry.role)
    assert.ok(!production.includes('reload'))
    assert.ok(!production.includes('forceReload'))
    assert.ok(!production.includes('toggleDevTools'))
    const development = items(fixture('darwin', true).menu).map((entry) => entry.role)
    assert.ok(development.includes('reload'))
    assert.ok(development.includes('toggleDevTools'))
  })

  it('Windows и Linux получают настройки в «Файл» и информацию о приложении в справке', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const { menu, calls } = fixture(platform)
      assert.equal(menu[0].id, 'file-menu')
      const file = Array.isArray(menu[0].submenu) ? menu[0].submenu : []
      assert.ok(file.some((entry) => entry.id === 'settings'))
      click(menu, 'settings')
      click(menu, 'about')
      assert.deepEqual(calls, ['settings', 'about'])
      assert.ok(!items(menu).some((entry) => entry.role === 'services' || entry.role === 'hide'))
    }
  })

  it('пересборка меню использует новый язык интерфейса', () => {
    assert.equal(fixture().menu.at(-1)?.label, 'Справка')
    setMainLocale('en')
    const { menu } = fixture()
    assert.equal(menu.at(-1)?.label, 'Help')
    assert.equal(item(menu, 'settings').label, 'Settings…')
    assert.equal(item(menu, 'guide').label, 'orca-board User Guide')
  })
})

describe('доставка команды меню в окно', () => {
  it('команда при создании окна ждёт подписки renderer и доставляется один раз', () => {
    const queue = new MenuActionQueue()
    assert.equal(queue.request('settings'), null)
    assert.equal(queue.connect(), 'settings')
    assert.equal(queue.connect(), null)
    assert.equal(queue.request('checkUpdates'), 'checkUpdates')
  })

  it('во время загрузки выполняется последний запрос, после закрытия старый запрос не повторяется', () => {
    const queue = new MenuActionQueue()
    queue.connect()
    queue.disconnect()
    assert.equal(queue.request('settings'), null)
    assert.equal(queue.request('checkUpdates'), null)
    assert.equal(queue.connect(), 'checkUpdates')
    queue.disconnect()
    queue.request('settings')
    queue.clear()
    assert.equal(queue.connect(), null)
  })
})
