import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export function requireRelease(condition, message) {
  if (!condition) throw new Error(`Релиз macOS: ${message}`)
}

// Без shell; не сериализуем ошибку/аргументы процесса, содержащие пароль Apple.
export function run(file, args, { allowFailure = false, ...options } = {}) {
  const child = spawnSync(file, args, {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000, ...options, shell: false
  })
  const result = { stdout: String(child.stdout || ''), stderr: String(child.stderr || ''), status: child.status ?? 1 }
  if (result.status !== 0 && !allowFailure) throw new Error(`Релиз macOS: ${basename(file)} завершился с ошибкой (${result.status})`)
  return result
}

// codesign и spctl пишут успешную диагностику в stderr.
export function inspect(file, args, execute = run) {
  const result = execute(file, args, { allowFailure: true })
  requireRelease(result.status === 0, `${basename(file)}: проверка не пройдена`)
  return result.stdout + result.stderr
}

export function validateTeamId(teamId) {
  requireRelease(/^[A-Z0-9]{10}$/.test(teamId || ''), 'APPLE_TEAM_ID должен содержать 10 заглавных букв/цифр')
  return teamId
}

export function validateCredentials(env) {
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    requireRelease(typeof env[name] === 'string' && env[name].trim().length > 0, `не задан ${name}`)
  }
  validateTeamId(env.APPLE_TEAM_ID)
  requireRelease(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.APPLE_ID), 'APPLE_ID должен быть адресом Apple Account')
  requireRelease(/^[a-z]{4}(?:-[a-z]{4}){3}$/.test(env.APPLE_APP_SPECIFIC_PASSWORD),
    'APPLE_APP_SPECIFIC_PASSWORD должен быть app-specific паролем формата xxxx-xxxx-xxxx-xxxx')
  const certificate = Buffer.from(env.CSC_LINK, 'base64')
  requireRelease(certificate.length > 0 && certificate[0] === 0x30 && certificate.toString('base64') === env.CSC_LINK,
    'CSC_LINK должен быть однострочным base64 файла .p12 с закрытым ключом')
  for (const name of ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE',
    'CSC_KEYCHAIN', 'CSC_NAME']) {
    requireRelease(!env[name], `не поддерживается ${name}: используется один .p12 и авторизация Apple ID`)
  }
  requireRelease(env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false', 'нельзя отключать поиск Developer ID')
  return env.APPLE_TEAM_ID
}

export function validateReleaseConfig(config, publish) {
  const mac = config.mac || {}
  requireRelease(publish === 'never', 'electron-builder должен запускаться с --publish never')
  requireRelease(mac.type === 'distribution' && mac.forceCodeSigning === true && mac.hardenedRuntime === true && mac.notarize === true,
    'обязательны distribution, forceCodeSigning, hardenedRuntime и notarize')
  requireRelease(mac.identity === undefined && !mac.sign && !mac.signIgnore && !mac.cscLink,
    'нельзя подменять identity, сертификат или пропускать штатную подпись')
  requireRelease(mac.entitlements === 'build/entitlements.mac.plist' && mac.entitlementsInherit === 'build/entitlements.mac.inherit.plist',
    'нужны release entitlements для приложения и вложенного кода')
  requireRelease(config.dmg?.sign === true && config.dmg.writeUpdateInfo === false,
    'DMG должен подписываться без update metadata, которые устаревают после stapling')
}

export function selectIdentity(output, teamId) {
  const identities = [...output.matchAll(/\b([A-Fa-f0-9]{40}) "(Developer ID Application: [^"\r\n]+)"/g)]
  requireRelease(identities.length === 1 && identities[0][2].endsWith(`(${teamId})`),
    'в .p12 нужен ровно один действующий Developer ID Application ожидаемой Apple Team с закрытым ключом')
  return { hash: identities[0][1], name: identities[0][2] }
}

export function validateSignature(output, teamId, { runtime = true, timestamp = true } = {}) {
  const authority = output.match(/^Authority=(Developer ID Application: .+)$/m)?.[1]
  requireRelease(authority?.endsWith(`(${teamId})`) && output.includes(`TeamIdentifier=${teamId}\n`) &&
    !/Signature=adhoc|flags=.*\badhoc\b/.test(output), 'нужна Developer ID Application подпись ожидаемой Apple Team')
  if (runtime) requireRelease(/^CodeDirectory .*flags=.*\bruntime\b/m.test(output), 'нет hardened runtime')
  if (timestamp) requireRelease(/^Timestamp=.+/m.test(output) && !/^Timestamp=none$/m.test(output), 'нет secure timestamp')
  return authority
}

export function verifySignature(path, teamId, options = {}, execute = run) {
  execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', path])
  return validateSignature(inspect('/usr/bin/codesign', ['--display', '--verbose=4', path], execute), teamId, options)
}

export function notarizeDmg(path, env, execute = run) {
  validateCredentials(env)
  const auth = ['--apple-id', env.APPLE_ID, '--password', env.APPLE_APP_SPECIFIC_PASSWORD, '--team-id', env.APPLE_TEAM_ID]
  const logDir = join(path, '..', 'notarization')
  mkdirSync(logDir, { recursive: true })
  const result = execute('/usr/bin/xcrun', ['notarytool', 'submit', path, ...auth, '--wait', '--timeout', '30m', '--output-format', 'json'],
    { allowFailure: true, timeout: 32 * 60_000 })
  let submission
  try { submission = JSON.parse(result.stdout) } catch { throw new Error('Релиз macOS: notarytool не вернул JSON; публикация запрещена') }
  requireRelease(typeof submission.id === 'string' && /^[a-f0-9-]{36}$/i.test(submission.id), 'notarytool не вернул submission ID')
  // Храним только поля результата и лог Apple; аргументы с credentials не сериализуются.
  writeFileSync(join(logDir, `${basename(path)}.json`), JSON.stringify({ id: submission.id, status: submission.status }, null, 2))
  const log = execute('/usr/bin/xcrun', ['notarytool', 'log', submission.id, ...auth], { allowFailure: true })
  if (log.status === 0) writeFileSync(join(logDir, `${basename(path)}.log`), log.stdout)
  requireRelease(result.status === 0 && submission.status === 'Accepted', `notarization DMG не принята; submission ${submission.id}`)
  execute('/usr/bin/xcrun', ['stapler', 'staple', path])
  execute('/usr/bin/xcrun', ['stapler', 'validate', path])
}

// Используем YAML-парсер самого закреплённого builder, без второй версии зависимости.
export function builderRequire() {
  const desktop = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
  const builder = createRequire(desktop.resolve('electron-builder'))
  return createRequire(builder.resolve('app-builder-lib'))
}

export function readYaml(path) {
  return builderRequire()('js-yaml').load(readFileSync(path, 'utf8'))
}

export function verifyUpdateMetadata(directory, version) {
  const manifest = readYaml(join(directory, 'latest-mac.yml'))
  const names = ['arm64', 'x64'].map(arch => `orca-board-${version}-${arch}.zip`)
  requireRelease(manifest?.version === version && Array.isArray(manifest.files) && manifest.files.length === 2,
    'latest-mac.yml должен содержать текущую версию и ровно два ZIP')
  requireRelease(new Set(manifest.files.map(file => file.url)).size === 2, 'повторная запись ZIP в latest-mac.yml')
  for (const file of manifest.files) {
    requireRelease(names.includes(file.url), 'latest-mac.yml содержит посторонний файл или DMG')
    const path = join(directory, file.url)
    const hash = createHash('sha512').update(readFileSync(path)).digest('base64')
    requireRelease(file.size === statSync(path).size && file.sha512 === hash, `устаревшие SHA-512/size: ${file.url}`)
    requireRelease(statSync(`${path}.blockmap`).size > 0, `нет blockmap ZIP: ${file.url}`)
  }
  const primary = manifest.files.find(file => file.url === manifest.path)
  requireRelease(primary && primary.sha512 === manifest.sha512, 'устаревшие верхнеуровневые path/sha512')
  const actual = readdirSync(directory).filter(name => /\.(zip|dmg)(\.blockmap)?$/.test(name)).sort()
  const expected = names.flatMap(name => [name, `${name}.blockmap`, name.replace(/\.zip$/, '.dmg')]).sort()
  requireRelease(JSON.stringify(actual) === JSON.stringify(expected), 'посторонние/отсутствующие архивы или запрещённый DMG blockmap')
  for (const name of expected) requireRelease(statSync(join(directory, name)).size > 0, `пустой файл ${name}`)
}
