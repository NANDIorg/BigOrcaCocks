#!/usr/bin/env node
// orca-board — тонкий клиент к unix-сокету приложения. Без зависимостей.
// Вызывается агентами из их Bash. Состоянием владеет приложение.
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'

// Та же логика, что defaultSocketPath() в packages/core/src/paths.ts — менять синхронно.
// На Windows — именованный канал, иначе unix-сокет в ~/.orca-board.
function defaultSocketPath(opts) {
  const { env, platform, homedir } = opts
  if (env.ORCA_SOCKET !== undefined) return env.ORCA_SOCKET
  if (platform === 'win32') return '\\\\.\\pipe\\orca-board'
  return `${homedir.replace(/\/+$/, '')}/.orca-board/orca.sock`
}

const HELP = `orca-board — управление доской агентов

Человек:
  coordinator start --objective "..."     открыть Claude Code-координатора в приложении (новая глобальная задача)
  coordinator start --global <id>         повторный запуск координатора на существующей глобальной задаче

Проекты (уровень приложения, --project не нужен):
  projects list                           все проекты: id, name, root, active (активный в приложении),
                                          inProgress — задач в работе; без проектов — []

Правила агентов доски (попадают только в системный промпт воркеров и координатора, не в CLAUDE.md/AGENTS.md):
  rules get [--role <id>]                 без --role — общие правила проекта, с --role — правила роли
                                          (= её системный промпт в «О проекте → Роли»); не заданы — ""
  rules set [--role <id>] --text "..."    заменить правила; --text "" — очистить
  rules set [--role <id>] --file rules.md   то же из файла (markdown); применяется при следующем запуске агента

Глобальные задачи (верхний уровень доски; id = id прогона, см. docs/nested-kanban.md):
  global list                             карточки: название, описание, статус-колонка, priority, прогресс подзадач,
                                          coordinatorAlive — жив ли терминал координатора
  global get [--global <id>]              одна карточка (с coordinatorAlive)
  global create [--title "..."] [--description "..."] [--status <id колонки>]
                [--priority urgent|high|normal|low]   приоритет глобальной задачи, по умолчанию normal
  global update --global <id> [--title "..."] [--description "..."] [--priority urgent|high|normal|low]
                                          приоритет меняется в любой колонке; подзадач не касается
  global move --global <id> --status <id колонки>    только backlog/in_progress/review/done; подзадачи не трогает; в review/done — закрывает прогон (run_done)
  global delete --global <id> [--cascade]  с подзадачами — только --cascade (удаляются вместе с ней)
  global tasks [--global <id>]            подзадачи только этой глобальной задачи
  global add-task [--global <id>] --title "..." [--spec "..."] --role <id> [--dep <id>]... [--answer-for human|coordinator]
                  [--priority urgent|high|normal|low]
  global start --global <id>              = coordinator start --global <id>

Координатор:
  agents list      известные агенты: установлен ли, включён ли в проекте, версия
  roles list       роли проекта: id, название, назначение, агент, модель, включён ли агент
  columns list     колонки доски: id, название, kind
  workflow show [--run <id>]              воркфлоу: этапы рабочей задачи после worker_done (проверки, человек,
                                          мерж) и переходы; с --run — снимок прогона, без — воркфлоу проекта
  task list [--run <id>]                  все задачи проекта; с --run — только подзадачи глобальной задачи
                                          (у каждой — priority: urgent|high|normal|low);
                                          у задачи в воркфлоу — stage (этап: nodeId и число заходов visits),
                                          у задачи-проверки — gateFor (чью ветку проверяет)
  task get --task <id>                    одна задача (со stage и gateFor)
  task create --title "..." [--spec "..."] --role <id из roles list> [--dep <id>]... [--run <id>]
              [--answer-for human|coordinator]   задача-ответ: результат — ответ в markdown, не код;
                                          human — ответ читает человек, coordinator — ты сам
              [--priority urgent|high|normal|low]   приоритет, по умолчанию normal
  task move --task <id> --status <id колонки из columns list>
  task update --task <id> [--title "..."] [--spec "..."] [--priority urgent|high|normal|low]
                                          правка задачи; название и описание — не в работе, приоритет — в любой колонке
  task answer --task <id>                 полный ответ задачи-ответа и decision (в событиях answer обрезан)
  worker start --task <id>
  worker stop --task <id>                 закрыть воркеров задачи (без эскалации), задача из работы → ready
  worker restart --task <id> [--feedback "..."]   stop + запуск заново; работает и на задаче в работе
                                          задачу в review/done не перезапускает: для неё task reopen --task <id> --start
  worker read --dispatch <id> [--limit 80]
  check [--wait] [--types worker_done,question,escalation,task_ready,question_answered,answer_accepted,run_done,request_created,request_resolved,answer_clarified,workflow_blocked] [--timeout-ms 900000] [--run <id>]
  check --follow [--types ...] [--run <id>]   поток: по строке JSON на каждое событие, не завершается
                                          сам (до Ctrl+C / SIGTERM); --follow важнее --wait
  runs list                               прогоны координатора
  runs close [--run <id>]                 закрыть прогон
  runs finish [--run <id>]                координатор закончил работу (после run_done и сводки; если все подзадачи в done — закрывает прогон сам)
  question list
  question get --question <id>            вопрос целиком и ответ на него
  question answer --question <id> --answer "..."
  question forward --question <id> [--note "..."]   передать вопрос человеку (запрос в Инбокс);
                                          --note — твоё мнение, попадёт в текст запроса

  review info --task <id>                 diff-stat и коммиты ветки задачи
  review accept --task <id> [--decision "..."]  задача на этапе проверки — исход accept, дальше по воркфлоу
                                          (обычно мерж и done); вне воркфлоу — слить ветку, задача → done
  review reject --task <id> --feedback "..."   задача на этапе проверки — исход reject (обычно снова в работу,
                                          воркер стартует сам); вне воркфлоу — ready с замечаниями
  task reopen --task <id> [--feedback "..."] [--start]   задача (done/review/backlog/…) → ready, feedback — по
                                          желанию; ждёт решения по ответу — это «Уточнить» (feedback обязателен);
                                          --start — сразу запустить воркера
  task delete --task <id>
  events list

Запросы к человеку (Инбокс: вопросы, ответы задач-ответов, упавшие воркеры, этапы воркфлоу «человек»):
  request list [--run <id>] [--all]       ждущие ответа (pending); --all — и решённые
  request get --request <id>              запрос целиком: текст, контекст/ответ, варианты, решение
  request resolve --request <id> --option <id|метка> [--text "..."]   ответ на вопрос вариантом
  request resolve --request <id> --text "..."                        ответ на вопрос своим текстом
  request resolve --request <id> --accept [--decision "..."]         принять ответ задачи-ответа или этап
                                                                      «человек» воркфлоу (approval)
  request resolve --request <id> --clarify "..."                     уточнить: воркер перезапускается
  request resolve --request <id> --restart | --dismiss               упавший воркер: перезапуск / скрыть
  request resolve --request <id> --reject "..."                      этап «человек»: вернуть с замечаниями

Воркер (ORCA_DISPATCH_ID уже в окружении):
  done --summary "..." [--files a.ts,b.ts] [--answer-file answer.md | --answer "..."]
                                          у задачи-ответа ответ (markdown) обязателен
  ask --question "..." [--option "метка|пояснение"]... [--recommend <id|метка>] [--context-file why.md] [--no-wait]
                                          блокируется до ответа; --option повторяется, запятые в метке
                                          допустимы (старое --options a,b тоже работает); id варианта — его номер.
                                          Оборвался по таймауту — повтори ту же команду: переподключится
                                          к тому же вопросу (или сразу вернёт ответ), новый не создастся

Прогон: --run <id> у task create, check, request list, runs close и runs finish по умолчанию берётся из $ORCA_RUN_ID —
задачи, созданные координатором, наследуют его прогон (= его глобальную задачу). Так же --global
у global get, global tasks и global add-task. Задача без прогона попадает во «Входящие».

Общее: --socket <path>, --project <id> (иначе $ORCA_PROJECT или активный проект в приложении).
Сокет: $ORCA_SOCKET или ~/.orca-board/orca.sock (на Windows — именованный канал \\\\.\\pipe\\orca-board)`

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

// Флаги без значения. Остальные берут следующий аргумент как значение, даже если он начинается
// с `--` (`--answer "--force"`): иначе значение превращалось в true, а следующий флаг терялся.
const BOOLEAN_FLAGS = new Set(['wait', 'follow', 'cascade', 'accept', 'restart', 'dismiss', 'all', 'json', 'help', 'start'])
// Повторяемые флаги: каждое вхождение — отдельный элемент (без split по запятой).
const REPEATABLE_FLAGS = new Set(['option'])

const params = {}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const key = a.slice(2)
  if (key.startsWith('no-')) {
    params[key.slice(3)] = false
    continue
  }
  const next = argv[i + 1]
  const value = !BOOLEAN_FLAGS.has(key) && next !== undefined ? (i++, next) : true
  if (key === 'dep' || key === 'deps') {
    params.dep = [...(params.dep ?? []), ...String(value).split(',')]
  } else if (REPEATABLE_FLAGS.has(key)) {
    params[key] = [...(params[key] ?? []), value]
  } else {
    params[key] = value
  }
}

// Прогон координатора: явный --run важнее $ORCA_RUN_ID.
const RUN_METHODS = ['task.create', 'check', 'runs.close', 'runs.finish', 'request.list', 'workflow.show']
if (RUN_METHODS.includes(method) && params.run === undefined && process.env.ORCA_RUN_ID) {
  params.run = process.env.ORCA_RUN_ID
}
// Глобальная задача координатора = его прогон: те же умолчания для чтения и добавления подзадач.
const GLOBAL_METHODS = ['global.get', 'global.tasks', 'global.add-task']
if (GLOBAL_METHODS.includes(method) && params.global === undefined && process.env.ORCA_RUN_ID) {
  params.global = process.env.ORCA_RUN_ID
}
if (params.global === true) {
  console.error('ошибка: --global требует id глобальной задачи')
  process.exit(1)
}
if (params.run === true) {
  console.error('ошибка: --run требует id прогона')
  process.exit(1)
}
// Файлы читает CLI (он в cwd воркера), серверу уходит текст: ответ задачи-ответа, контекст вопроса.
function readFileParam(flag, into) {
  if (params[flag] === undefined) return
  if (params[flag] === true) {
    console.error(`ошибка: --${flag} требует путь к файлу`)
    process.exit(1)
  }
  try {
    params[into] = readFileSync(params[flag], 'utf8')
  } catch (e) {
    console.error(`ошибка: не удалось прочитать ${params[flag]}: ${e.message}`)
    process.exit(1)
  }
  delete params[flag]
}
if (method === 'worker.done') readFileParam('answer-file', 'answer')
if (method === 'worker.ask') readFileParam('context-file', 'context')
if (method === 'rules.set') readFileParam('file', 'text')
if (method === 'rules.set' && typeof params.text !== 'string') {
  console.error('ошибка: rules set требует --text "..." или --file <путь>')
  process.exit(1)
}
if (params.option !== undefined && params.option.includes(true)) {
  console.error('ошибка: --option требует текста варианта ("метка|пояснение")')
  process.exit(1)
}
if ((method === 'runs.close' || method === 'runs.finish') && !params.run) {
  console.error('ошибка: не указан прогон — передайте --run <id> или задайте ORCA_RUN_ID')
  process.exit(1)
}
const follow = method === 'check' && params.follow === true
if (follow) delete params.wait

const socketPath = params.socket ?? defaultSocketPath({ env: process.env, platform: process.platform, homedir: homedir() })
delete params.socket
delete params.json

const request = {
  id: String(Date.now()),
  method,
  params,
  dispatchId: process.env.ORCA_DISPATCH_ID,
  taskId: process.env.ORCA_TASK_ID,
  // Команды уровня приложения проект не выбирают: --project и $ORCA_PROJECT им не передаём.
  projectId: method === 'projects.list' ? undefined : params.project ?? process.env.ORCA_PROJECT
}
delete params.project

const sock = connect(socketPath)
let buf = ''
sock.setEncoding('utf8')
sock.on('connect', () => sock.write(JSON.stringify(request) + '\n'))
if (follow) {
  // Поток событий: соединение живёт, пока его не закроем мы (сигнал) или сервер (ошибка).
  let closing = false
  const stop = () => {
    closing = true
    sock.destroy()
    process.exitCode = 0
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  sock.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      const res = JSON.parse(line)
      if (!res.ok) {
        closing = true
        process.stderr.write(`ошибка: ${res.error}\n`, () => {
          sock.destroy()
          process.exitCode = 1
        })
        return
      }
      if (res.result?.event !== undefined) process.stdout.write(JSON.stringify(res.result.event) + '\n')
    }
  })
  sock.on('close', () => {
    if (closing) return
    process.stderr.write('ошибка: сервер закрыл соединение\n')
    process.exitCode = 1
  })
} else {
  sock.on('data', (chunk) => {
    buf += chunk
    const nl = buf.indexOf('\n')
    if (nl < 0) return
    const res = JSON.parse(buf.slice(0, nl))
    // Не process.exit сразу после записи: большой вывод в пайп уходит асинхронно и обрезается.
    const finish = (code) => {
      sock.destroy()
      process.exitCode = code
    }
    if (res.ok) {
      process.stdout.write(JSON.stringify(res.result, null, 2) + '\n', () => finish(0))
    } else {
      process.stderr.write(`ошибка: ${res.error}\n`, () => finish(1))
    }
  })
}
sock.on('error', (e) => {
  console.error(`не удалось подключиться к ${socketPath}: ${e.message}\nПриложение orca-board запущено?`)
  process.exit(2)
})
