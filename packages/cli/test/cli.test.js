// Запуск: node --test test/ (из packages/cli). CLI против фейкового сокета: проверяем, какой запрос он шлёт.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'orca-board.js')
const dir = mkdtempSync(join(tmpdir(), 'orca-cli-'))
const socket = process.platform === 'win32' ? `\\\\.\\pipe\\orca-cli-test-${process.pid}` : join(dir, 'orca.sock')
let last
const server = createServer((sock) => {
  let buf = ''
  sock.setEncoding('utf8')
  sock.on('data', (chunk) => {
    buf += chunk
    const nl = buf.indexOf('\n')
    if (nl < 0) return
    last = JSON.parse(buf.slice(0, nl))
    sock.write(JSON.stringify({ id: last.id, ok: true, result: {} }) + '\n')
  })
})

/** Запустить CLI и вернуть отправленный запрос (или null, если CLI не дошёл до сокета) и код выхода. */
function run(args, env = {}) {
  last = null
  return new Promise((resolve) => {
    const childEnv = { ...process.env, ORCA_SOCKET: socket, ...env }
    for (const k of ['ORCA_RUN_ID', 'ORCA_PROJECT', 'ORCA_DISPATCH_ID', 'ORCA_TASK_ID']) if (!(k in env)) delete childEnv[k]
    execFile(process.execPath, [CLI, ...args], { env: childEnv }, (err) => resolve({ req: last, code: err ? err.code : 0 }))
  })
}

describe('orca-board CLI', () => {
  before(() => new Promise((r) => server.listen(socket, r)))
  after(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('старый task create наследует прогон из ORCA_RUN_ID', async () => {
    const { req } = await run(['task', 'create', '--title', 't', '--role', 'developer'], { ORCA_RUN_ID: 'run_1' })
    assert.equal(req.method, 'task.create')
    assert.equal(req.params.run, 'run_1')
  })

  it('runs finish и done работают как раньше', async () => {
    assert.equal((await run(['runs', 'finish'], { ORCA_RUN_ID: 'run_1' })).req.params.run, 'run_1')
    const { req } = await run(['done', '--summary', 's', '--files', 'a.ts'], { ORCA_DISPATCH_ID: 'disp_1' })
    assert.equal(req.method, 'worker.done')
    assert.equal(req.dispatchId, 'disp_1')
  })

  it('runs finish --summary / --summary-file: сводка уходит текстом в summary; нет файла или текста — ошибка без запроса', async () => {
    const inline = await run(['runs', 'finish', '--summary', '## Итог'], { ORCA_RUN_ID: 'run_1' })
    assert.equal(inline.req.method, 'runs.finish')
    assert.equal(inline.req.params.summary, '## Итог')
    const file = join(dir, 'summary.md')
    writeFileSync(file, '## Сделано\n\n- «пункт» и `код`\n')
    const { req } = await run(['runs', 'finish', '--summary-file', file], { ORCA_RUN_ID: 'run_1' })
    assert.equal(req.params.summary, '## Сделано\n\n- «пункт» и `код`\n')
    assert.equal('summary-file' in req.params, false)
    const missing = await run(['runs', 'finish', '--summary-file', join(dir, 'nope.md')], { ORCA_RUN_ID: 'run_1' })
    assert.equal(missing.req, null)
    assert.equal(missing.code, 1)
    const empty = await run(['runs', 'finish', '--summary'], { ORCA_RUN_ID: 'run_1' })
    assert.equal(empty.req, null)
    assert.equal(empty.code, 1)
  })

  it('stage finish: прогон из ORCA_RUN_ID, --summary и --summary-file уходят текстом; без прогона и без текста — ошибка без запроса', async () => {
    const inline = await run(['stage', 'finish', '--summary', '## Этап'], { ORCA_RUN_ID: 'run_1' })
    assert.equal(inline.req.method, 'stage.finish')
    assert.equal(inline.req.params.run, 'run_1')
    assert.equal(inline.req.params.summary, '## Этап')
    const bare = await run(['stage', 'finish'], { ORCA_RUN_ID: 'run_1' })
    assert.equal('summary' in bare.req.params, false)
    assert.equal((await run(['stage', 'finish', '--run', 'run_2'], { ORCA_RUN_ID: 'run_1' })).req.params.run, 'run_2')
    const file = join(dir, 'stage.md')
    writeFileSync(file, '- «пункт» и `код`\n')
    const fromFile = await run(['stage', 'finish', '--summary-file', file], { ORCA_RUN_ID: 'run_1' })
    assert.equal(fromFile.req.params.summary, '- «пункт» и `код`\n')
    assert.equal('summary-file' in fromFile.req.params, false)
    const noRun = await run(['stage', 'finish'])
    assert.equal(noRun.req, null)
    assert.equal(noRun.code, 1)
    const empty = await run(['stage', 'finish', '--summary'], { ORCA_RUN_ID: 'run_1' })
    assert.equal(empty.req, null)
    assert.equal(empty.code, 1)
    const missing = await run(['stage', 'finish', '--summary-file', join(dir, 'nope.md')], { ORCA_RUN_ID: 'run_1' })
    assert.equal(missing.req, null)
    assert.equal(missing.code, 1)
  })

  it('workflow show берёт прогон из ORCA_RUN_ID, а явный --type перебивает его; review по проверке — свой --task', async () => {
    assert.equal((await run(['workflow', 'show'], { ORCA_RUN_ID: 'run_1' })).req.params.run, 'run_1')
    assert.equal((await run(['workflow', 'show', '--type', 'docs'], { ORCA_RUN_ID: 'run_1' })).req.params.run, undefined)
    const accept = await run(['review', 'accept', '--task', 'task_gate'], { ORCA_DISPATCH_ID: 'disp_1' })
    assert.equal(accept.req.method, 'review.accept')
    assert.equal(accept.req.params.task, 'task_gate')
    const reject = await run(['review', 'reject', '--task', 'task_gate', '--feedback', 'нет тестов'], { ORCA_DISPATCH_ID: 'disp_1' })
    assert.equal(reject.req.params.feedback, 'нет тестов')
  })

  it('справка описывает stage finish и события этапов', async () => {
    const help = await new Promise((resolve) => execFile(process.execPath, [CLI, '--help'], (_e, out) => resolve(out)))
    assert.match(help, /\n  stage finish \[--run <id>\]/)
    assert.match(help, /stage_started,stage_tasks_done\]/)
  })

  it('done --answer-file: CLI читает файл и шлёт текст в answer; нет файла — ошибка без запроса', async () => {
    const file = join(dir, 'answer.md')
    writeFileSync(file, '# Ответ\n\n- «кавычки» и `код`\n')
    const { req } = await run(['done', '--summary', 's', '--answer-file', file], { ORCA_DISPATCH_ID: 'disp_1' })
    assert.equal(req.params.answer, '# Ответ\n\n- «кавычки» и `код`\n')
    assert.equal('answer-file' in req.params, false)
    const missing = await run(['done', '--summary', 's', '--answer-file', join(dir, 'nope.md')], { ORCA_DISPATCH_ID: 'disp_1' })
    assert.equal(missing.req, null)
    assert.equal(missing.code, 1)
  })

  it('done --show-file / --show: описание из файла и пути файлов — одним showcase; без значения — ошибка без запроса', async () => {
    const file = join(dir, 'showcase.md')
    writeFileSync(file, '## Варианты\n\n- A, B\n')
    const { req } = await run(
      ['done', '--summary', 's', '--show-file', file, '--show', 'design/a.html', '--show', 'design/a,b.png'],
      { ORCA_DISPATCH_ID: 'disp_1' }
    )
    assert.deepEqual(req.params.showcase, { text: '## Варианты\n\n- A, B\n', files: ['design/a.html', 'design/a,b.png'] })
    assert.equal('show' in req.params, false)
    assert.equal('show-file' in req.params, false)
    const onlyFiles = await run(['done', '--summary', 's', '--show', 'shot.png'], { ORCA_DISPATCH_ID: 'disp_1' })
    assert.deepEqual(onlyFiles.req.params.showcase, { files: ['shot.png'] })
    const plain = await run(['done', '--summary', 's'], { ORCA_DISPATCH_ID: 'disp_1' })
    assert.equal('showcase' in plain.req.params, false)
    const missing = await run(['done', '--summary', 's', '--show-file', join(dir, 'nope.md')], { ORCA_DISPATCH_ID: 'disp_1' })
    assert.equal(missing.req, null)
    assert.equal(missing.code, 1)
    const empty = await run(['done', '--summary', 's', '--show'], { ORCA_DISPATCH_ID: 'disp_1' })
    assert.equal(empty.req, null)
    assert.equal(empty.code, 1)
  })

  it('done --show <папка>: путь папки уходит как есть — раскрывает её main при снимке', async () => {
    const { req } = await run(
      ['done', '--summary', 's', '--show', 'docs/design/', '--show', 'mockups', '--show', 'shot.png'],
      { ORCA_DISPATCH_ID: 'disp_1' }
    )
    assert.equal(req.method, 'worker.done')
    assert.deepEqual(req.params.showcase, { files: ['docs/design/', 'mockups', 'shot.png'] })
  })

  it('task create --answer-for и question forward уходят как есть', async () => {
    const created = await run(['task', 'create', '--title', 't', '--role', 'qa', '--answer-for', 'human'])
    assert.equal(created.req.params['answer-for'], 'human')
    const fwd = await run(['question', 'forward', '--question', 'q_1'])
    assert.equal(fwd.req.method, 'question.forward')
    assert.equal(fwd.req.params.question, 'q_1')
  })

  it('task create / task update --priority уходят как есть (значение проверяет сервер)', async () => {
    const created = await run(['task', 'create', '--title', 't', '--role', 'qa', '--priority', 'high'])
    assert.equal(created.req.method, 'task.create')
    assert.equal(created.req.params.priority, 'high')
    const updated = await run(['task', 'update', '--task', 'task_1', '--priority', 'urgent'])
    assert.equal(updated.req.method, 'task.update')
    assert.deepEqual(updated.req.params, { task: 'task_1', priority: 'urgent' })
  })

  it('global create / update --priority уходят как есть (значение проверяет сервер)', async () => {
    const created = await run(['global', 'create', '--title', 'x', '--priority', 'urgent'])
    assert.equal(created.req.method, 'global.create')
    assert.deepEqual(created.req.params, { title: 'x', priority: 'urgent' })
    const updated = await run(['global', 'update', '--global', 'run_1', '--priority', 'low'])
    assert.equal(updated.req.method, 'global.update')
    assert.deepEqual(updated.req.params, { global: 'run_1', priority: 'low' })
  })

  it('global tasks / add-task / get берут глобальную задачу из ORCA_RUN_ID, явный --global важнее', async () => {
    const tasks = await run(['global', 'tasks'], { ORCA_RUN_ID: 'run_1' })
    assert.equal(tasks.req.method, 'global.tasks')
    assert.equal(tasks.req.params.global, 'run_1')
    const add = await run(['global', 'add-task', '--global', 'run_2', '--title', 't', '--role', 'qa', '--dep', 'a,b'], { ORCA_RUN_ID: 'run_1' })
    assert.equal(add.req.method, 'global.add-task')
    assert.deepEqual(add.req.params, { global: 'run_2', title: 't', role: 'qa', dep: ['a', 'b'] })
  })

  it('global list/move/delete не подставляют ORCA_RUN_ID; --cascade — флаг', async () => {
    assert.deepEqual((await run(['global', 'list'], { ORCA_RUN_ID: 'run_1' })).req.params, {})
    const del = await run(['global', 'delete', '--global', 'run_2', '--cascade'], { ORCA_RUN_ID: 'run_1' })
    assert.deepEqual(del.req.params, { global: 'run_2', cascade: true })
    const move = await run(['global', 'move', '--status', 'wip'], { ORCA_RUN_ID: 'run_1' })
    assert.equal(move.req.params.global, undefined)
  })

  it('--global без значения — ошибка до сокета', async () => {
    const { req, code } = await run(['global', 'get', '--global'])
    assert.equal(req, null)
    assert.equal(code, 1)
  })

  it('значение, начинающееся с --, не превращается в true (аудит 2.15)', async () => {
    const { req } = await run(['question', 'answer', '--question', 'q_1', '--answer', '--force'])
    assert.deepEqual(req.params, { question: 'q_1', answer: '--force' })
    const res = await run(['request', 'resolve', '--request', 'req_1', '--accept', '--decision', '--делаем A'])
    assert.deepEqual(res.req.params, { request: 'req_1', accept: true, decision: '--делаем A' })
  })

  it('ask: --option повторяется (запятые допустимы), --recommend, --context-file читает CLI', async () => {
    const file = join(dir, 'why.md')
    writeFileSync(file, 'почему спрашиваю\n')
    const { req } = await run(
      ['ask', '--question', 'БД?', '--option', 'sqlite, файл|проще', '--option', 'postgres', '--recommend', '1', '--context-file', file],
      { ORCA_DISPATCH_ID: 'disp_1' }
    )
    assert.equal(req.method, 'worker.ask')
    assert.deepEqual(req.params, { question: 'БД?', option: ['sqlite, файл|проще', 'postgres'], recommend: '1', context: 'почему спрашиваю\n' })
    const noValue = await run(['ask', '--question', 'q', '--option'])
    assert.equal(noValue.req, null)
    assert.equal(noValue.code, 1)
  })

  it('request list берёт прогон из ORCA_RUN_ID; question forward --note; request get', async () => {
    assert.deepEqual((await run(['request', 'list'], { ORCA_RUN_ID: 'run_1' })).req.params, { run: 'run_1' })
    assert.deepEqual((await run(['request', 'list', '--all'])).req.params, { all: true })
    const fwd = await run(['question', 'forward', '--question', 'q_1', '--note', 'моё мнение: sqlite'])
    assert.deepEqual(fwd.req.params, { question: 'q_1', note: 'моё мнение: sqlite' })
    const get = await run(['request', 'get', '--request', 'req_1'])
    assert.equal(get.req.method, 'request.get')
  })

  it('worker stop/restart и task reopen: --start — флаг, --feedback берёт значение', async () => {
    const stop = await run(['worker', 'stop', '--task', 't_1'])
    assert.equal(stop.req.method, 'worker.stop')
    assert.deepEqual(stop.req.params, { task: 't_1' })
    const restart = await run(['worker', 'restart', '--task', 't_1', '--feedback', 'поправь тесты'])
    assert.equal(restart.req.method, 'worker.restart')
    assert.deepEqual(restart.req.params, { task: 't_1', feedback: 'поправь тесты' })
    const reopen = await run(['task', 'reopen', '--task', 't_1', '--start', '--feedback', 'ещё раз'])
    assert.equal(reopen.req.method, 'task.reopen')
    assert.deepEqual(reopen.req.params, { task: 't_1', start: true, feedback: 'ещё раз' })
    assert.deepEqual((await run(['task', 'reopen', '--task', 't_1'])).req.params, { task: 't_1' })
  })

  it('help показывает worker stop/restart и task reopen', async () => {
    const out = await new Promise((resolve) => execFile(process.execPath, [CLI, '--help'], (_e, stdout) => resolve(stdout)))
    for (const cmd of ['worker stop', 'worker restart', 'task reopen', '--start']) assert.ok(out.includes(cmd), cmd)
  })

  it('help показывает команды запросов', async () => {
    const out = await new Promise((resolve) => execFile(process.execPath, [CLI, '--help'], (_e, stdout) => resolve(stdout)))
    for (const cmd of ['request list', 'request get', 'request resolve', '--clarify', '--recommend', '--context-file', '--note']) {
      assert.ok(out.includes(cmd), cmd)
    }
  })

  it('projects list: метод projects.list, --project и ORCA_PROJECT не уходят; есть в help', async () => {
    const { req } = await run(['projects', 'list', '--project', 'p_x'], { ORCA_PROJECT: 'p_other' })
    assert.equal(req.method, 'projects.list')
    assert.equal(req.projectId, undefined)
    assert.deepEqual(req.params, {})
    const out = await new Promise((resolve) => execFile(process.execPath, [CLI, '--help'], (_e, stdout) => resolve(stdout)))
    assert.ok(out.includes('projects list'))
  })
  it('rules get/set: метод rules.*, --role и --text уходят как есть; --file читает CLI; без текста — ошибка без запроса', async () => {
    const get = await run(['rules', 'get', '--role', 'qa'], { ORCA_PROJECT: 'p_1' })
    assert.equal(get.req.method, 'rules.get')
    assert.equal(get.req.projectId, 'p_1')
    assert.deepEqual(get.req.params, { role: 'qa' })
    const set = await run(['rules', 'set', '--text', 'Не писать в ORION'])
    assert.equal(set.req.method, 'rules.set')
    assert.deepEqual(set.req.params, { text: 'Не писать в ORION' })
    assert.deepEqual((await run(['rules', 'set', '--text', ''])).req.params, { text: '' })
    const file = join(dir, 'rules.md')
    writeFileSync(file, '# Правила\n\n- «кавычки» и `код`\n')
    const fromFile = await run(['rules', 'set', '--role', 'developer', '--file', file])
    assert.deepEqual(fromFile.req.params, { role: 'developer', text: '# Правила\n\n- «кавычки» и `код`\n' })
    const empty = await run(['rules', 'set'])
    assert.equal(empty.req, null)
    assert.equal(empty.code, 1)
    const out = await new Promise((resolve) => execFile(process.execPath, [CLI, '--help'], (_e, stdout) => resolve(stdout)))
    for (const cmd of ['rules get', 'rules set']) assert.ok(out.includes(cmd), cmd)
  })

  it('workflow show: прогон из ORCA_RUN_ID, явный --run важнее, без прогона — воркфлоу проекта; есть в help', async () => {
    const own = await run(['workflow', 'show'], { ORCA_RUN_ID: 'run_1' })
    assert.equal(own.req.method, 'workflow.show')
    assert.deepEqual(own.req.params, { run: 'run_1' })
    assert.deepEqual((await run(['workflow', 'show', '--run', 'run_2'], { ORCA_RUN_ID: 'run_1' })).req.params, { run: 'run_2' })
    assert.deepEqual((await run(['workflow', 'show'])).req.params, {})
    const reject = await run(['request', 'resolve', '--request', 'req_1', '--reject', 'поправь'])
    assert.deepEqual(reject.req.params, { request: 'req_1', reject: 'поправь' })
    const out = await new Promise((resolve) => execFile(process.execPath, [CLI, '--help'], (_e, stdout) => resolve(stdout)))
    for (const cmd of ['workflow show', 'task get', '--reject', 'workflow_blocked']) assert.ok(out.includes(cmd), cmd)
  })

  it('типы задач: types list, global create / coordinator start --type уходят как есть; есть в help', async () => {
    const list = await run(['types', 'list'], { ORCA_PROJECT: 'p_1', ORCA_RUN_ID: 'run_1' })
    assert.equal(list.req.method, 'types.list')
    assert.equal(list.req.projectId, 'p_1')
    assert.deepEqual(list.req.params, {})
    assert.deepEqual((await run(['global', 'create', '--title', 't', '--type', 'docs'])).req.params, { title: 't', type: 'docs' })
    const start = await run(['coordinator', 'start', '--objective', 'o', '--type', 'docs'])
    assert.deepEqual(start.req.params, { objective: 'o', type: 'docs' })
    const out = await new Promise((resolve) => execFile(process.execPath, [CLI, '--help'], (_e, stdout) => resolve(stdout)))
    for (const cmd of ['types list', 'global create', '--type <id', 'roles list [--run <id>]', 'defaultTypeId']) assert.ok(out.includes(cmd), cmd)
  })

  it('roles list / rules / workflow show: прогон из ORCA_RUN_ID, а с --type — без прогона', async () => {
    for (const cmd of [['roles', 'list'], ['rules', 'get'], ['workflow', 'show']]) {
      assert.deepEqual((await run(cmd, { ORCA_RUN_ID: 'run_1' })).req.params, { run: 'run_1' }, cmd.join(' '))
      assert.deepEqual((await run([...cmd, '--type', 'docs'], { ORCA_RUN_ID: 'run_1' })).req.params, { type: 'docs' }, cmd.join(' '))
      assert.deepEqual((await run([...cmd, '--run', 'run_2'], { ORCA_RUN_ID: 'run_1' })).req.params, { run: 'run_2' }, cmd.join(' '))
    }
    const set = await run(['rules', 'set', '--role', 'writer', '--text', 'x'], { ORCA_RUN_ID: 'run_1' })
    assert.deepEqual(set.req.params, { role: 'writer', text: 'x', run: 'run_1' })
    const typed = await run(['rules', 'set', '--type', 'general', '--text', 'x'], { ORCA_RUN_ID: 'run_1' })
    assert.deepEqual(typed.req.params, { type: 'general', text: 'x' })
    // Вне координатора прогона нет — тип проекта по умолчанию выбирает сервер.
    assert.deepEqual((await run(['roles', 'list'])).req.params, {})
  })
  it('decision choose / escalate: --option уходит массивом, --reason и задача из ORCA_TASK_ID; без --reason — ошибка без запроса; есть в help', async () => {
    const env = { ORCA_TASK_ID: 'task_1', ORCA_DISPATCH_ID: 'disp_1', ORCA_RUN_ID: 'run_1' }
    const choose = await run(['decision', 'choose', '--option', 'yes', '--reason', 'новый экран — нужен макет'], env)
    assert.equal(choose.req.method, 'decision.choose')
    // --option повторяемый (он нужен ask): один вариант — тоже массив, одно значение выбирает сервер.
    assert.deepEqual(choose.req.params, { option: ['yes'], reason: 'новый экран — нужен макет' })
    assert.equal(choose.req.taskId, 'task_1')
    assert.equal(choose.req.dispatchId, 'disp_1')
    const explicit = await run(['decision', 'choose', '--task', 'task_2', '--option', 'Да, нужен', '--reason', 'r'], env)
    assert.deepEqual(explicit.req.params, { task: 'task_2', option: ['Да, нужен'], reason: 'r' })
    const escalate = await run(['decision', 'escalate', '--reason', 'не ясно, есть ли макет'], env)
    assert.equal(escalate.req.method, 'decision.escalate')
    assert.deepEqual(escalate.req.params, { reason: 'не ясно, есть ли макет' })
    for (const args of [['decision', 'choose', '--option', 'yes'], ['decision', 'choose', '--option', 'yes', '--reason'], ['decision', 'escalate', '--reason', '  ']]) {
      const bad = await run(args, env)
      assert.equal(bad.req, null, args.join(' '))
      assert.equal(bad.code, 1, args.join(' '))
    }
    const out = await new Promise((resolve) => execFile(process.execPath, [CLI, '--help'], (_e, stdout) => resolve(stdout)))
    for (const cmd of ['\n  decision choose [--task <id>] --option <id|метка> --reason', '\n  decision escalate [--task <id>] --reason', 'history', 'options: id вариантов']) assert.ok(out.includes(cmd), cmd)
  })

  it('settings get/set: метод settings.*, --project и ORCA_PROJECT не уходят (уровень приложения); есть в help', async () => {
    const get = await run(['settings', 'get', '--project', 'p_x'], { ORCA_PROJECT: 'p_other' })
    assert.equal(get.req.method, 'settings.get')
    assert.equal(get.req.projectId, undefined)
    assert.deepEqual(get.req.params, {})
    const set = await run(['settings', 'set', '--language', 'ru', '--no-sound', '--quiet-hours', '23:00-08:00'], { ORCA_PROJECT: 'p_other' })
    assert.equal(set.req.method, 'settings.set')
    assert.equal(set.req.projectId, undefined)
    assert.deepEqual(set.req.params, { language: 'ru', sound: false, 'quiet-hours': '23:00-08:00' })
    // Флаги без значения (boolean) и повторяемые --notify-role/--notify-event.
    const flags = await run(['settings', 'set', '--keep-in-background', '--notifications-enabled', '--notify-role', 'developer=on', '--notify-role', 'reviewer=off', '--notify-event', 'runDone=on'])
    assert.deepEqual(flags.req.params, {
      'keep-in-background': true,
      'notifications-enabled': true,
      'notify-role': ['developer=on', 'reviewer=off'],
      'notify-event': ['runDone=on']
    })
    const out = await new Promise((resolve) => execFile(process.execPath, [CLI, '--help'], (_e, stdout) => resolve(stdout)))
    for (const cmd of ['settings get', 'settings set [--language ru|en]']) assert.ok(out.includes(cmd), cmd)
  })

  it('types create/rename/set-default/duplicate/delete: метод types.*, --project уходит; есть в help', async () => {
    const create = await run(['types', 'create', '--project', 'p_1', '--title', 'Багфикс', '--description', 'd'])
    assert.equal(create.req.method, 'types.create')
    assert.equal(create.req.projectId, 'p_1')
    assert.deepEqual(create.req.params, { title: 'Багфикс', description: 'd' })
    assert.deepEqual((await run(['types', 'rename', '--project', 'p_1', '--type', 't_1', '--title', 'X'])).req.params, { type: 't_1', title: 'X' })
    const setDefault = await run(['types', 'set-default', '--project', 'p_1', '--type', 't_1'])
    assert.equal(setDefault.req.method, 'types.set-default')
    assert.deepEqual(setDefault.req.params, { type: 't_1' })
    assert.equal((await run(['types', 'duplicate', '--project', 'p_1', '--type', 't_1'])).req.method, 'types.duplicate')
    const del = await run(['types', 'delete', '--project', 'p_1', '--type', 't_1', '--yes'])
    assert.equal(del.req.method, 'types.delete')
    assert.deepEqual(del.req.params, { type: 't_1', yes: true })
    const out = await new Promise((resolve) => execFile(process.execPath, [CLI, '--help'], (_e, stdout) => resolve(stdout)))
    for (const cmd of ['types create --project <id>', 'types delete --project <id> --type <id> --yes']) assert.ok(out.includes(cmd), cmd)
  })

  it('roles add/update/remove: метод roles.*, --project уходит; есть в help', async () => {
    const add = await run(['roles', 'add', '--project', 'p_1', '--type', 't_1', '--title', 'Тестировщик', '--agent', 'claude', '--model', 'sonnet'])
    assert.equal(add.req.method, 'roles.add')
    assert.deepEqual(add.req.params, { type: 't_1', title: 'Тестировщик', agent: 'claude', model: 'sonnet' })
    const update = await run(['roles', 'update', '--project', 'p_1', '--type', 't_1', '--role', 'r_1', '--effort', 'high'])
    assert.deepEqual(update.req.params, { type: 't_1', role: 'r_1', effort: 'high' })
    const updateAgent = await run(['roles', 'update', '--project', 'p_1', '--type', 't_1', '--role', 'r_1', '--agent', 'codex', '--yes'])
    assert.deepEqual(updateAgent.req.params, { type: 't_1', role: 'r_1', agent: 'codex', yes: true })
    const remove = await run(['roles', 'remove', '--project', 'p_1', '--type', 't_1', '--role', 'r_1', '--yes'])
    assert.equal(remove.req.method, 'roles.remove')
    assert.deepEqual(remove.req.params, { type: 't_1', role: 'r_1', yes: true })
    const out = await new Promise((resolve) => execFile(process.execPath, [CLI, '--help'], (_e, stdout) => resolve(stdout)))
    assert.ok(out.includes('roles add --project <id> --type <id> --title'))
  })

  it('types perm get/set: метод из трёх слов types.perm.get/set; --mode уходит как есть; есть в help', async () => {
    const get = await run(['types', 'perm', 'get', '--project', 'p_1', '--type', 't_1'])
    assert.equal(get.req.method, 'types.perm.get')
    assert.deepEqual(get.req.params, { type: 't_1' })
    const set = await run(['types', 'perm', 'set', '--project', 'p_1', '--type', 't_1', '--mode', 'bypassPermissions', '--yes'])
    assert.equal(set.req.method, 'types.perm.set')
    assert.deepEqual(set.req.params, { type: 't_1', mode: 'bypassPermissions', yes: true })
    const out = await new Promise((resolve) => execFile(process.execPath, [CLI, '--help'], (_e, stdout) => resolve(stdout)))
    assert.ok(out.includes('types perm set --project <id> --type <id> --mode auto|bypassPermissions|acceptEdits'))
  })

  it('node-templates list/delete: метод node-templates.*; есть в help', async () => {
    const list = await run(['node-templates', 'list', '--project', 'p_1'])
    assert.equal(list.req.method, 'node-templates.list')
    assert.deepEqual(list.req.params, {})
    const del = await run(['node-templates', 'delete', '--project', 'p_1', '--template', 'tpl_1', '--yes'])
    assert.equal(del.req.method, 'node-templates.delete')
    assert.deepEqual(del.req.params, { template: 'tpl_1', yes: true })
    const out = await new Promise((resolve) => execFile(process.execPath, [CLI, '--help'], (_e, stdout) => resolve(stdout)))
    assert.ok(out.includes('node-templates delete --project <id> --template <id> --yes'))
  })

  it('projects set-active/remove: метод projects.*, --project уходит; есть в help', async () => {
    const active = await run(['projects', 'set-active', '--project', 'p_1'])
    assert.equal(active.req.method, 'projects.set-active')
    assert.equal(active.req.projectId, 'p_1')
    assert.deepEqual(active.req.params, {})
    const remove = await run(['projects', 'remove', '--project', 'p_1', '--yes'])
    assert.equal(remove.req.method, 'projects.remove')
    assert.deepEqual(remove.req.params, { yes: true })
    const out = await new Promise((resolve) => execFile(process.execPath, [CLI, '--help'], (_e, stdout) => resolve(stdout)))
    for (const cmd of ['projects set-active --project <id>', 'projects remove --project <id> --yes']) assert.ok(out.includes(cmd), cmd)
  })

  it('project agents/columns/types/rules: метод project.*, флаги CLI-специфичны; есть в help', async () => {
    const agents = await run(['project', 'agents', 'set', '--project', 'p_1', '--enable', 'claude', '--enable', 'codex', '--disable', 'gemini'])
    assert.equal(agents.req.method, 'project.agents.set')
    assert.deepEqual(agents.req.params, { enable: ['claude', 'codex'], disable: ['gemini'] })

    const columnsFile = join(dir, 'columns.json')
    writeFileSync(columnsFile, JSON.stringify([{ id: 'backlog', title: 'Бэклог' }]))
    const columns = await run(['project', 'columns', 'set', '--project', 'p_1', '--file', columnsFile])
    assert.equal(columns.req.method, 'project.columns.set')
    assert.deepEqual(columns.req.params, { columns: [{ id: 'backlog', title: 'Бэклог' }] })
    assert.equal('file' in columns.req.params, false)
    const missingFile = await run(['project', 'columns', 'set', '--project', 'p_1', '--file', join(dir, 'nope.json')])
    assert.equal(missingFile.req, null)
    assert.equal(missingFile.code, 1)
    const badJsonFile = join(dir, 'bad.json')
    writeFileSync(badJsonFile, '{не json')
    const badJson = await run(['project', 'columns', 'set', '--project', 'p_1', '--file', badJsonFile])
    assert.equal(badJson.req, null)
    assert.equal(badJson.code, 1)
    const noFile = await run(['project', 'columns', 'set', '--project', 'p_1'])
    assert.equal(noFile.req, null)
    assert.equal(noFile.code, 1)

    const types = await run(['project', 'types', 'set', '--project', 'p_1', '--types', 't_1,t_2', '--default', 't_1'])
    assert.equal(types.req.method, 'project.types.set')
    assert.deepEqual(types.req.params, { types: 't_1,t_2', default: 't_1' })

    const rulesGet = await run(['project', 'rules', 'get', '--project', 'p_1', '--file', 'CLAUDE.md'])
    assert.equal(rulesGet.req.method, 'project.rules.get')
    assert.deepEqual(rulesGet.req.params, { file: 'CLAUDE.md' })
    const rulesSetInline = await run(['project', 'rules', 'set', '--project', 'p_1', '--file', 'AGENTS.md', '--text', 'правило'])
    assert.equal(rulesSetInline.req.method, 'project.rules.set')
    assert.deepEqual(rulesSetInline.req.params, { file: 'AGENTS.md', text: 'правило' })
    const rulesFile = join(dir, 'rules.md')
    writeFileSync(rulesFile, 'из файла')
    const rulesSetFromFile = await run(['project', 'rules', 'set', '--project', 'p_1', '--file', 'CLAUDE.md', '--rules-file', rulesFile])
    assert.deepEqual(rulesSetFromFile.req.params, { file: 'CLAUDE.md', text: 'из файла' })
    assert.equal('rules-file' in rulesSetFromFile.req.params, false)
    const rulesSetNoText = await run(['project', 'rules', 'set', '--project', 'p_1', '--file', 'CLAUDE.md'])
    assert.equal(rulesSetNoText.req, null)
    assert.equal(rulesSetNoText.code, 1)

    const out = await new Promise((resolve) => execFile(process.execPath, [CLI, '--help'], (_e, stdout) => resolve(stdout)))
    for (const cmd of [
      'project agents set --project <id>',
      'project columns set --project <id> --file columns.json',
      'project types set --project <id>',
      'project rules get --project <id> --file CLAUDE.md|AGENTS.md',
      'project rules set --project <id> --file CLAUDE.md|AGENTS.md --text "..." | --rules-file rules.md'
    ]) assert.ok(out.includes(cmd), cmd)
  })
})
