import type { WebConfig } from './config.ts'

function systemd(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('Некорректное значение systemd')
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`
}
export function serviceUnit(options: { user: string; home: string; launcher: string; path: string; configFile?: string; base?: string }): string {
  if (!/^[a-z_][a-z0-9_-]*\$?$/.test(options.user)) throw new Error('Некорректный пользователь Linux')
  // WorkingDirectory не разбирает кавычки как ExecStart; ~ означает HOME указанного User.
  return `[Unit]\nDescription=Orca Web\nAfter=network.target\n\n[Service]\nType=exec\nUser=${options.user}\nWorkingDirectory=~\nExecStart=${systemd(options.launcher)} start\nEnvironment=${systemd(`PATH=${options.path}`)}\n${options.configFile ? `Environment=${systemd(`ORCA_WEB_CONFIG=${options.configFile}`)}\n` : ''}${options.base ? `Environment=${systemd(`ORCA_WEB_HOME=${options.base}`)}\nEnvironment=ORCA_WEB_MANAGED=1\n` : ''}UMask=0077\nRestart=on-failure\nRestartSec=3\nKillMode=mixed\nTimeoutStopSec=60\n\n[Install]\nWantedBy=multi-user.target\n`
}
export function updateWorkerUnit(options: Parameters<typeof serviceUnit>[0] & { base: string }): string {
  return serviceUnit(options).replace('Description=Orca Web', 'Description=Orca Web update worker')
    .replace('Type=exec', 'Type=oneshot').replace(' start\n', ' update-worker\n')
    .replace(' update-worker\n', ` update-worker\nExecStopPost=${systemd(`${options.base}/recovery/node/bin/node`)} ${systemd(`${options.base}/recovery/app/control.mjs`)} update-recover\n`)
    .replace('Restart=on-failure\nRestartSec=3\n', '').replace('TimeoutStopSec=60', 'TimeoutStartSec=600\nTimeoutStopSec=60')
    .replace('\n[Install]\nWantedBy=multi-user.target\n', '')
}
/** Только три фиксированные команды; updater и приложение всегда работают под обычным User. */
export function updateSudoers(user: string): string {
  if (!/^[a-z_][a-z0-9_-]*\$?$/.test(user)) throw new Error('Некорректный пользователь Linux')
  return `${user} ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block orca-web-update.service, /usr/bin/systemctl stop orca-web.service, /usr/bin/systemctl start orca-web.service\n`
}
export function caddyConfig(config: WebConfig): string {
  if (config.mode !== 'proxy') throw new Error('Caddy требуется только в режиме HTTPS')
  const app = new URL(config.origin).host; const preview = new URL(config.previewOrigin).host
  if (!/^[a-z0-9.-]+(?::\d+)?$/i.test(app) || !/^[a-z0-9.-]+(?::\d+)?$/i.test(preview)) throw new Error('Некорректные имена HTTPS hosts')
  return `${app} {\n  reverse_proxy 127.0.0.1:${config.port}\n}\n\n${preview} {\n  reverse_proxy 127.0.0.1:${config.previewPort} {\n    header_up -Cookie\n  }\n}\n`
}
export function proxyUnit(options: { user: string; home: string; caddy: string; file: string }): string {
  const base = serviceUnit({ ...options, launcher: options.caddy, path: '/usr/local/bin:/usr/bin:/bin' })
  return base.replace('Description=Orca Web', 'Description=Orca Web HTTPS').replace(`ExecStart=${systemd(options.caddy)} start`, `ExecStart=${systemd(options.caddy)} run --config ${systemd(options.file)}`)
    .replace('UMask=0077', 'UMask=0077\nAmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE')
}
