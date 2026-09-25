import { basename } from 'node:path'
import { requireRelease, run, inspect, validateCredentials, validateReleaseConfig, selectIdentity, verifySignature, notarizeDmg } from '../../../scripts/macos-release.mjs'

export async function beforePack(context, env = process.env, execute = run) {
  if (context.electronPlatformName !== 'darwin') return
  const teamId = validateCredentials(env)
  const packager = context.packager
  validateReleaseConfig(packager.config, packager.info.options.publish)
  // Импортом/очисткой временного keychain управляет builder. На машине разработчика hook не запускаем без поручения.
  const { keychainFile } = await packager.codeSigningInfo.value
  requireRelease(keychainFile, 'builder не создал временный keychain для CSC_LINK')
  selectIdentity(inspect('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', keychainFile], execute), teamId)
}

export async function artifactBuildCompleted(event, env = process.env, execute = run) {
  if (event.target?.name !== 'dmg') return
  const teamId = validateCredentials(env)
  const { packager, file } = event
  validateReleaseConfig(packager.config, packager.info.options.publish)
  requireRelease(event.isWriteUpdateInfo === false && event.updateInfo == null, 'DMG уже получил metadata до stapling')
  requireRelease(['arm64', 'x64'].some(arch => basename(file) === `orca-board-${packager.appInfo.version}-${arch}.dmg`),
    'неожиданное имя DMG')
  const identity = verifySignature(file, teamId, { runtime: false, timestamp: false }, execute)
  const { keychainFile } = await packager.codeSigningInfo.value
  requireRelease(keychainFile, 'нет временного keychain для подписи DMG')
  // v26 подписывает DMG без явного --timestamp. Завершаем подпись, пока временный keychain ещё жив.
  execute('/usr/bin/codesign', ['--force', '--sign', identity, '--keychain', keychainFile, '--timestamp', file])
  verifySignature(file, teamId, { runtime: false }, execute)
  notarizeDmg(file, env, execute)
}
