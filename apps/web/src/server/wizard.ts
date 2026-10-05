import { isIP } from 'node:net'
import { join, isAbsolute, normalize } from 'node:path'

export interface WizardIO { ask(prompt: string): Promise<string>; write(value: string): void }
export interface SetupChoices { projectRoot: string; mode: 'local' | 'proxy'; domain?: string; previewDomain?: string; login?: string; email?: string; provision: boolean; gitName?: string; gitEmail?: string }
export interface SetupContext {
  home: string; root: boolean; installer: boolean; rootAcknowledged?: boolean
  gitIdentityMissing?: boolean; gitName?: string; gitEmail?: string
  accountsExist?: boolean
  running?: boolean
  existing?: { projectRoots: string[]; mode: 'local' | 'proxy'; origin: string; previewOrigin: string }
}

export function parseHostname(value: string): string {
  const raw = value.trim()
  if (/[\s\x00-\x1f\x7f]/.test(raw)) throw new Error('Домен должен быть одним именем без пробелов')
  let hostname = raw.toLowerCase()
  if (/^https:\/\//i.test(raw)) {
    const url = new URL(raw)
    if (url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) throw new Error('Введите домен без порта, пути и параметров, например orca.example.com')
    hostname = url.hostname
  }
  if (hostname.length > 253 || isIP(hostname) || !hostname.includes('.') || !hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('Введите домен вида orca.example.com, без IP, порта или пути')
  return hostname
}
const cancelled = () => new Error('Настройка отменена. Существующие аккаунты и конфигурация сохранены.')
async function field(io: WizardIO, prompt: string, validate: (value: string) => string, fallback = ''): Promise<string> {
  for (;;) {
    try { return validate((await io.ask(prompt)).trim() || fallback) }
    catch (error) { io.write(`${error instanceof Error ? error.message : 'Некорректное значение'}\n`) }
  }
}

/** Сбор решения отделён от записи: отказ на любом предупреждении не меняет конфигурацию. */
export async function collectSetup(io: WizardIO, context: SetupContext): Promise<SetupChoices> {
  io.write('\n╭──────────────────────────────────────────╮\n│  Orca Web · пошаговая настройка сервера   │\n╰──────────────────────────────────────────╯\n\n')
  if (context.root && !context.rootAcknowledged) {
    io.write('Предупреждение: Orca и CLI-агенты получат права root, включая файлы сайта и всего сервера. Каталог проектов не является sandbox. Рекомендуется обычный пользователь.\n')
    if ((await io.ask('Для продолжения введите ROOT (Enter — отмена): ')).trim() !== 'ROOT') throw cancelled()
  }
  io.write('Шаг 1/5 · Как открывать Orca\n1. Через SSH — закрытый доступ, без домена и открытых портов (рекомендуется).\n2. Через домен и HTTPS — форма входа доступна из интернета.\n')
  const defaultAccess = context.existing?.mode === 'proxy' ? '2' : '1'
  const access = await field(io, `Способ доступа [${defaultAccess}]: `, value => {
    if (!['1', '2'].includes(value)) throw new Error('Выберите 1 (SSH) или 2 (домен)')
    return value
  }, defaultAccess)
  io.write('\nШаг 2/5 · Где находятся проекты\nЭто родительская папка Git-репозиториев: каждый проект — отдельная папка внутри неё.\nЭто не каталог установки Orca. Папку можно поменять позже командой orca-web configure; файлы проектов не перемещаются.\nАгенты могут работать со всеми файлами, доступными пользователю сервиса.\n')
  const defaultRoot = context.existing?.projectRoots[0] ?? join(context.home, 'projects')
  const projectRoot = await field(io, `Папка с Git-проектами [${defaultRoot}]: `, value => {
    const expanded = value === '~' ? context.home : value.startsWith('~/') ? join(context.home, value.slice(2)) : value
    if (!isAbsolute(expanded) || /[\x00-\x1f\x7f]/.test(expanded) || normalize(expanded) === '/') throw new Error('Укажите абсолютный путь к папке проектов, например /home/orca/projects; корень / использовать нельзя')
    return normalize(expanded)
  }, defaultRoot)
  const choices: SetupChoices = { projectRoot, mode: access === '1' ? 'local' : 'proxy', provision: false }
  io.write('\nШаг 3/5 · Адрес и защита\n')
  if (choices.mode === 'proxy') {
    io.write('Нужны два свободных поддомена: панель и предпросмотр файлов. Например, orca.example.com и preview.example.com.\nЕсли сайт уже работает, используйте отдельные поддомены, а не основной адрес сайта.\n')
    const previous = context.existing?.mode === 'proxy' ? new URL(context.existing.origin).hostname : ''
    choices.domain = await field(io, `Домен Orca${previous ? ` [${previous}]` : ''}: `, parseHostname, previous)
    const previewDefault = context.existing?.mode === 'proxy' ? new URL(context.existing.previewOrigin).hostname : choices.domain.startsWith('orca.') ? `preview.${choices.domain.slice(5)}` : `preview.${choices.domain}`
    choices.previewDomain = await field(io, `Домен предпросмотра [${previewDefault}]: `, value => {
      const host = parseHostname(value); if (host === choices.domain) throw new Error('Домен предпросмотра должен отличаться от домена панели')
      return host
    }, previewDefault)
    io.write('Предупреждение: любой сможет открыть форму входа и пытаться подобрать пароль. Проекты и терминал требуют авторизации; гарантии отсутствия уязвимостей нет. Используйте уникальный длинный пароль.\nHTTPS-сертификаты публикуют имена доменов; автоматический выпуск использует условия центра сертификации.\n')
    if ((await io.ask('Для доступа через интернет введите OPEN (Enter — отмена): ')).trim() !== 'OPEN') throw cancelled()
  } else io.write('Orca слушает только 127.0.0.1. Доступ с компьютера — через уже имеющееся SSH-подключение; в конце будет готовая команда.\n')
  io.write('\nШаг 4/5 · Вход в панель и автоматизация\n')
  if (!(context.accountsExist ?? Boolean(context.existing))) choices.login = await field(io, 'Логин первого оператора [operator]: ', value => {
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(value)) throw new Error('Логин: 3–64 строчных латинских символа, цифры, точка, дефис или подчёркивание')
    return value
  }, 'operator')
  else io.write('Аккаунты, пароли и данные Orca сохраняются.\n')
  if (context.gitIdentityMissing) {
    io.write('Git ещё не знает автора коммитов. Имя и email — подпись изменений, они не создают аккаунт и не заменяют доступ к GitHub.\n')
    const name = context.gitName || 'Orca'; const email = context.gitEmail || 'orca@localhost'
    choices.gitName = await field(io, `Имя автора Git [${name}]: `, value => {
      if (!value || value.length > 128 || /[<>\x00-\x1f\x7f]/.test(value)) throw new Error('Введите имя автора без служебных символов')
      return value
    }, name)
    choices.gitEmail = await field(io, `Email автора Git [${email}]: `, value => {
      if (value.length > 254 || !/^[^\s<>@]+@[^\s<>@]+$/.test(value)) throw new Error('Введите email автора Git')
      return value
    }, email)
  }
  if (choices.mode === 'proxy') choices.email = await field(io, 'Email для уведомлений о сертификате (Enter — без email): ', value => {
    if (value.length > 254 || value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('Укажите корректный email')
    return value
  })
  const closingPublicAccess = context.existing?.mode === 'proxy' && choices.mode === 'local'
  const provisionDefault = context.installer || closingPublicAccess ? 'y' : 'n'
  io.write('Автоматизация установит systemd-сервис и настроит поддерживаемый HTTPS-прокси. Для системных изменений нужны root или sudo.\n')
  choices.provision = (await field(io, `Настроить автозапуск${choices.mode === 'proxy' ? ' и HTTPS' : ''} автоматически [${provisionDefault === 'y' ? 'Y/n' : 'y/N'}]: `, value => {
    if (!['y', 'n', 'да', 'нет'].includes(value.toLowerCase())) throw new Error('Ответьте y или n')
    return ['y', 'да'].includes(value.toLowerCase()) ? 'y' : 'n'
  }, provisionDefault)) === 'y'
  if (closingPublicAccess && !choices.provision) {
    io.write('Предупреждение: при переходе с публичного домена на SSH необходимо отключить прежние маршруты прокси. Это выполняет автонастройка с правами администратора.\n')
    throw new Error('Для закрытия публичного доступа повторите установщик с автонастройкой. Текущие настройки сохранены.')
  }
  if (context.running && choices.provision) {
    io.write('Предупреждение: автонастройка перезапустит работающую Orca. Активные задания и терминалы будут остановлены; сохранённые данные останутся.\n')
    if ((await io.ask('Для перезапуска введите RESTART (Enter — отмена): ')).trim() !== 'RESTART') throw cancelled()
  }
  io.write(`\nШаг 5/5 · Проверьте настройки\nПроекты: ${choices.projectRoot}\nДоступ: ${choices.mode === 'local' ? 'закрытый, SSH → http://localhost:3737' : `https://${choices.domain}`}\n${choices.previewDomain ? `Предпросмотр: https://${choices.previewDomain}\n` : ''}Автонастройка: ${choices.provision ? 'да' : 'нет'}\n`)
  if (!['', 'y', 'да'].includes((await io.ask('Применить настройки [Y/n]: ')).trim().toLowerCase())) throw cancelled()
  return choices
}

export function sshInstructions(target = 'ПОЛЬЗОВАТЕЛЬ@IP_СЕРВЕРА', port = 3737, previewPort = 3738, sshPort = process.env.ORCA_WEB_SSH_PORT): string {
  const safeTarget = /^[a-zA-Z0-9_.@:[\]-]+$/.test(target) && !target.startsWith('-') ? target : 'ПОЛЬЗОВАТЕЛЬ@IP_СЕРВЕРА'
  const sshOption = sshPort && /^\d{1,5}$/.test(sshPort) && Number(sshPort) > 0 && Number(sshPort) <= 65535 && sshPort !== '22' ? ` -p ${sshPort}` : ''
  return `На своём компьютере откройте отдельный терминал:\nssh -N${sshOption} -L ${port}:127.0.0.1:${port} -L ${previewPort}:127.0.0.1:${previewPort} ${safeTarget}\nПока терминал открыт, Orca доступна в браузере: http://localhost:${port}\nЕсли подключаетесь командой ssh my-server, замените адрес сервера на my-server; имя подключения может быть любым.\n`
}
