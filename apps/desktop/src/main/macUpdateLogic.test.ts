// Запуск: pnpm --filter @orca-board/desktop test. Чистая логика macOS-установщика обновлений.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  assetUrl,
  bundleMismatch,
  bundlePathFromExecPath,
  classifyBundlePath,
  compareVersions,
  detectMacSupport,
  isNewerVersion,
  releaseTag,
  macUnsupportedMessage,
  parseUpdateManifest,
  pickMacZip,
  validateInstallPaths
} from './macUpdateLogic'

const YML = `version: 0.1.0
files:
  - url: orca-board-0.1.0-arm64.zip
    sha512: AAAA==
    size: 1000
    blockMapSize: 12
  - url: orca-board-0.1.0-x64.zip
    sha512: 'BBBB=='
    size: 2000
  - url: orca-board-0.1.0-arm64.dmg
    sha512: CCCC==
    size: 3000
path: orca-board-0.1.0-arm64.zip
sha512: AAAA==
releaseDate: '2026-09-25T10:00:00.000Z'
`

describe('parseUpdateManifest', () => {
  it('читает версию и файлы, снимает кавычки, size — числом', () => {
    const m = parseUpdateManifest(YML)
    assert.equal(m.version, '0.1.0')
    assert.equal(m.files.length, 3)
    assert.deepEqual(m.files[1], { url: 'orca-board-0.1.0-x64.zip', sha512: 'BBBB==', size: 2000 })
  })

  it('CRLF и комментарии не мешают', () => {
    const m = parseUpdateManifest(YML.replace(/\n/g, '\r\n') + '# конец\r\n')
    assert.equal(m.files.length, 3)
  })

  it('без files — берёт path и sha512 верхнего уровня', () => {
    const m = parseUpdateManifest('version: 1.0.0\npath: a-arm64.zip\nsha512: XX==\n')
    assert.deepEqual(m.files, [{ url: 'a-arm64.zip', sha512: 'XX==', size: null }])
  })

  it('нет version или она не semver — ошибка по-русски', () => {
    assert.throws(() => parseUpdateManifest('files:\n  - url: a.zip\n    sha512: x\n'), /нет поля version/)
    assert.throws(() => parseUpdateManifest('version: latest\n'), /не похожа на semver/)
  })

  it('файл без sha512 отбрасывается', () => {
    const m = parseUpdateManifest('version: 1.0.0\nfiles:\n  - url: a.zip\n')
    assert.deepEqual(m.files, [])
  })
})

describe('pickMacZip', () => {
  const files = parseUpdateManifest(YML).files
  it('arm64 → zip с arm64, dmg игнорируется', () => {
    assert.equal(pickMacZip(files, 'arm64')?.url, 'orca-board-0.1.0-arm64.zip')
  })
  it('x64 → zip x64', () => {
    assert.equal(pickMacZip(files, 'x64')?.url, 'orca-board-0.1.0-x64.zip')
  })
  it('x64 берёт zip без arm64 в имени (universal), но не arm64', () => {
    assert.equal(pickMacZip([{ url: 'app-universal.zip', sha512: 'a', size: null }], 'x64')?.url, 'app-universal.zip')
    assert.equal(pickMacZip([{ url: 'app-arm64.zip', sha512: 'a', size: null }], 'x64'), null)
  })
  it('нет zip под архитектуру или архитектура чужая — null', () => {
    assert.equal(pickMacZip(files.filter((f) => f.url.endsWith('.dmg')), 'arm64'), null)
    assert.equal(pickMacZip(files, 'ia32'), null)
  })
})

describe('версии', () => {
  it('сравнение по semver', () => {
    assert.equal(compareVersions('0.0.10', '0.0.9'), 1)
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
    assert.equal(compareVersions('v1.2.3', '1.2.4'), -1)
    assert.equal(compareVersions('2.0.0', '1.99.99'), 1)
  })
  it('prerelease меньше релиза, идентификаторы сравниваются по правилам semver', () => {
    assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1)
    assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1)
    assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)
    assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1)
    assert.equal(compareVersions('1.0.0+build5', '1.0.0'), 0)
  })
  it('isNewerVersion: только строго новее', () => {
    assert.equal(isNewerVersion('0.0.7', '0.0.6'), true)
    assert.equal(isNewerVersion('0.0.6', '0.0.6'), false)
    assert.equal(isNewerVersion('0.0.5', '0.0.6'), false)
  })
  it('не semver — ошибка', () => {
    assert.throws(() => compareVersions('abc', '1.0.0'), /невозможно сравнить/)
  })
})

describe('assetUrl', () => {
  it('простое имя → адрес releases/download/v<версия>/<файл> (по тегу, не latest), кодируется', () => {
    assert.equal(
      assetUrl('orca-board-0.1.0-arm64.zip', '0.1.0'),
      'https://github.com/NANDIorg/BigOrcaCocks/releases/download/v0.1.0/orca-board-0.1.0-arm64.zip'
    )
    assert.match(assetUrl('a b.zip', '0.1.0'), /a%20b\.zip$/)
    assert.match(assetUrl('a.zip', '1.2.3-beta.1'), /\/download\/v1\.2\.3-beta\.1\/a\.zip$/)
    assert.ok(!assetUrl('a.zip', '0.1.0').includes('/latest/'))
  })
  it('releaseTag: v не дублируется', () => {
    assert.equal(releaseTag('0.2.0'), 'v0.2.0')
    assert.equal(releaseTag('v0.2.0'), 'v0.2.0')
  })
  it('путь, абсолютный URL и «..» отвергаются', () => {
    for (const bad of ['https://evil.example/a.zip', '../a.zip', 'x/a.zip', 'x\\a.zip', '', 'a..zip']) {
      assert.throws(() => assetUrl(bad, '0.1.0'), /недопустимое имя/, bad)
    }
  })
})

describe('пути и поддержка', () => {
  it('bundlePathFromExecPath', () => {
    assert.equal(bundlePathFromExecPath('/Applications/orca-board.app/Contents/MacOS/orca-board'), '/Applications/orca-board.app')
    assert.equal(bundlePathFromExecPath('/Users/a/My Apps/orca.app/Contents/MacOS/orca'), '/Users/a/My Apps/orca.app')
    assert.equal(bundlePathFromExecPath('/usr/local/bin/node'), null)
    assert.equal(bundlePathFromExecPath('/x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), '/x/node_modules/electron/dist/Electron.app')
  })

  it('classifyBundlePath: dmg и App Translocation', () => {
    assert.equal(classifyBundlePath('/Volumes/orca-board 0.1.0/orca-board.app'), 'not-in-applications')
    assert.equal(classifyBundlePath('/private/var/folders/x/T/AppTranslocation/ABC/d/orca-board.app'), 'translocated')
    assert.equal(classifyBundlePath('/Applications/orca-board.app'), null)
    assert.equal(classifyBundlePath('/Users/a/Downloads/orca-board.app'), null)
  })

  it('detectMacSupport: dev, dmg, translocation, нет записи, ок', () => {
    const w = (ok: string[]) => (p: string) => ok.includes(p)
    const app = '/Applications/orca-board.app'
    assert.deepEqual(detectMacSupport({ isPackaged: false, bundlePath: app, canWrite: () => true }), { mode: 'auto', unsupportedReason: 'dev' })
    assert.equal(detectMacSupport({ isPackaged: true, bundlePath: null, canWrite: () => true }).unsupportedReason, 'dev')
    assert.deepEqual(detectMacSupport({ isPackaged: true, bundlePath: '/Volumes/x/o.app', canWrite: () => true }), {
      mode: 'manual-download',
      unsupportedReason: 'not-in-applications'
    })
    assert.equal(detectMacSupport({ isPackaged: true, bundlePath: '/a/AppTranslocation/b/o.app', canWrite: () => true }).unsupportedReason, 'translocated')
    // Нужно право и на бандл, и на его папку.
    assert.equal(detectMacSupport({ isPackaged: true, bundlePath: app, canWrite: w([app]) }).unsupportedReason, 'no-write-access')
    assert.equal(detectMacSupport({ isPackaged: true, bundlePath: app, canWrite: w(['/Applications']) }).unsupportedReason, 'no-write-access')
    assert.deepEqual(detectMacSupport({ isPackaged: true, bundlePath: app, canWrite: w([app, '/Applications']) }), {
      mode: 'auto',
      unsupportedReason: null
    })
  })

  it('macUnsupportedMessage: у каждой причины русский текст, про «Программы» — где это лечится', () => {
    assert.match(macUnsupportedMessage('not-in-applications'), /«Программы»/)
    assert.match(macUnsupportedMessage('translocated'), /«Программы»/)
    assert.match(macUnsupportedMessage('no-write-access'), /прав на запись/)
  })

  const ok = {
    bundle: '/Applications/orca-board.app',
    stage: '/Users/a/Library/Application Support/orca-board/updates/0.1.0-arm64',
    staged: '/Users/a/Library/Application Support/orca-board/updates/0.1.0-arm64/unpacked/orca-board.app',
    previous: '/Users/a/Library/Application Support/orca-board/updates/previous'
  }
  it('validateInstallPaths: нормальные пути проходят', () => {
    assert.doesNotThrow(() => validateInstallPaths(ok))
  })
  it('validateInstallPaths: отвергает относительные, «..», не-.app, пути внутри заменяемого приложения', () => {
    assert.throws(() => validateInstallPaths({ ...ok, bundle: 'orca-board.app' }), /абсолютным/)
    assert.throws(() => validateInstallPaths({ ...ok, previous: '/a/../etc' }), /абсолютным/)
    assert.throws(() => validateInstallPaths({ ...ok, bundle: '/Applications/orca-board' }), /не .app/)
    assert.throws(() => validateInstallPaths({ ...ok, staged: '/tmp/other/orca-board.app' }), /вне каталога/)
    assert.throws(() => validateInstallPaths({ ...ok, previous: '/Applications/orca-board.app/Contents/prev' }), /внутри заменяемого/)
    assert.throws(() => validateInstallPaths({ ...ok, previous: ok.stage }), /пересекаться/)
    assert.throws(() => validateInstallPaths({ ...ok, previous: `${ok.stage}/prev` }), /пересекаться/)
  })

  it('bundleMismatch: id и версия', () => {
    const exp = { id: 'dev.orca-board', version: '0.1.0' }
    assert.equal(bundleMismatch({ id: 'dev.orca-board', version: '0.1.0' }, exp), null)
    assert.match(bundleMismatch({ id: 'com.evil', version: '0.1.0' }, exp) ?? '', /идентификатор/)
    assert.match(bundleMismatch({ id: 'dev.orca-board', version: '0.0.9' }, exp) ?? '', /версия/)
  })
})
