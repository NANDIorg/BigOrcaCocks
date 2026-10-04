import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createAgentDiscovery } from '@orca-board/runtime'
import { configFile, setup, installService, installAppService } from './setup.ts'
import { loadWebConfig } from './config.ts'
import { runWebServer } from './start.ts'
import { updateWeb } from './update.ts'
import { runBrowserUpdateWorker, recoverBrowserUpdate } from './browser-updates.ts'
import { createInterface } from 'node:readline/promises'
import { addWebAccount } from './accounts.ts'
import { readPassword } from './password.ts'
import { localHealth } from './health.ts'

const command = process.argv[2] ?? 'help'
try {
  if (command === 'setup') await setup()
  else if (command === 'start') await runWebServer(configFile())
  else if (command === 'service' && process.argv[3] === 'install') await installService()
  else if (command === 'service' && process.argv[3] === 'install-app') await installAppService()
  else if (command === 'update') await updateWeb()
  else if (command === 'update-worker' || command === 'update-recover') {
    if (process.platform !== 'linux' || process.getuid?.() === 0 || process.env.ORCA_WEB_MANAGED !== '1') throw new Error('Worker запускается настроенным сервисом Linux')
    if (command === 'update-worker') await runBrowserUpdateWorker()
    else await recoverBrowserUpdate()
  }
  else if (command === 'user' && process.argv[3] === 'add') {
    const config = await loadWebConfig(configFile())
    if (!process.stdin.isTTY) throw new Error('Добавление аккаунта выполняется в интерактивном терминале')
    const prompt = createInterface({ input: process.stdin, output: process.stdout })
    const login = await prompt.question('Логин оператора: '); prompt.close()
    const password = await readPassword('Пароль (не отображается): ')
    if (password !== await readPassword('Повторите пароль: ')) throw new Error('Пароли не совпадают')
    await addWebAccount({ configDir: config.configDir, login, password })
    process.stdout.write('Аккаунт создан. Перезапустите сервис: sudo systemctl restart orca-web.service\n')
  }
  else if (command === 'status') {
    const config = await loadWebConfig(configFile())
    await localHealth(config)
    process.stdout.write(`Orca Web работает: ${config.origin}\n`)
  } else if (command === 'doctor') {
    if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Требуется bundled Node 24')
    createRequire(import.meta.url)('node-pty')
    const config = await loadWebConfig(configFile())
    execFileSync('git', ['--version'], { stdio: 'inherit', timeout: 5000 })
    const agents = createAgentDiscovery({ env: process.env, home: homedir() }).agentInfos(undefined)
    const manifest = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')) as { version: string }
    process.stdout.write(`Orca Web ${manifest.version}: Node ${process.versions.node}, native PTY загружен\n${config.origin}\nАгенты: ${agents.filter(agent => agent.installed).map(agent => agent.id).join(', ') || 'установите CLI выбранного агента и войдите под пользователем сервиса'}\n`)
  } else if (command === 'help') process.stdout.write('orca-web setup | start | status | doctor | update | user add | service install | service install-app\n')
  else throw new Error('Неизвестная команда. Выполните orca-web help')
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Ошибка Orca Web'}\n`); process.exitCode = 1
}
