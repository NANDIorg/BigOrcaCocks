import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { mkdir, access, writeFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { parseWebConfig, loadWebConfig } from './config.ts'
import { createPrivateJson } from './private-json.ts'
import { initializeWebAccount } from './accounts.ts'
import { readPassword } from './password.ts'
import { serviceUnit, caddyConfig, proxyUnit, updateWorkerUnit, updateSudoers } from './deployment.ts'
import { execFileSync } from 'node:child_process'
import { pinRecovery } from './update.ts'

export const configFile = () => process.env.ORCA_WEB_CONFIG ?? join(homedir(), '.config', 'orca-web', 'config.json')
export const configDirectory = () => dirname(configFile())
export const installationDirectory = () => process.env.ORCA_WEB_HOME ?? join(homedir(), '.local', 'share', 'orca-web')
export async function setup(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Мастер настройки запускается в интерактивном терминале')
  if (process.getuid?.() === 0) throw new Error('Устанавливайте Orca под обычным пользователем, которому принадлежат проекты')
  try { await access(configFile()); throw new Error('Конфигурация уже существует. Измените config.json и перезапустите сервис.') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const ask = createInterface({ input: stdin, output: stdout })
  let root: string; let login: string; let domain: string; let preview: string
  try {
    stdout.write('Orca Web — настройка сервера\n')
    root = resolve((await ask.question(`Папка с проектами [${join(homedir(), 'projects')}]: `)).trim() || join(homedir(), 'projects'))
    domain = (await ask.question('Домен Orca без https:// (пусто — localhost): ')).trim()
    preview = domain ? (await ask.question('Отдельный домен для предпросмотра файлов: ')).trim() : ''
    login = (await ask.question('Логин первого оператора: ')).trim()
  } finally { ask.close() }
  await mkdir(root, { recursive: true })
  const config = parseWebConfig({ schemaVersion: 1, configDir: configDirectory(), dataDir: join(homedir(), '.orca-board', 'profiles', 'default'), projectRoots: [root],
    mode: domain ? 'proxy' : 'local', port: 3737, origin: domain ? `https://${domain}` : 'http://localhost:3737', ...(domain ? { previewOrigin: `https://${preview}` } : {}) })
  const password = await readPassword('Пароль (от 12 символов, не отображается): ')
  if (password !== await readPassword('Повторите пароль: ')) throw new Error('Пароли не совпадают')
  await initializeWebAccount({ configDir: config.configDir, login, password })
  await createPrivateJson(configFile(), config)
  await writeTemplates()
  stdout.write(`Готово: ${config.origin}\nЗапуск: orca-web start\nАвтозапуск на Linux: orca-web service install\nПроверка окружения: orca-web doctor\n`)
  if (domain) stdout.write('Для HTTPS установите Caddy, направьте оба домена на сервер и откройте порты 80/443. Готовый Caddyfile находится в каталоге конфигурации.\n')
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
    await writeFile(join(config.configDir, 'Caddyfile'), caddyConfig(config), { mode: 0o600 })
    await writeFile(join(config.configDir, 'orca-web-proxy.service'), proxyUnit({ user, home: homedir(), caddy: '/usr/bin/caddy', file: join(config.configDir, 'Caddyfile') }), { mode: 0o600 })
  }
}
export async function installService(): Promise<void> {
  if (process.platform !== 'linux' || process.getuid?.() === 0) throw new Error('Установка сервиса выполняется обычным пользователем Linux с sudo')
  const config = await loadWebConfig(configFile()); await writeTemplates()
  const sudo = (args: string[]) => execFileSync('sudo', args, { stdio: 'inherit' })
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
  if (process.platform !== 'linux' || process.getuid?.() === 0) throw new Error('Требуется обычный пользователь Linux с sudo')
  await writeTemplates(); execFileSync('sudo', ['install', '-m', '644', join(configDirectory(), 'orca-web.service'), '/etc/systemd/system/orca-web.service'], { stdio: 'inherit' })
  installUpdater(configDirectory())
  execFileSync('sudo', ['systemctl', 'daemon-reload'], { stdio: 'inherit' }); execFileSync('sudo', ['systemctl', 'enable', '--now', 'orca-web.service'], { stdio: 'inherit' })
}
function installUpdater(directory: string): void {
  const sudo = (args: string[]) => execFileSync('sudo', args, { stdio: 'inherit' })
  sudo(['/usr/sbin/visudo', '-cf', join(directory, 'orca-web-update.sudoers')])
  sudo(['install', '-m', '644', join(directory, 'orca-web-update.service'), '/etc/systemd/system/orca-web-update.service'])
  sudo(['install', '-m', '440', join(directory, 'orca-web-update.sudoers'), '/etc/sudoers.d/orca-web-update'])
}
