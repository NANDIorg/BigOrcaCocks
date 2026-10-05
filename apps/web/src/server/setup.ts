import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { mkdir, access, writeFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { parseWebConfig, loadWebConfig } from './config.ts'
import { createPrivateJson, replacePrivateJson, readPrivateJson, record } from './private-json.ts'
import { initializeWebAccount } from './accounts.ts'
import { readPassword } from './password.ts'
import { serviceUnit, caddyConfig, proxyUnit, updateWorkerUnit, updateSudoers } from './deployment.ts'
import { execFileSync } from 'node:child_process'
import { pinRecovery } from './update.ts'
import { execPrivileged, warnRoot } from './privileges.ts'
import { collectSetup, sshInstructions } from './wizard.ts'
import { constants } from 'node:fs'
import { loadWebAccounts } from './accounts.ts'
import { localHealth } from './health.ts'

export const configFile = () => process.env.ORCA_WEB_CONFIG ?? join(homedir(), '.config', 'orca-web', 'config.json')
export const configDirectory = () => dirname(configFile())
export const installationDirectory = () => process.env.ORCA_WEB_HOME ?? join(homedir(), '.local', 'share', 'orca-web')
export async function setup(options: { reconfigure?: boolean } = {}): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Мастер настройки запускается в интерактивном терминале')
  let existing: ReturnType<typeof parseWebConfig> | undefined
  try { existing = parseWebConfig(await readPrivateJson(configFile(), 16 * 1024)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (existing && !options.reconfigure) throw new Error('Настройки уже существуют. Для изменения папки проектов или доступа выполните orca-web configure.')
  let accountsExist = false
  try { await loadWebAccounts(join(configDirectory(), 'accounts.json')); accountsExist = true }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const ask = createInterface({ input: stdin, output: stdout })
  let pendingPrevious: ReturnType<typeof parseWebConfig> | undefined
  try { pendingPrevious = parseWebConfig(await readPrivateJson(join(configDirectory(), 'setup-previous.json'), 16 * 1024)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { ask.close(); throw error } }
  const gitValue = (key: string): string => { try { return execFileSync('git', ['config', '--global', '--get', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim() } catch { return '' } }
  const gitName = gitValue('user.name'); const gitEmail = gitValue('user.email')
  const running = existing ? await localHealth(existing).then(value => record(value) && value.status === 'ready', () => false) : false
  let choices: Awaited<ReturnType<typeof collectSetup>>
  try {
    choices = await collectSetup({ ask: prompt => ask.question(prompt), write: value => { stdout.write(value) } }, {
      home: homedir(), root: process.getuid?.() === 0, installer: process.env.ORCA_WEB_INSTALLER === '1',
      rootAcknowledged: process.env.ORCA_WEB_ACK_ROOT === '1', existing,
      gitIdentityMissing: !gitName || !gitEmail, gitName, gitEmail,
      accountsExist, running,
    })
  } finally { ask.close() }
  if (choices.provision && process.getuid?.() !== 0 && process.env.ORCA_WEB_INSTALLER !== '1') throw new Error('Для автонастройки повторите установщик через административное SSH-подключение. Он проверит пакет в отдельном root-каталоге; установленный пользовательский код не запускается через sudo. Текущие настройки сохранены. Для смены папки без системных изменений выберите n и перезапустите сервис.')
  if (pendingPrevious && !choices.provision) throw new Error('Предыдущая автонастройка прервана. Повторите установщик с автонастройкой, чтобы завершить изменения или восстановить прежний конфиг. Текущие настройки сохранены.')
  const root = choices.projectRoot
  try { await mkdir(root, { recursive: true, mode: 0o700 }); await access(root, constants.R_OK | constants.W_OK | constants.X_OK) }
  catch (error) { throw new Error(`Пользователь ${userInfo().username} не может читать и изменять папку проектов ${root}. Укажите доступный ему каталог.`, { cause: error }) }
  const config = parseWebConfig({ schemaVersion: 1, configDir: configDirectory(), dataDir: existing?.dataDir ?? join(homedir(), '.orca-board', 'profiles', 'default'), projectRoots: existing && root === existing.projectRoots[0] ? existing.projectRoots : [root],
    mode: choices.mode, port: existing?.port ?? 3737, previewPort: existing?.previewPort ?? 3738,
    origin: choices.domain ? `https://${choices.domain}` : `http://localhost:${existing?.port ?? 3737}`,
    ...(choices.previewDomain ? { previewOrigin: `https://${choices.previewDomain}` } : {}) })
  if (!accountsExist) {
    let password: string
    for (;;) {
      password = await readPassword('Пароль (от 12 символов, не отображается): ')
      if (Array.from(password).length < 12 || Buffer.byteLength(password) > 256) { stdout.write('Нужно от 12 символов, максимум 256 байт.\n'); continue }
      if (password !== await readPassword('Повторите пароль: ')) { stdout.write('Пароли не совпадают. Повторите ввод.\n'); continue }
      break
    }
    await initializeWebAccount({ configDir: config.configDir, login: choices.login!, password })
  }
  if (!existing) {
    await createPrivateJson(configFile(), config)
  } else {
    const backup = `${configFile()}.backup-${Date.now()}`
    await createPrivateJson(backup, existing)
    if (choices.provision) {
      const previousFile = join(config.configDir, 'setup-previous.json')
      try { await replacePrivateJson(previousFile, pendingPrevious ?? existing) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await createPrivateJson(previousFile, existing) }
    }
    await replacePrivateJson(configFile(), config)
    stdout.write(`Резервная копия прежних настроек: ${backup}\n`)
  }
  const plan = { schemaVersion: 1, provision: choices.provision, email: choices.email ?? '' }
  const planFile = join(config.configDir, 'setup-plan.json')
  try { await access(planFile); await replacePrivateJson(planFile, plan) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await createPrivateJson(planFile, plan) }
  await writeTemplates()
  if (choices.gitName) execFileSync('git', ['config', '--global', 'user.name', choices.gitName], { stdio: 'inherit', timeout: 5000 })
  if (choices.gitEmail) execFileSync('git', ['config', '--global', 'user.email', choices.gitEmail], { stdio: 'inherit', timeout: 5000 })
  stdout.write(`\nНастройки сохранены: ${configFile()}\n`)
  if (!choices.provision) {
    if (existing) stdout.write(`Перезапустите Orca для применения настроек. Для systemd: ${process.getuid?.() === 0 ? '' : 'sudo '}systemctl stop orca-web.service, затем ${process.getuid?.() === 0 ? '' : 'sudo '}systemctl start orca-web.service. Если Orca запущена вручную, перезапустите её в исходном терминале.\n`)
    else stdout.write(`Запуск вручную: ${join(installationDirectory(), 'bin', 'orca-web')} start\n`)
  }
  if (config.mode === 'local') stdout.write(sshInstructions(process.env.ORCA_WEB_SSH_TARGET, config.port, config.previewPort))
  if (config.mode === 'proxy') stdout.write(`DNS: записи A/AAAA для ${choices.domain} и ${choices.previewDomain} должны вести на этот сервер. HTTPS будет проверен отдельно.\n`)
  stdout.write('Изменить настройки позже: orca-web configure\nПроверить Git, CLI-агенты и окружение: orca-web doctor\n')
  return choices.provision
}
export async function writeTemplates(): Promise<void> {
  const config = await loadWebConfig(configFile()); const user = userInfo().username
  const base = installationDirectory()
  const path = `${join(base, 'current', 'node', 'bin')}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`
  const service = { user, home: homedir(), launcher: join(base, 'bin', 'orca-web'), path, configFile: resolve(configFile()), base }
  try { await pinRecovery(base) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await writeFile(join(config.configDir, 'orca-web.service'), serviceUnit(service), { mode: 0o600 })
  await writeFile(join(config.configDir, 'orca-web-update.service'), updateWorkerUnit(service), { mode: 0o600 })
  await writeFile(join(config.configDir, 'orca-web-update.sudoers'), updateSudoers(user), { mode: 0o600 })
  if (config.mode === 'proxy') {
    const generated = caddyConfig(config)
    await writeFile(join(config.configDir, 'Caddyfile.generated'), generated, { mode: 0o600 })
    // Legacy proxy может обслуживать дополнительные сайты: его живой файл не перезаписываем.
    try { await writeFile(join(config.configDir, 'Caddyfile'), generated, { mode: 0o600, flag: 'wx' }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    await writeFile(join(config.configDir, 'orca-web-proxy.service'), proxyUnit({ user, home: homedir(), caddy: '/usr/bin/caddy', file: join(config.configDir, 'Caddyfile') }), { mode: 0o600 })
  }
}
export async function installService(): Promise<void> {
  if (process.platform !== 'linux') throw new Error('Установка сервиса выполняется на Linux')
  warnRoot()
  const config = await loadWebConfig(configFile()); await writeTemplates()
  const sudo = ([command, ...args]: string[]) => execPrivileged(command, args)
  if (config.mode === 'proxy') {
    await access('/usr/bin/caddy')
    // Не перехватываем уже работающий Caddy с другими сайтами.
    try { execFileSync('systemctl', ['is-active', '--quiet', 'caddy']); throw new Error('Caddy уже обслуживает сайты. Подключите подготовленный Caddyfile к его конфигурации; установите Orca-сервис командой orca-web service install-app.') }
    catch (error) { if (error instanceof Error && !('status' in error)) throw error }
  }
  const services = ['orca-web.service', ...(config.mode === 'proxy' ? ['orca-web-proxy.service'] : [])]
  for (const service of services) sudo(['install', '-m', '644', join(config.configDir, service), `/etc/systemd/system/${service}`])
  installUpdater(config.configDir)
  sudo(['systemctl', 'daemon-reload']); sudo(['systemctl', 'enable', '--now', ...services])
}
export async function installAppService(): Promise<void> {
  if (process.platform !== 'linux') throw new Error('Требуется Linux')
  warnRoot()
  await writeTemplates(); execPrivileged('install', ['-m', '644', join(configDirectory(), 'orca-web.service'), '/etc/systemd/system/orca-web.service'])
  installUpdater(configDirectory())
  execPrivileged('systemctl', ['daemon-reload']); execPrivileged('systemctl', ['enable', '--now', 'orca-web.service'])
}
function installUpdater(directory: string): void {
  if (process.getuid?.() === 0) {
    execPrivileged('install', ['-m', '644', join(directory, 'orca-web-update.service'), '/etc/systemd/system/orca-web-update.service'])
    return
  }
  const sudo = ([command, ...args]: string[]) => execPrivileged(command, args)
  sudo(['/usr/sbin/visudo', '-cf', join(directory, 'orca-web-update.sudoers')])
  sudo(['install', '-m', '644', join(directory, 'orca-web-update.service'), '/etc/systemd/system/orca-web-update.service'])
  sudo(['install', '-m', '440', join(directory, 'orca-web-update.sudoers'), '/etc/sudoers.d/orca-web-update'])
}
