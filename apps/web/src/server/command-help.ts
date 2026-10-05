import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTerminalUi } from './terminal-ui.ts'

interface CommandHelp { name: string; group: string; description: string; argument?: string; count?: number; hidden?: boolean }
const commands: CommandHelp[] = [
  { name: 'setup', group: 'Настройка', description: 'Первичная настройка проектов, доступа и аккаунта.' },
  { name: 'configure', group: 'Настройка', description: 'Изменить настройки; аккаунты и данные сохраняются.' },
  { name: 'start', group: 'Сервер', description: 'Запустить Orca в текущем терминале. Ctrl+C останавливает сервер.' },
  { name: 'status', group: 'Сервер', description: 'Проверить доступность работающего сервера.' },
  { name: 'doctor', group: 'Сервер', description: 'Проверить Node, Git, терминалы и установленные CLI-агенты.' },
  { name: 'update', group: 'Сервер', description: 'Обновить до стабильного Web-релиза с резервной копией.' },
  { name: 'agents install', group: 'CLI-агенты', description: 'Выбрать и установить Codex, Claude Code или оба CLI.' },
  { name: 'agents login', group: 'CLI-агенты', argument: '<codex|claude>', count: 1, description: 'Войти в аккаунт провайдера под пользователем Orca.' },
  { name: 'user add', group: 'Аккаунты', description: 'Добавить оператора панели; пароль вводится скрыто.' },
  { name: 'service install', group: 'Автозапуск', description: 'Установить systemd; в режиме HTTPS — отдельный Caddy-прокси.' },
  { name: 'service install-app', group: 'Автозапуск', description: 'Установить только systemd-сервис Orca и updater.' },
  { name: 'provision', group: '', argument: 'CONFIG BASE USER HOME', count: 4, description: 'Системная настройка проверенным установщиком.', hidden: true },
  { name: 'provision-app', group: '', argument: 'CONFIG BASE USER HOME', count: 4, description: 'Системная настройка приложения проверенным установщиком.', hidden: true },
  { name: 'update-worker', group: '', description: 'Служебный worker обновления systemd.', hidden: true },
  { name: 'update-recover', group: '', description: 'Восстановление прерванного обновления systemd.', hidden: true },
]
const usage = (command: CommandHelp) => `orca-web ${command.name}${command.argument ? ` ${command.argument}` : ''}`
type WebInvocation = { kind: 'command'; args: string[] } | { kind: 'help'; scope: string } | { kind: 'version' }

/** Проверяем форму команды до конфигурации, ввода паролей и системных действий. */
export function parseWebArguments(args: string[]): WebInvocation {
  if (args.length === 1 && ['--version', '-v'].includes(args[0])) return { kind: 'version' }
  const help = !args.length || args[0] === 'help' || args.some(value => ['--help', '-h'].includes(value))
  const path = (args[0] === 'help' ? args.slice(1) : args).filter(value => !['--help', '-h'].includes(value))
  const name = path.join(' ')
  if (help && !path.length) return { kind: 'help', scope: '' }
  const match = commands.find(command => command.name.split(' ').every((word, index) => path[index] === word))
  if (!match) {
    if (path.length === 1 && commands.some(command => !command.hidden && command.name.startsWith(`${name} `))) return { kind: 'help', scope: name }
    throw new Error(`Неизвестная команда или флаг: ${name}. Справка: orca-web --help`)
  }
  const parameters = path.slice(match.name.split(' ').length)
  const count = match.count ?? 0
  if (parameters.length !== count && !(help && parameters.length === 0)) throw new Error(`Использование: ${usage(match)}. Справка: orca-web ${match.name} --help`)
  if (parameters.some(value => value.startsWith('-'))) throw new Error(`Неизвестный флаг. Использование: ${usage(match)}`)
  if (match.name === 'agents login' && parameters.length && !['codex', 'claude'].includes(parameters[0])) throw new Error('Выберите провайдера: orca-web agents login <codex|claude>')
  return help ? { kind: 'help', scope: match.name } : { kind: 'command', args: path }
}

export async function webVersion(): Promise<string> {
  const directory = dirname(fileURLToPath(import.meta.url))
  for (const filename of [join(directory, 'package.json'), join(directory, '../../package.json')]) {
    try {
      const manifest = JSON.parse(await readFile(filename, 'utf8')) as { name: string; version: string }
      if (manifest.name !== '@orca-board/web' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Некорректная версия пакета Orca Web')
      return manifest.version
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  throw new Error('Не найден manifest Orca Web')
}

export async function printWebHelp(scope = ''): Promise<void> {
  const ui = createTerminalUi()
  ui.panel(`Orca Web ${await webVersion()}`, ['Управление вашим сервером', `orca-web ${scope || '<команда>'} [параметры]`])
  const selected = commands.filter(command => !command.hidden && (!scope || command.name === scope || command.name.startsWith(`${scope} `)))
  for (const group of new Set(selected.map(command => command.group))) {
    ui.heading(group)
    for (const command of selected.filter(command => command.group === group)) ui.entry(usage(command), command.description)
  }
  ui.heading('Справка и версия')
  ui.entry('orca-web help [команда]', 'Общая справка или справка выбранной команды.')
  ui.entry('--help, -h', 'Показать справку без запуска команды.')
  ui.entry('--version, -v', 'Версия установленного Web-пакета.')
  if (!scope) {
    ui.heading('Примеры')
    ui.write('  orca-web configure\n  orca-web agents login codex\n  orca-web agents --help\n')
  }
  ui.write('\nПути: ORCA_WEB_HOME — установка, ORCA_WEB_CONFIG — config.json.\nNO_COLOR=1 отключает стили.\n')
}
