import { execFileSync } from 'node:child_process'
import { stdin, stdout } from 'node:process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { installationDirectory } from './setup.ts'
import { createTerminalUi } from './terminal-ui.ts'

export function agentPackage(id: string): string {
  if (id === 'codex') return '@openai/codex@latest'
  if (id === 'claude') return '@anthropic-ai/claude-code@latest'
  throw new Error('Поддерживаются агенты codex и claude')
}
const agentEnvironment = () => ({ ...process.env, PATH: [join(installationDirectory(), 'current/node/bin'), join(homedir(), '.local/bin'), process.env.PATH].filter(Boolean).join(delimiter) })
export async function installAgents(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Выбор CLI-агентов выполняется в интерактивном терминале')
  const ui = createTerminalUi()
  ui.panel('CLI-агенты  /  Необязательный этап', ['Авторизация и подписка провайдера выполняются отдельно.', 'Пароль Orca их не заменяет.'])
  const answer = await ui.select('Какие CLI установить', [
    { value: '0', label: 'Пропустить', hint: 'Позже: orca-web agents install' },
    { value: '1', label: 'Codex' }, { value: '2', label: 'Claude Code' },
    { value: '3', label: 'Codex и Claude Code' },
  ], '0')
  if (answer === '0') return
  const agents = answer === '1' ? ['codex'] : answer === '2' ? ['claude'] : answer === '3' ? ['codex', 'claude'] : []
  if (!agents.length) throw new Error('Неизвестный выбор CLI; повторная установка: orca-web agents install')
  if (process.getuid?.() === 0 && process.env.ORCA_WEB_ACK_ROOT !== '1') {
    ui.write('Предупреждение: сторонние CLI будут установлены и запущены под root.\n')
    if ((await ui.ask('Для подтверждения введите ROOT: ')).trim() !== 'ROOT') throw new Error('Установка CLI отменена')
  }
  ui.write('Загружаются официальные CLI-пакеты в ваш домашний каталог. При установке могут выполняться скрипты их производителей.\n')
  if ((await ui.ask('Для установки выбранных CLI введите INSTALL: ')).trim() !== 'INSTALL') throw new Error('Установка CLI отменена')
  ui.panel('Установка CLI-агентов', [agents.map(id => id === 'codex' ? 'Codex' : 'Claude Code').join(' + '), 'Журнал установки появится ниже.'])
  const node = join(installationDirectory(), 'current/node/bin/node')
  const npm = join(installationDirectory(), 'current/node/lib/node_modules/npm/bin/npm-cli.js')
  execFileSync(node, [npm, 'install', '--global', '--prefix', join(homedir(), '.local'), '--no-audit', '--no-fund', ...agents.map(agentPackage)], { stdio: 'inherit', env: agentEnvironment(), timeout: 300_000 })
  for (const id of agents) {
    execFileSync(join(homedir(), '.local/bin', id), ['--version'], { stdio: 'inherit', env: agentEnvironment(), timeout: 15_000 })
    stdout.write(`Вход под этим же пользователем: orca-web agents login ${id}\n`)
  }
  ui.success('CLI-агенты установлены', ['Войдите в аккаунты провайдеров под этим же пользователем сервера.'])
}
export function loginAgent(id: string): void {
  agentPackage(id)
  execFileSync(join(homedir(), '.local/bin', id), id === 'codex' ? ['login', '--device-auth'] : ['auth', 'login'], { stdio: 'inherit', env: agentEnvironment() })
}
