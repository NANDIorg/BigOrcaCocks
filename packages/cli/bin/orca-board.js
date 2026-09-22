#!/usr/bin/env node
// orca-board — тонкий клиент к unix-сокету приложения. Без зависимостей.
// Вызывается агентами из их Bash. Состоянием владеет приложение.
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SOCKET = process.env.ORCA_SOCKET ?? join(homedir(), '.orca-board', 'orca.sock')

const HELP = `orca-board — управление доской агентов

Человек:
  coordinator start --objective "..."     открыть Claude Code-координатора в приложении

Координатор:
  agents list      известные агенты: установлен ли, включён ли в проекте, версия
  roles list       роли проекта: id, название, агент, модель, включён ли агент
  columns list     колонки доски: id, название, kind
  task list
  task create --title "..." [--spec "..."] --role <id из roles list> [--dep <id>]...
  task move --task <id> --status <id колонки из columns list>
  worker start --task <id>
  worker read --dispatch <id> [--limit 80]
  check [--wait] [--types worker_done,question,escalation,task_ready] [--timeout-ms 900000]
  question list
  question answer --question <id> --answer "..."
  review info --task <id>                 diff-stat и коммиты ветки задачи
  review accept --task <id>               слить в текущую ветку, убрать worktree, задача → done
  review reject --task <id> --feedback "..."   задача → ready с замечаниями для перезапуска
  task delete --task <id>
  events list

Воркер (ORCA_DISPATCH_ID уже в окружении):
  done --summary "..." [--files a.ts,b.ts]
  ask --question "..." [--options a,b,c] [--no-wait]     блокируется до ответа

Общее: --socket <path>, --project <id> (иначе $ORCA_PROJECT или активный проект в приложении).
Сокет: $ORCA_SOCKET или ~/.orca-board/orca.sock`

const argv = process.argv.slice(2)
if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  console.log(HELP)
  process.exit(0)
}

// method: первые одно или два слова без "--"
const words = []
while (argv.length && !argv[0].startsWith('--') && words.length < 2) words.push(argv.shift())
let method = words.join('.')
if (method === 'done') method = 'worker.done'
if (method === 'ask') method = 'worker.ask'

const params = {}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const key = a.slice(2)
  const next = argv[i + 1]
  const value = next !== undefined && !next.startsWith('--') ? (i++, next) : true
  if (key === 'dep' || key === 'deps') {
    params.dep = [...(params.dep ?? []), ...String(value).split(',')]
  } else if (key.startsWith('no-')) {
    params[key.slice(3)] = false
  } else {
    params[key] = value
  }
}

const socketPath = params.socket ?? SOCKET
delete params.socket
delete params.json

const request = {
  id: String(Date.now()),
  method,
  params,
  dispatchId: process.env.ORCA_DISPATCH_ID,
  taskId: process.env.ORCA_TASK_ID,
  projectId: params.project ?? process.env.ORCA_PROJECT
}
delete params.project

const sock = connect(socketPath)
let buf = ''
sock.setEncoding('utf8')
sock.on('connect', () => sock.write(JSON.stringify(request) + '\n'))
sock.on('data', (chunk) => {
  buf += chunk
  const nl = buf.indexOf('\n')
  if (nl < 0) return
  const res = JSON.parse(buf.slice(0, nl))
  if (res.ok) {
    console.log(JSON.stringify(res.result, null, 2))
    process.exit(0)
  } else {
    console.error(`ошибка: ${res.error}`)
    process.exit(1)
  }
})
sock.on('error', (e) => {
  console.error(`не удалось подключиться к ${socketPath}: ${e.message}\nПриложение orca-board запущено?`)
  process.exit(2)
})
