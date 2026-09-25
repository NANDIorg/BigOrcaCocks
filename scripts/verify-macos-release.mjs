import { mkdtempSync, readdirSync, rmSync, readFileSync, openSync, readSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect, run, requireRelease, validateTeamId, verifySignature, verifyUpdateMetadata } from './macos-release.mjs'

export function validateEntitlements(entitlements) {
  requireRelease(entitlements && typeof entitlements === 'object', 'не прочитаны entitlements')
  for (const key of ['com.apple.security.get-task-allow', 'get-task-allow', 'com.apple.security.app-sandbox']) {
    requireRelease(!entitlements[key], `недопустимый entitlement ${key}`)
  }
}

function verifyEntitlements(path, execute) {
  const { stdout } = execute('/usr/bin/codesign', ['--display', '--entitlements', ':-', path])
  // С macOS 15 codesign по умолчанию не встраивает entitlements в библиотеки.
  // Пустой успешный вывод означает отсутствие прав; Electron проверяется на allow-jit ниже.
  if (!stdout.trim()) return {}
  const entitlements = JSON.parse(execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: stdout }).stdout)
  validateEntitlements(entitlements)
  return entitlements
}

function* machOFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* machOFiles(path)
    if (!entry.isFile()) continue
    const fd = openSync(path, 'r')
    const magic = Buffer.alloc(4)
    try { readSync(fd, magic, 0, 4, 0) } finally { closeSync(fd) }
    if (['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic.toString('hex'))) yield path
  }
}

export function verifyApp(app, arch, version, teamId, execute = run) {
  const info = key => execute('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(app, 'Contents/Info.plist')]).stdout.trim()
  requireRelease(info('CFBundleIdentifier') === 'dev.orca-board' && info('CFBundleShortVersionString') === version,
    'в архиве неверный bundle ID или версия приложения')
  const architecture = arch === 'x64' ? 'x86_64' : 'arm64'
  const main = join(app, 'Contents/MacOS', info('CFBundleExecutable'))
  requireRelease(execute('/usr/bin/lipo', ['-archs', main]).stdout.trim() === architecture, `неверная архитектура ${arch}`)
  verifySignature(app, teamId, {}, execute)
  requireRelease(verifyEntitlements(app, execute)['com.apple.security.cs.allow-jit'] === true, 'Electron требует allow-jit')
  // Структуру bundle сравниваем независимо от ОС тестовых фикстур;
  // системным утилитам передаём исходный путь с родным разделителем.
  const binaries = [...machOFiles(app)].map(path => ({ path, bundlePath: relative(app, path).split(sep).join('/') }))
  for (const marker of ['/Electron Framework.framework/', ' Helper', '/node-pty/build/Release/pty.node', '/node-pty/build/Release/spawn-helper']) {
    requireRelease(binaries.some(({ bundlePath }) => bundlePath.includes(marker)), `не найден подписанный исполняемый код ${marker}`)
  }
  for (const { path, bundlePath } of binaries) {
    verifySignature(path, teamId, {}, execute)
    const entitlements = verifyEntitlements(path, execute)
    if (path === main || (bundlePath.includes(' Helper') && bundlePath.includes('.app/Contents/MacOS/'))) {
      requireRelease(entitlements['com.apple.security.cs.allow-jit'] === true, 'Electron executable или Helper требует allow-jit')
    }
    // Prebuilds других архитектур могут оставаться в node-pty; выполняется пересобранный build/Release.
    if (bundlePath.includes('/node-pty/build/Release/')) {
      requireRelease(execute('/usr/bin/lipo', ['-archs', path]).stdout.trim().split(/\s+/).includes(architecture),
        `неверная архитектура native-модуля ${relative(app, path)}`)
    }
  }
  const assessment = inspect('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app], execute)
  requireRelease(assessment.includes('source=Notarized Developer ID'), 'Gatekeeper не подтвердил Notarized Developer ID')
  execute('/usr/bin/xcrun', ['stapler', 'validate', app])
}

export function verifyDmg(path, teamId, execute = run) {
  verifySignature(path, teamId, { runtime: false }, execute)
  execute('/usr/bin/xcrun', ['stapler', 'validate', path])
  inspect('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', path], execute)
}

function findApp(directory) {
  const apps = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.endsWith('.app'))
  requireRelease(apps.length === 1 && apps[0].name === 'orca-board.app', 'контейнер должен содержать один orca-board.app')
  return join(directory, apps[0].name)
}

export function verifyRelease(directory, version, teamId, execute = run) {
  validateTeamId(teamId)
  verifyUpdateMetadata(directory, version)
  for (const arch of ['arm64', 'x64']) {
    const stem = join(directory, `orca-board-${version}-${arch}`)
    const extracted = mkdtempSync(join(tmpdir(), 'orca-verify-zip-'))
    try {
      execute('/usr/bin/ditto', ['-x', '-k', `${stem}.zip`, extracted])
      verifyApp(findApp(extracted), arch, version, teamId, execute)
    } finally { rmSync(extracted, { recursive: true, force: true }) }
    verifyDmg(`${stem}.dmg`, teamId, execute)
    const mount = mkdtempSync(join(tmpdir(), 'orca-verify-dmg-'))
    let mounted = false
    try {
      execute('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, `${stem}.dmg`])
      mounted = true
      verifyApp(findApp(mount), arch, version, teamId, execute)
    } finally {
      // При ошибке detach не удаляем содержимое всё ещё смонтированного тома.
      if (mounted) execute('/usr/bin/hdiutil', ['detach', mount])
      rmSync(mount, { recursive: true, force: true })
    }
  }
  // Проверяем хеши ещё раз после проверок контейнеров: ни одна проверка не должна менять файлы.
  verifyUpdateMetadata(directory, version)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireRelease(process.platform === 'darwin', 'проверка артефактов выполняется на macOS')
    const desktop = fileURLToPath(new URL('../apps/desktop/', import.meta.url))
    const { version } = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'))
    verifyRelease(join(desktop, 'release'), version, process.env.APPLE_TEAM_ID)
    process.stdout.write('Финальные macOS ZIP/DMG, подписи, tickets и metadata проверены.\n')
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
