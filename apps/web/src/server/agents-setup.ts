import { createInterface } from 'node:readline/promises'
import { execFileSync } from 'node:child_process'
import { stdin, stdout } from 'node:process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { installationDirectory } from './setup.ts'

export function agentPackage(id: string): string {
  if (id === 'codex') return '@openai/codex@latest'
  if (id === 'claude') return '@anthropic-ai/claude-code@latest'
  throw new Error('Поддерживаются агенты codex и claude')
}
const agentEnvironment = () => ({ ...process.env, PATH: [join(installationDirectory(), 'current/node/bin'), join(homedir(), '.local/bin'), process.env.PATH].filter(Boolean).join(delimiter) })
export async function installAgents(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Выбор CLI-агентов выполняется в интерактивном терминале')
  const prompt = createInterface({ input: stdin, output: stdout })
  let agents: string[]
  try {
    stdout.write('\nCLI-агенты · необязательный шаг\n0. Пропустить; установить позже\n1. Codex\n2. Claude Code\n3. Оба\nАвторизация и подписка провайдера выполняются отдельно; пароль Orca их не заменяет.\n')
    const answer = (await prompt.question('Какие CLI установить [0]: ')).trim() || '0'
    if (answer === '0') return
    agents = answer === '1' ? ['codex'] : answer === '2' ? ['claude'] : answer === '3' ? ['codex', 'claude'] : []
    if (!agents.length) throw new Error('Выберите 0, 1, 2 или 3; повторная установка: orca-web agents install')
    if (process.getuid?.() === 0 && process.env.ORCA_WEB_ACK_ROOT !== '1') {
      stdout.write('Предупреждение: сторонние CLI будут установлены и запущены под root.\n')
      if ((await prompt.question('Для подтверждения введите ROOT: ')).trim() !== 'ROOT') throw new Error('Установка CLI отменена')
    }
    stdout.write('Загружаются официальные CLI-пакеты в ваш домашний каталог. При установке могут выполняться скрипты их производителей.\n')
    if ((await prompt.question('Для установки выбранных CLI введите INSTALL: ')).trim() !== 'INSTALL') throw new Error('Установка CLI отменена')
  } finally { prompt.close() }
  const node = join(installationDirectory(), 'current/node/bin/node')
  const npm = join(installationDirectory(), 'current/node/lib/node_modules/npm/bin/npm-cli.js')
  execFileSync(node, [npm, 'install', '--global', '--prefix', join(homedir(), '.local'), '--no-audit', '--no-fund', ...agents.map(agentPackage)], { stdio: 'inherit', env: agentEnvironment(), timeout: 300_000 })
  for (const id of agents) {
    execFileSync(join(homedir(), '.local/bin', id), ['--version'], { stdio: 'inherit', env: agentEnvironment(), timeout: 15_000 })
    stdout.write(`Вход под этим же пользователем: orca-web agents login ${id}\n`)
  }
}
export function loginAgent(id: string): void {
  agentPackage(id)
  execFileSync(join(homedir(), '.local/bin', id), id === 'codex' ? ['login', '--device-auth'] : ['auth', 'login'], { stdio: 'inherit', env: agentEnvironment() })
}
