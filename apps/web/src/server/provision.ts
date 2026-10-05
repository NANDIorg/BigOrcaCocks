import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseWebConfig, type WebConfig } from './config.ts'
import { serviceUnit, updateWorkerUnit, updateSudoers, caddyConfig } from './deployment.ts'
import { localHealth } from './health.ts'
import { parseHostname, sshInstructions } from './wizard.ts'
import { record } from './private-json.ts'
import { fileURLToPath } from 'node:url'

const marker = '# Orca Web: managed file\n'
type ManagedFile = { file: string; content: string; allowExisting?: boolean; mode?: number }
const run = (command: string, args: string[], timeout = 30_000): string => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout })
const exists = async (file: string): Promise<boolean> => { try { await access(file); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
const active = (service: string): boolean => { try { run('systemctl', ['is-active', '--quiet', service]); return true } catch { return false } }

/** Проверяем все файлы до первой записи; неудачная проверка/reload возвращает весь набор. */
export async function applyManagedFiles(files: ManagedFile[], validate: () => void, reload: () => void): Promise<void> {
  const snapshots: { file: string; previous?: string; mode: number; backup?: string }[] = []
  for (const { file, allowExisting, mode: requestedMode } of files) {
    let previous: string | undefined; let mode = requestedMode ?? 0o644
    try {
      const info = await lstat(file)
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Нельзя изменять симлинк или специальный файл: ${file}`)
      if (process.platform !== 'win32' && (info.uid !== process.getuid?.() || info.mode & 0o022)) throw new Error(`Небезопасный владелец или права файла: ${file}`)
      previous = await readFile(file, 'utf8'); mode = requestedMode ?? (info.mode & 0o777)
      if (!allowExisting && !previous.startsWith(marker) && !previous.startsWith(`#!/bin/sh\n${marker}`)) throw new Error(`Файл ${file} принадлежит другому сайту; автоматическая настройка не перезаписывает чужие файлы`)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    snapshots.push({ file, previous, mode })
  }
  const atomic = async (file: string, value: string, mode: number) => {
    const temporary = `${file}.orca-${randomUUID()}.tmp`
    try { await writeFile(temporary, value, { flag: 'wx', mode }); await chmod(temporary, mode); await rename(temporary, file) }
    finally { await unlink(temporary).catch(() => {}) }
  }
  try {
    for (let i = 0; i < files.length; i++) {
      const snapshot = snapshots[i]
      if (snapshot.previous !== undefined) {
        snapshot.backup = `${snapshot.file}.backup-${Date.now()}-${randomUUID()}`
        await writeFile(snapshot.backup, snapshot.previous, { flag: 'wx', mode: snapshot.mode })
      }
      await atomic(files[i].file, files[i].content, snapshot.mode)
    }
    validate(); reload()
  } catch (error) {
    for (const snapshot of snapshots) {
      if (snapshot.previous === undefined) await unlink(snapshot.file).catch(() => {})
      else await atomic(snapshot.file, snapshot.previous, snapshot.mode)
    }
    try { validate(); reload() } catch { /* Первоначальная ошибка остаётся причиной отката. */ }
    throw error
  }
}

/** Общий откат охватывает несколько этапов provision, а не только один reload. */
export async function provisionTransaction(files: string[], apply: () => Promise<void>, recover: () => Promise<void>): Promise<void> {
  const snapshots: { file: string; content?: string; mode: number }[] = []
  try {
    for (const file of files) {
      let content: string | undefined; let mode = 0o644
      try {
        const info = await lstat(file)
        if (!info.isFile() || info.isSymbolicLink() || process.platform !== 'win32' && (info.uid !== process.getuid?.() || info.mode & 0o022)) throw new Error(`Небезопасный системный файл: ${file}`)
        content = await readFile(file, 'utf8'); mode = info.mode & 0o777
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      snapshots.push({ file, content, mode })
    }
    await apply()
  } catch (error) {
    const failures: unknown[] = []
    for (const snapshot of snapshots) {
      try {
        if (snapshot.content === undefined) await unlink(snapshot.file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
        else await applyManagedFiles([{ file: snapshot.file, content: snapshot.content, mode: snapshot.mode, allowExisting: true }], () => {}, () => {})
      } catch (failure) { failures.push(failure) }
    }
    try { await recover() } catch (failure) { failures.push(failure) }
    if (failures.length) throw new AggregateError([error, ...failures], `Автонастройка не завершена; откат требует проверки: ${error instanceof Error ? error.message : String(error)}. Проверьте journalctl и резервные копии.`)
    throw error
  }
}

export function nginxRenewalHook(): string {
  return `#!/bin/sh\n${marker}case "\${RENEWED_LINEAGE:-}" in /etc/letsencrypt/live/orca-web-*) /usr/sbin/nginx -t && /usr/bin/systemctl reload nginx ;; esac\n`
}
export function assertNginxHostsAvailable(effective: string, chosen: string[]): void {
  const text = effective.replace(/#[^\n]*/g, '')
  for (const directive of text.matchAll(/\bserver_name\s+([^;]+);/g)) {
    for (const raw of directive[1].trim().split(/\s+/)) {
      const name = raw.replace(/^['"]|['"]$/g, '').toLowerCase()
      if (name.startsWith('~')) throw new Error('Nginx использует regex server_name: нельзя гарантировать, что новый домен не перехватит сайт. Настройте proxy вручную или выберите SSH.')
      for (const host of chosen) {
        const matches = name === host || name.startsWith('*.') && host.endsWith(name.slice(1)) || name.startsWith('.') && (host === name.slice(1) || host.endsWith(name)) || name.endsWith('.*') && host.startsWith(name.slice(0, -1))
        if (matches) throw new Error(`Домен ${host} занят существующим сайтом Nginx (${name}, включая wildcard). Выберите другой поддомен либо подключите Orca вручную.`)
      }
    }
  }
}
export async function publicOriginsReady(config: WebConfig, expected: { version: string; instance: string }, request: (url: string) => Promise<Response> = url => fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) })): Promise<boolean> {
  try {
    const results = await Promise.all([config.origin, config.previewOrigin].map(async (origin, index) => {
      const response = await request(`${origin}/health`); const value: unknown = await response.json()
      return response.ok && record(value) && value.status === 'ready' && value.version === expected.version && value.instance === expected.instance && (index === 0 || value.service === 'orca-web-preview')
    }))
    return results.every(Boolean)
  } catch { return false }
}

function hosts(config: WebConfig): [string, string] {
  if (config.mode !== 'proxy') throw new Error('HTTPS настраивается только для режима с доменом')
  const panel = parseHostname(new URL(config.origin).host); const preview = parseHostname(new URL(config.previewOrigin).host)
  if (panel === preview) throw new Error('Панель и preview требуют разные домены')
  return [panel, preview]
}
export function nginxConfig(config: WebConfig, tls: boolean): string {
  const [panel, preview] = hosts(config)
  const challenge = 'location ^~ /.well-known/acme-challenge/ { root /var/lib/orca-web/acme; }'
  let result = `${marker}server {\n  listen 80;\n  listen [::]:80;\n  server_name ${panel} ${preview};\n  ${challenge}\n  location / { return 308 https://$host$request_uri; }\n}\n`
  if (!tls) return result
  for (const [host, port] of [[panel, config.port], [preview, config.previewPort]] as const) result += `\nserver {\n  listen 443 ssl;\n  listen [::]:443 ssl;\n  server_name ${host};\n  ssl_certificate /etc/letsencrypt/live/orca-web-${panel}/fullchain.pem;\n  ssl_certificate_key /etc/letsencrypt/live/orca-web-${panel}/privkey.pem;\n  ssl_protocols TLSv1.2 TLSv1.3;\n  client_max_body_size 64m;\n  location / {\n    proxy_pass http://127.0.0.1:${port};\n    proxy_set_header Host $host;\n    proxy_set_header X-Forwarded-Proto https;\n    ${host === preview ? 'proxy_set_header Cookie "";\n    proxy_hide_header Set-Cookie;' : 'proxy_set_header X-Forwarded-For $remote_addr;'}\n    proxy_buffering off;\n    proxy_read_timeout 90s;\n  }\n}\n`
  return result
}

async function readOwnedJson(file: string, uid: number): Promise<unknown> {
  const parent = await lstat(dirname(file))
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || parent.mode & 0o077) throw new Error('Приватный каталог настройки должен принадлежать пользователю сервиса с правами 0700')
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.uid !== uid || info.mode & 0o077 || info.size > 16384) throw new Error('Небезопасный файл настройки')
    return JSON.parse(await handle.readFile('utf8')) as unknown
  } finally { await handle.close() }
}
function apt(packages: string[]): void {
  process.stdout.write(`Устанавливаю системные пакеты: ${packages.join(', ')}…\n`)
  run('apt-get', ['update'], 180_000)
  execFileSync('apt-get', ['install', '-y', '--no-install-recommends', ...packages], { stdio: 'inherit', timeout: 180_000, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } })
}
async function configureHttps(config: WebConfig, email: string): Promise<void> {
  const [panel, preview] = hosts(config)
  for (const host of [panel, preview]) {
    try { const addresses = await lookup(host, { all: true }); process.stdout.write(`DNS ${host}: ${addresses.map(value => value.address).join(', ')}\n`) }
    catch { throw new Error(`Для ${host} ещё нет DNS-записи. Создайте A/AAAA на IP сервера и повторите установщик. Аккаунты сохранены.`) }
  }
  const listeners = run('ss', ['-ltnp', '( sport = :80 or sport = :443 )'])
  const hasListeners = listeners.trim().split('\n').length > 1
  if (active('nginx')) {
    process.stdout.write('Обнаружен Nginx: добавляю отдельный файл Orca, существующие сайты сохраняются.\n')
    const nginx = await exists('/usr/sbin/nginx') ? '/usr/sbin/nginx' : 'nginx'
    const effective = execFileSync(nginx, ['-T'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 })
    if (!/include\s+\/etc\/nginx\/conf\.d\/\*\.conf\s*;/.test(effective)) throw new Error('Nginx использует нестандартную конфигурацию без /etc/nginx/conf.d/*.conf. Подготовьте отдельный proxy вручную или выберите SSH в orca-web configure.')
    const other = effective.split(/# configuration file /).filter(block => !block.startsWith('/etc/nginx/conf.d/orca-web.conf:')).join('\n')
    assertNginxHostsAvailable(other, [panel, preview])
    if (!await exists('/usr/bin/certbot')) apt(['certbot'])
    await mkdir('/var/lib/orca-web/acme', { recursive: true, mode: 0o755 }); await chmod('/var/lib/orca-web/acme', 0o755)
    const file = '/etc/nginx/conf.d/orca-web.conf'
    const validate = () => { run(nginx, ['-t']) }; const reload = () => { run('systemctl', ['reload', 'nginx']) }
    // Временный HTTP challenge ещё не публикует панель. При отказе возвращаем исходный файл.
    let previous: string | undefined
    try { previous = await readFile(file, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await applyManagedFiles([{ file, content: nginxConfig(config, false) }], validate, reload)
    try {
      await mkdir('/etc/letsencrypt/renewal-hooks/deploy', { recursive: true, mode: 0o755 })
      await applyManagedFiles([{ file: '/etc/letsencrypt/renewal-hooks/deploy/orca-web-nginx', content: nginxRenewalHook(), mode: 0o755 }], () => {}, () => {})
      process.stdout.write('Выпускаю HTTPS-сертификат для двух поддоменов…\n')
      run('/usr/bin/certbot', ['certonly', '--non-interactive', '--agree-tos', '--webroot', '-w', '/var/lib/orca-web/acme', '--cert-name', `orca-web-${panel}`, '--keep-until-expiring', '-d', panel, '-d', preview, ...(email ? ['--email', email] : ['--register-unsafely-without-email'])], 180_000)
      await applyManagedFiles([{ file, content: nginxConfig(config, true) }], validate, reload)
      run('systemctl', ['enable', '--now', 'certbot.timer'])
    } catch (error) {
      if (previous === undefined) await unlink(file).catch(() => {})
      else await writeFile(file, previous, { mode: 0o644 })
      try { validate(); reload() } catch { /* Сохраняем исходную причину. */ }
      throw error
    }
    return
  }
  const caddyActive = active('caddy')
  if (hasListeners && !caddyActive) throw new Error('Порты 80/443 заняты другим веб-сервером или контейнером. Orca не перехватывает сайт. Выберите SSH в orca-web configure либо подключите подготовленный Caddyfile к вашему proxy.')
  if (caddyActive) {
    const start = run('systemctl', ['show', 'caddy', '--property=ExecStart', '--value'])
    if (!/--config[= ]+\/etc\/caddy\/Caddyfile(?:\s|;|$)/.test(start) || start.includes('--resume')) throw new Error('Caddy запущен с нестандартной конфигурацией. Добавьте блоки Orca вручную или выберите SSH.')
  } else if (!await exists('/usr/bin/caddy')) apt(['caddy'])
  const global = '/etc/caddy/Caddyfile'; const include = '/etc/caddy/orca-web.caddy'
  const previous = await readFile(global, 'utf8')
  const importLine = `import ${include}`
  const content = previous.split('\n').some(line => line.trim() === importLine) ? previous : `${previous}\n# Orca Web\n${importLine}\n`
  process.stdout.write('Подключаю Orca к Caddy; сертификаты и продление настраиваются автоматически.\n')
  await applyManagedFiles([{ file: include, content: `${marker}${caddyConfig(config)}` }, { file: global, content, allowExisting: true }],
    () => { run('/usr/bin/caddy', ['validate', '--config', global, '--adapter', 'caddyfile']) },
    () => { run('systemctl', [active('caddy') ? 'reload' : 'start', 'caddy']); run('systemctl', ['enable', 'caddy']) })
}

async function closeManagedHttps(): Promise<void> {
  const nginxFile = '/etc/nginx/conf.d/orca-web.conf'
  if (await exists(nginxFile)) {
    await applyManagedFiles([{ file: nginxFile, content: `${marker}# Закрытый доступ: публичные маршруты Orca отключены.\n` }],
      () => { run('/usr/sbin/nginx', ['-t']) }, () => { if (active('nginx')) run('systemctl', ['reload', 'nginx']) })
  }
  const caddyFile = '/etc/caddy/orca-web.caddy'
  if (await exists(caddyFile)) {
    await applyManagedFiles([{ file: caddyFile, content: `${marker}# Закрытый доступ: публичные маршруты Orca отключены.\n` }],
      () => { run('/usr/bin/caddy', ['validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']) }, () => { if (active('caddy')) run('systemctl', ['reload', 'caddy']) })
  }
}

async function stopLegacyProxy(options: ProvisionOptions, config: WebConfig): Promise<void> {
  const file = '/etc/systemd/system/orca-web-proxy.service'
  if (!await exists(file)) return
  const unit = await readFile(file, 'utf8')
  if (!unit.includes(`User=${options.user}\n`) || !unit.includes('/usr/bin/caddy') || !unit.includes(join(dirname(options.configFile), 'Caddyfile'))) throw new Error('Существующий orca-web-proxy.service относится к другой установке; автоматическая настройка остановлена')
  const legacyFile = join(dirname(options.configFile), 'Caddyfile')
  const info = await lstat(legacyFile)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Legacy Caddyfile должен быть обычным файлом')
  const content = await readFile(legacyFile, 'utf8')
  const domains = [...content.matchAll(/^([a-z0-9.-]+) \{$/gmi)].map(match => match[1])
  if (domains.length !== 2 || content !== caddyConfig({ ...config, mode: 'proxy', origin: `https://${parseHostname(domains[0])}`, previewOrigin: `https://${parseHostname(domains[1])}` })) throw new Error('Legacy Caddyfile изменён и может обслуживать другие сайты. Файл сохранён; перенесите дополнительные сайты вручную перед повтором автонастройки. Новые блоки Orca — Caddyfile.generated.')
  if (active('orca-web-proxy')) run('systemctl', ['stop', 'orca-web-proxy.service'])
  run('systemctl', ['disable', 'orca-web-proxy.service'])
}

export interface ProvisionOptions { configFile: string; base: string; user: string; home: string; appOnly?: boolean }
function restoreSettings(options: ProvisionOptions, previous?: WebConfig): void {
  // Файлы пользовательской конфигурации изменяем с его UID, включая откат.
  const code = `import os,sys,json,uuid\nfile,value=sys.argv[1:3]\nfd=os.open(os.path.dirname(file),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)\ntry:\n if value:\n  name='.orca-restore-'+uuid.uuid4().hex\n  out=os.open(name,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600,dir_fd=fd)\n  try:\n   with os.fdopen(out,'w') as handle: handle.write(value+'\\n'); handle.flush(); os.fsync(handle.fileno())\n   os.replace(name,os.path.basename(file),src_dir_fd=fd,dst_dir_fd=fd)\n  finally:\n   try: os.unlink(name,dir_fd=fd)\n   except FileNotFoundError: pass\n try: os.unlink('setup-previous.json',dir_fd=fd)\n except FileNotFoundError: pass\nfinally: os.close(fd)\n`
  execFileSync('/usr/sbin/runuser', ['-u', options.user, '--', '/usr/bin/python3', '-I', '-c', code, options.configFile, previous ? JSON.stringify(previous, null, 2) : ''], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 })
}
export async function provisionWeb(options: ProvisionOptions): Promise<void> {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Автонастройка выполняется на Linux с административными правами. Повторите установщик через sudo.')
  if (!/^[a-z_][a-z0-9_-]*\$?$/.test(options.user)) throw new Error('Некорректный пользователь сервиса')
  for (const path of [options.configFile, options.base, options.home]) if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Некорректный путь сервиса')
  const account = run('getent', ['passwd', options.user]).trim().split(':'); const uid = Number(account[2])
  if (!Number.isSafeInteger(uid) || account[0] !== options.user || account[5] !== options.home) throw new Error('Пользователь сервиса не соответствует HOME')
  const config = parseWebConfig(await readOwnedJson(options.configFile, uid))
  if (config.configDir !== dirname(options.configFile)) throw new Error('Каталог конфигурации не соответствует config.json')
  const plan = options.appOnly ? { schemaVersion: 1, provision: true, email: '' } : await readOwnedJson(join(config.configDir, 'setup-plan.json'), uid)
  if (!record(plan) || plan.schemaVersion !== 1 || plan.provision !== true || typeof plan.email !== 'string' || plan.email.length > 254 || plan.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(plan.email)) throw new Error('Нет подтверждённого плана автонастройки')
  const email = plan.email
  const previousFile = join(config.configDir, 'setup-previous.json')
  const previous = !options.appOnly && await exists(previousFile) ? parseWebConfig(await readOwnedJson(previousFile, uid)) : undefined
  if (previous && previous.configDir !== config.configDir) throw new Error('Каталог прежней конфигурации не соответствует этой установке')
  if (!await exists('/run/systemd/system')) {
    if (previous) restoreSettings(options, previous)
    throw new Error(`systemd недоступен (например, контейнер без systemd). ${previous ? 'Прежняя конфигурация восстановлена.' : 'Настройки сохранены.'} Ручной запуск: ${join(options.base, 'bin/orca-web')} start`)
  }
  const services = ['orca-web', 'orca-web-proxy', 'nginx', 'caddy'].map(name => ({ name, active: active(name), enabled: (() => { try { run('systemctl', ['is-enabled', '--quiet', name]); return true } catch { return false } })() }))
  const systemFiles = ['/etc/systemd/system/orca-web.service', '/etc/systemd/system/orca-web-update.service', '/etc/sudoers.d/orca-web-update', '/etc/nginx/conf.d/orca-web.conf', '/etc/caddy/Caddyfile', '/etc/caddy/orca-web.caddy', '/etc/letsencrypt/renewal-hooks/deploy/orca-web-nginx']
  await provisionTransaction(systemFiles, async () => {
    // Отсутствие DNS выясняем до перезапуска работающей панели и остановки legacy proxy.
    if (config.mode === 'proxy' && !options.appOnly) for (const host of hosts(config)) {
      try { await lookup(host, { all: true }) }
      catch { throw new Error(`Для ${host} ещё нет DNS-записи. Создайте A/AAAA на IP сервера и повторите установщик.`) }
    }
    const launcher = join(options.base, 'bin/orca-web')
    const service = { user: options.user, home: options.home, launcher, path: `${join(options.base, 'current/node/bin')}:${join(options.home, '.local/bin')}:/usr/local/bin:/usr/bin:/bin`, configFile: options.configFile, base: options.base }
    const unit = '/etc/systemd/system/orca-web.service'; const worker = '/etc/systemd/system/orca-web-update.service'
    if (await exists(unit)) {
      const previous = await readFile(unit, 'utf8')
      if (!previous.includes(`User=${options.user}\n`) || !previous.includes('Description=Orca Web\n')) throw new Error('Существующий orca-web.service принадлежит другой установке. Автоматическая настройка остановлена.')
    }
    process.stdout.write(`Настраиваю автозапуск Orca от пользователя ${options.user}…\n`)
    if (await exists(worker)) {
      const previous = await readFile(worker, 'utf8')
      if (!previous.includes(`User=${options.user}\n`) || !previous.includes('Description=Orca Web update worker\n')) throw new Error('Существующий update worker принадлежит другой установке; файл сохранён.')
    }
    const files: ManagedFile[] = [{ file: unit, content: marker + serviceUnit(service), allowExisting: true }, { file: worker, content: marker + updateWorkerUnit(service), allowExisting: true }]
    if (uid !== 0) {
      if (!await exists('/usr/sbin/visudo')) apt(['sudo'])
      if (await exists('/etc/sudoers.d/orca-web-update')) {
        const previous = (await readFile('/etc/sudoers.d/orca-web-update', 'utf8')).replace(marker, '').trim()
        if (previous !== updateSudoers(options.user).trim()) throw new Error('Существующий sudoers принадлежит другой установке; файл сохранён.')
      }
      files.push({ file: '/etc/sudoers.d/orca-web-update', content: marker + updateSudoers(options.user), allowExisting: true, mode: 0o440 })
    }
    await applyManagedFiles(files, () => {
      run('systemd-analyze', ['verify', '--man=no', unit, worker])
      if (uid !== 0) run('/usr/sbin/visudo', ['-cf', '/etc/sudoers.d/orca-web-update'])
    }, () => { run('systemctl', ['daemon-reload']); run('systemctl', ['enable', 'orca-web.service']); run('systemctl', ['restart', 'orca-web.service']) })
    let health: unknown
    for (let attempt = 0; attempt < 20; attempt++) {
      try { health = await localHealth(config); break } catch { await delay(500) }
    }
    if (!record(health) || health.status !== 'ready') throw new Error('Сервис установлен, но не прошёл health-проверку. Диагностика: journalctl -u orca-web.service -n 50')
    const manifest = JSON.parse(await readFile(options.appOnly ? join(options.base, 'current/app/package.json') : join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')) as { version: string }
    if (health.version !== manifest.version || !options.appOnly && typeof health.instance !== 'string') throw new Error('На порту отвечает другой экземпляр или другая версия Orca; проверьте вручную запущенные процессы.')
    if (!options.appOnly) {
      await stopLegacyProxy(options, config)
      if (config.mode === 'local') await closeManagedHttps()
    }
    if (config.mode === 'proxy' && !options.appOnly) {
      await configureHttps(config, email)
      process.stdout.write('Проверяю доступность HTTPS с сертификатом…\n')
      let ready = false
      for (let attempt = 0; attempt < 12; attempt++) {
        if (await publicOriginsReady(config, { version: manifest.version, instance: health.instance as string })) { ready = true; break }
        await delay(1000)
      }
      if (!ready) throw new Error(`HTTPS панели или предпросмотра ещё не подтверждён. Проверьте DNS обоих доменов и доступность 80/443; повторите установщик. Существующие аккаунты сохранены.`)
    }
  }, async () => {
    restoreSettings(options, previous)
    run('systemctl', ['daemon-reload'])
    for (const state of services) {
      try {
        if (state.enabled) run('systemctl', ['enable', state.name])
        else run('systemctl', ['disable', state.name])
        if (state.active) run('systemctl', [state.name === 'nginx' || state.name === 'caddy' ? 'reload' : 'restart', state.name])
        else run('systemctl', ['stop', state.name])
      } catch (error) { if (state.active || state.enabled) throw error }
    }
    if (previous) process.stdout.write('Прежние настройки, маршруты и состояние сервисов восстановлены.\n')
  })
  if (!options.appOnly) restoreSettings(options)
  if (options.appOnly) { process.stdout.write('Сервис приложения подготовлен и проверен локально для обновления.\n'); return }
  process.stdout.write(`\n✓ Orca Web запущена и проверена: ${config.origin}\nПользователь сервиса: ${options.user}\n`)
  if (config.mode === 'local') process.stdout.write(sshInstructions(process.env.ORCA_WEB_SSH_TARGET, config.port, config.previewPort))
  process.stdout.write('CLI-агенты используют отдельную авторизацию. Установите нужный CLI и войдите под пользователем сервиса; orca-web doctor покажет доступные агенты.\n')
}
