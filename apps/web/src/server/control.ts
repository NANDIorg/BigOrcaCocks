import { createRequire } from 'node:module'
import { homedir, userInfo } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createAgentDiscovery } from '@orca-board/runtime'
import { configFile, setup, installService, installAppService, installationDirectory } from './setup.ts'
import { loadWebConfig } from './config.ts'
import { runWebServer } from './start.ts'
import { updateWeb } from './update.ts'
import { runBrowserUpdateWorker, recoverBrowserUpdate } from './browser-updates.ts'
import { addWebAccount } from './accounts.ts'
import { localHealth } from './health.ts'
import { warnRoot } from './privileges.ts'
import { provisionWeb } from './provision.ts'
import { installAgents, loginAgent } from './agents-setup.ts'
import { createTerminalUi } from './terminal-ui.ts'
import { parseWebArguments, printWebHelp, webVersion } from './command-help.ts'

const command = process.argv[2] ?? 'help'
try {
  const invocation = parseWebArguments(process.argv.slice(2))
  const args = invocation.kind === 'command' ? invocation.args : []
  if (invocation.kind === 'help') await printWebHelp(invocation.scope)
  else if (invocation.kind === 'version') process.stdout.write(`Orca Web ${await webVersion()}\n`)
  else if (command === 'setup' || command === 'configure') {
    const automatic = await setup({ reconfigure: command === 'configure' })
    if (automatic && process.env.ORCA_WEB_INSTALLER !== '1') {
      const options = { configFile: configFile(), base: installationDirectory(), user: userInfo().username, home: homedir() }
      if (process.getuid?.() === 0) await provisionWeb(options)
      else throw new Error('Для автоматических системных изменений повторите проверенный установщик через административное SSH-подключение.')
    }
  }
  else if (command === 'provision' || command === 'provision-app') {
    await provisionWeb({ configFile: args[1], base: args[2], user: args[3], home: args[4], appOnly: command === 'provision-app' })
  }
  else if (command === 'start') await runWebServer(configFile())
  else if (command === 'agents' && args[1] === 'install') await installAgents()
  else if (command === 'agents' && args[1] === 'login') loginAgent(args[2])
  else if (command === 'service' && args[1] === 'install') { await installService(); createTerminalUi().success('Автозапуск настроен', ['Сервисы Orca установлены и запущены.']) }
  else if (command === 'service' && args[1] === 'install-app') { await installAppService(); createTerminalUi().success('Автозапуск настроен', ['Сервис Orca установлен и запущен.']) }
  else if (command === 'update') await updateWeb()
  else if (command === 'update-worker' || command === 'update-recover') {
    if (process.platform !== 'linux' || process.env.ORCA_WEB_MANAGED !== '1') throw new Error('Worker запускается настроенным сервисом Linux')
    warnRoot()
    if (command === 'update-worker') await runBrowserUpdateWorker()
    else await recoverBrowserUpdate()
  }
  else if (command === 'user' && args[1] === 'add') {
    const config = await loadWebConfig(configFile())
    if (!process.stdin.isTTY) throw new Error('Добавление аккаунта выполняется в интерактивном терминале')
    const ui = createTerminalUi(); ui.panel('Новый оператор', ['Аккаунт даёт доступ к панели и проектам этого сервера.'])
    const login = await ui.ask('Логин оператора: ')
    const password = await ui.password('Пароль (не отображается): ')
    if (password !== await ui.password('Повторите пароль: ')) throw new Error('Пароли не совпадают')
    await addWebAccount({ configDir: config.configDir, login, password })
    ui.success('Аккаунт создан', [`Оператор: ${login}`, `Перезапустите сервис: ${process.getuid?.() === 0 ? '' : 'sudo '}systemctl restart orca-web.service`])
  }
  else if (command === 'status') {
    const config = await loadWebConfig(configFile())
    await localHealth(config)
    createTerminalUi().success('Orca Web работает', [`Панель: ${config.origin}`, `Предпросмотр: ${config.previewOrigin}`])
  } else if (command === 'doctor') {
    if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Требуется bundled Node 24')
    createRequire(import.meta.url)('node-pty')
    const config = await loadWebConfig(configFile())
    const git = execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim()
    const agents = createAgentDiscovery({ env: process.env, home: homedir() }).agentInfos(undefined)
    const ui = createTerminalUi()
    ui.panel(`Orca Web ${await webVersion()}  /  Проверка окружения`, [`Node ${process.versions.node}`, git, 'Терминалы: native PTY загружен', `Панель: ${config.origin}`])
    ui.heading('Установленные CLI-агенты')
    const installed = agents.filter(agent => agent.installed && agent.id !== 'shell')
    for (const agent of installed) ui.entry(agent.title, agent.version || agent.id)
    if (!installed.length) ui.write('CLI-агенты не найдены. Установить: orca-web agents install\n')
    else ui.write('\nВход в Codex или Claude: orca-web agents login <codex|claude>\n')
  }
  else throw new Error('Неизвестная команда. Выполните orca-web help')
} catch (error) {
  const message = error instanceof Error ? error.message : 'Ошибка Orca Web'
  if (process.stderr.isTTY && ['setup', 'configure', 'provision', 'provision-app', 'agents'].includes(command)) createTerminalUi(process.stderr).failure(message)
  else process.stderr.write(`${message}\n`)
  process.exitCode = 1
}
