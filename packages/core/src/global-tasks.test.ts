// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore, type Persistence, type StoreSnapshot } from './store.ts'
import {
  globalBoardColumns, globalColumnKind, GLOBAL_REVIEW_TITLE, globalStoredColumns, globalTaskStatus, globalTaskTitle, INBOX_TITLE, toGlobalTasks,
  hasPendingRequest, pendingRequestsOf
} from './global-tasks.ts'
import { coordinatorsToClose, COORDINATOR_FINISH_GRACE_MS } from './coordinator-close.ts'
import { DEFAULT_COLUMNS, type BoardColumn, type HumanRequest, type Run, type Task } from './types.ts'

/** Колонки проекта не совпадают с дефолтными id: API не должен их хардкодить. */
const COLUMNS: BoardColumn[] = [
  { id: 'plan', title: 'Planning', color: '#6b6f7c', kind: 'backlog' },
  { id: 'todo', title: 'Todo', color: '#7b86f5', kind: 'ready' },
  { id: 'wip', title: 'In Progress', color: '#f08a3a', kind: 'in_progress' },
  { id: 'ask', title: 'Needs input', color: '#e8b04a', kind: 'needs_input' },
  { id: 'ai', title: 'AI Review', color: '#b57bee', kind: 'review' },
  { id: 'human', title: 'Human Review', color: '#5ad1cc', kind: 'custom' },
  { id: 'fin', title: 'Done', color: '#2ea043', kind: 'done' }
]

/** Персистентность в памяти: сохраняем JSON, как jsonPersistence в main. */
function memory(initial?: Partial<StoreSnapshot>): Persistence & { saved: () => StoreSnapshot | undefined; saves: () => number } {
  let data = initial ? JSON.stringify(initial) : undefined
  let saves = 0
  return {
    load: () => (data ? JSON.parse(data) : null),
    save: (snap) => {
      saves += 1
      data = JSON.stringify(snap)
    },
    saved: () => (data ? JSON.parse(data) : undefined),
    saves: () => saves
  }
}

const cols = (): BoardColumn[] => COLUMNS
const newStore = (p = memory()): TaskStore => new TaskStore(p, cols)
const statuses = (tasks: Task[]): string[] => tasks.map((t) => t.status)

describe('глобальные задачи: CRUD и колонки проекта', () => {
  it('создание: статус по умолчанию — колонка kind=backlog проекта, а не «backlog»', () => {
    const store = newStore()
    const g = store.createGlobalTask({ title: '  Авторизация  ', description: 'OAuth + сессии' })
    assert.equal(g.title, 'Авторизация')
    assert.equal(g.description, 'OAuth + сессии')
    assert.equal(g.status, 'plan')
    assert.equal(g.inbox, false)
    assert.deepEqual(g.progress, { total: 0, done: 0, byStatus: {}, byKind: {} })
    assert.equal(store.createGlobalTask({ title: 'x', status: 'wip' }).status, 'wip')
  })

  it('создание без названия и описания и в неизвестную колонку — ошибка', () => {
    const store = newStore()
    assert.throws(() => store.createGlobalTask({ title: ' ', description: ' ' }), /название или описание/)
    assert.throws(() => store.createGlobalTask({ title: 'x', status: 'backlog' }), /колонки с id «backlog» нет/)
  })

  it('создание и перемещение в колонку подзадач (ready/custom) и в вычисляемую needs_input — ошибка', () => {
    const store = newStore()
    for (const status of ['todo', 'human']) {
      assert.throws(() => store.createGlobalTask({ title: 'x', status }), /только для подзадач.*проверка/)
    }
    assert.throws(() => store.createGlobalTask({ title: 'x', status: 'ask' }), /заполняется сама/)
    const g = store.createGlobalTask({ title: 'G' })
    for (const status of ['todo', 'human']) {
      assert.throws(() => store.moveGlobalTask(g.id, status), /только для подзадач/)
    }
    assert.throws(() => store.moveGlobalTask(g.id, 'ask'), /заполняется сама/)
    assert.equal(store.getGlobalTask(g.id).status, 'plan')
    assert.equal(store.listGlobalTasks().length, 1)
  })

  it('название без title выводится из первой строки описания', () => {
    const store = newStore()
    const g = store.createGlobalTask({ description: '\n  Починить логин\nподробности' })
    assert.equal(g.title, 'Починить логин')
    assert.equal(globalTaskTitle({ id: 'r', objective: 'a'.repeat(200) }).length, 80)
    assert.equal(globalTaskTitle({ id: 'r', objective: '', inbox: true }), INBOX_TITLE)
  })

  it('переименование и описание; пустое название — ошибка', () => {
    const store = newStore()
    const g = store.createGlobalTask({ title: 'A' })
    assert.equal(store.updateGlobalTask(g.id, { title: 'B', description: 'новое' }).title, 'B')
    assert.equal(store.getGlobalTask(g.id).description, 'новое')
    assert.throws(() => store.updateGlobalTask(g.id, { title: '  ' }), /пустым/)
    assert.throws(() => store.updateGlobalTask(g.id, {}), /укажи/)
    assert.throws(() => store.updateGlobalTask('run_nope', { title: 'x' }), /run not found/)
  })

  it('ручное перемещение по реальным колонкам не меняет статусы подзадач', () => {
    const store = newStore()
    const g = store.createGlobalTask({ title: 'G' })
    const a = store.createTask({ title: 'a', runId: g.id })
    const b = store.createTask({ title: 'b', runId: g.id, deps: [a.id] })
    const before = statuses(store.listSubtasks(g.id))
    assert.equal(store.moveGlobalTask(g.id, 'wip').status, 'wip')
    assert.equal(store.moveGlobalTask(g.id, 'fin').status, 'fin')
    assert.deepEqual(statuses(store.listSubtasks(g.id)), before)
    assert.ok(store.getRun(g.id)!.closedAt, 'ручной done закрывает прогон')
    assert.throws(() => store.moveGlobalTask(g.id, 'done'), /колонки с id «done» нет/)
    assert.equal(store.getTask(b.id)!.status, 'plan')
  })

  it('прогресс: total/done и разбивка по колонкам и kind', () => {
    const store = newStore()
    const g = store.createGlobalTask({ title: 'G' })
    const a = store.createTask({ title: 'a', runId: g.id })
    const b = store.createTask({ title: 'b', runId: g.id })
    store.createTask({ title: 'c', runId: g.id, deps: [a.id] })
    store.moveTask(a.id, 'fin')
    store.moveTask(b.id, 'ai')
    const p = store.getGlobalTask(g.id).progress
    assert.equal(p.total, 3)
    assert.equal(p.done, 1)
    assert.deepEqual(p.byStatus, { fin: 1, ai: 1, todo: 1 })
    assert.deepEqual(p.byKind, { done: 1, review: 1, ready: 1 })
  })

  it('удаление колонки переносит и глобальные задачи (reassignColumn)', () => {
    const store = newStore()
    const g = store.createGlobalTask({ title: 'G', status: 'wip' })
    assert.equal(store.reassignColumn('wip', 'plan'), 1)
    assert.equal(store.getGlobalTask(g.id).status, 'plan')
  })
})

describe('колонки глобального канбана', () => {
  it('глобальный канбан — backlog / in_progress / needs_input / review / done в порядке проекта; хранятся — без needs_input', () => {
    assert.deepEqual(globalBoardColumns(COLUMNS).map((c) => c.id), ['plan', 'wip', 'ask', 'ai', 'fin'])
    assert.deepEqual(globalBoardColumns(DEFAULT_COLUMNS).map((c) => c.title), ['Бэклог', 'В работе', 'Нужен ответ', 'Проверка', 'Сделано'])
    // Id и цвет колонки review — от проекта, заголовок подменён; колонки проекта не мутируются.
    const review = globalBoardColumns(COLUMNS).find((c) => c.kind === 'review')!
    assert.deepEqual(review, { id: 'ai', title: GLOBAL_REVIEW_TITLE, color: '#b57bee', kind: 'review' })
    assert.equal(COLUMNS.find((c) => c.id === 'ai')!.title, 'AI Review')
    assert.deepEqual(globalStoredColumns(COLUMNS).map((c) => c.id), ['plan', 'wip', 'ai', 'fin'])
    assert.equal(DEFAULT_COLUMNS.length, 6, 'колонки проекта (локальный канбан) не меняются')
  })

  it('сведение вида: ready → backlog, needs_input/custom → in_progress, review — как есть', () => {
    assert.equal(globalColumnKind('backlog'), 'backlog')
    assert.equal(globalColumnKind('ready'), 'backlog')
    assert.equal(globalColumnKind('in_progress'), 'in_progress')
    assert.equal(globalColumnKind('needs_input'), 'in_progress')
    assert.equal(globalColumnKind('review'), 'review')
    assert.equal(globalColumnKind('custom'), 'in_progress')
    assert.equal(globalColumnKind('done'), 'done')
    assert.equal(globalColumnKind(undefined), 'backlog')
  })

  it('статус из скрытой колонки сводится к видимой; видимые — как есть', () => {
    const cases: [string | undefined, string | undefined][] = [
      ['plan', 'plan'], ['todo', 'plan'], ['wip', 'wip'], ['ask', 'wip'], ['ai', 'ai'], ['human', 'wip'],
      ['fin', 'fin'], ['gone', 'plan'], [undefined, 'plan']
    ]
    for (const [from, to] of cases) assert.equal(globalTaskStatus(from, COLUMNS), to, String(from))
    // Нет колонки нужного вида — первая видимая.
    const noWip = COLUMNS.filter((c) => c.kind !== 'in_progress')
    assert.equal(globalTaskStatus('human', noWip), 'plan')
  })

  it('карточки со статусами ready/needs_input/custom не теряются: встают в видимые колонки; review — «Проверка»', () => {
    const run = (id: string, status: string): Run => ({ id, objective: id, status, createdAt: 1 })
    const globals = toGlobalTasks([run('r1', 'todo'), run('r2', 'ask'), run('r3', 'ai'), run('r4', 'human')], [], COLUMNS)
    assert.deepEqual(globals.map((g) => [g.id, g.status]), [['r1', 'plan'], ['r2', 'wip'], ['r3', 'ai'], ['r4', 'wip']])
    const visible = new Set(globalBoardColumns(COLUMNS).map((c) => c.id))
    assert.ok(globals.every((g) => visible.has(g.status)))
  })

  it('загрузка доски: прогоны в скрытых колонках мигрируют и сохраняются; closeRun видит сведённый in_progress', () => {
    const T = 1_000
    const snap = {
      tasks: [],
      runs: [
        { id: 'run_ready', objective: 'r', status: 'todo', createdAt: T },
        { id: 'run_ask', objective: 'a', status: 'ask', createdAt: T + 1 },
        { id: 'run_custom', objective: 'v', status: 'human', createdAt: T + 2 }
      ],
      dispatches: [],
      events: [],
      questions: []
    }
    const p = memory(snap as Partial<StoreSnapshot>)
    const store = newStore(p)
    assert.equal(p.saves(), 1)
    assert.deepEqual(p.saved()!.runs.map((r) => r.status), ['plan', 'wip', 'wip'])
    assert.deepEqual(store.listGlobalTasks().map((g) => g.status), ['plan', 'wip', 'wip'])
    store.closeRun('run_ask')
    assert.equal(store.getGlobalTask('run_ask').status, 'fin')
  })

  it('колонку перевели в скрытый kind на ходу — карточка показывается в видимой', () => {
    let columns = COLUMNS
    const store = new TaskStore(memory(), () => columns)
    const g = store.createGlobalTask({ title: 'G', status: 'wip' })
    columns = COLUMNS.map((c) => (c.id === 'wip' ? { ...c, kind: 'custom' as const } : c))
    assert.equal(store.getGlobalTask(g.id).status, 'plan', 'in_progress-колонки больше нет — первая видимая')
  })
})

describe('подзадачи: изоляция', () => {
  it('подзадачи видны только в своей глобальной задаче', () => {
    const store = newStore()
    const g1 = store.createGlobalTask({ title: 'G1' })
    const g2 = store.createGlobalTask({ title: 'G2' })
    const a = store.createTask({ title: 'a', runId: g1.id })
    const b = store.createTask({ title: 'b', runId: g2.id })
    assert.deepEqual(store.listSubtasks(g1.id).map((t) => t.id), [a.id])
    assert.deepEqual(store.listSubtasks(g2.id).map((t) => t.id), [b.id])
    assert.equal(store.getGlobalTask(g1.id).progress.total, 1)
    assert.throws(() => store.listSubtasks('run_nope'), /run not found/)
  })

  it('несуществующая глобальная задача и зависимость из чужой — ошибка, задача не создаётся', () => {
    const store = newStore()
    const g1 = store.createGlobalTask({ title: 'G1' })
    const g2 = store.createGlobalTask({ title: 'G2' })
    const a = store.createTask({ title: 'a', runId: g1.id })
    assert.throws(() => store.createTask({ title: 'x', runId: 'run_nope' }), /run not found/)
    assert.throws(() => store.createTask({ title: 'x', runId: g2.id, deps: [a.id] }), /другой глобальной/)
    assert.equal(store.listTasks().length, 1)
  })

  it('задача без runId (старый task create / tasks:create) попадает во «Входящие», одни на проект', () => {
    const store = newStore()
    const a = store.createTask({ title: 'a' })
    const b = store.createTask({ title: 'b' })
    const inbox = store.listGlobalTasks().filter((g) => g.inbox)
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].title, INBOX_TITLE)
    assert.equal(a.runId, inbox[0].id)
    assert.equal(b.runId, inbox[0].id)
  })

  it('updateTask не переносит задачу в другую глобальную', () => {
    const store = newStore()
    const g1 = store.createGlobalTask({ title: 'G1' })
    const g2 = store.createGlobalTask({ title: 'G2' })
    const a = store.createTask({ title: 'a', runId: g1.id })
    store.updateTask(a.id, { runId: g2.id } as Partial<Task>)
    assert.equal(store.getTask(a.id)!.runId, g1.id)
  })
})

describe('удаление глобальной задачи', () => {
  it('с подзадачами без cascade — ошибка, ничего не удалено', () => {
    const store = newStore()
    const g = store.createGlobalTask({ title: 'G' })
    store.createTask({ title: 'a', runId: g.id })
    assert.throws(() => store.deleteGlobalTask(g.id), /cascade/)
    assert.equal(store.listSubtasks(g.id).length, 1)
  })

  it('cascade удаляет подзадачи и их вопросы; чужие задачи не трогает', () => {
    const store = newStore()
    const g = store.createGlobalTask({ title: 'G' })
    const other = store.createGlobalTask({ title: 'O' })
    const a = store.createTask({ title: 'a', runId: g.id })
    const keep = store.createTask({ title: 'k', runId: other.id })
    store.ask({ taskId: a.id, question: '?' })
    const res = store.deleteGlobalTask(g.id, { cascade: true })
    assert.deepEqual(res, { deleted: g.id, tasks: [a.id] })
    assert.equal(store.getRun(g.id), undefined)
    assert.equal(store.getTask(a.id), undefined)
    assert.equal(store.openQuestions().length, 0)
    assert.ok(store.getTask(keep.id))
    assert.ok(store.listTasks().every((t) => t.runId !== undefined && store.getRun(t.runId)), 'сирот нет')
  })

  it('подзадача с живым воркером — ошибка', () => {
    const store = newStore()
    const g = store.createGlobalTask({ title: 'G' })
    const a = store.createTask({ title: 'a', runId: g.id })
    store.startDispatch(a.id, 'pty_1')
    assert.throws(() => store.deleteGlobalTask(g.id, { cascade: true }), /в работе/)
    assert.ok(store.getTask(a.id))
  })

  it('пустая удаляется без cascade', () => {
    const store = newStore()
    const g = store.createGlobalTask({ title: 'G' })
    store.deleteGlobalTask(g.id)
    assert.equal(store.listGlobalTasks().length, 0)
  })
})

describe('жизненный цикл прогона = глобальной задачи', () => {
  it('координатор: прогон → in_progress; все подзадачи в done → run_done и карточка на «Проверке»', () => {
    const store = newStore()
    const run = store.createRun('сделать X')
    assert.equal(store.getGlobalTask(run.id).status, 'plan')
    store.setRunPty(run.id, 'pty_c', 'claude')
    assert.equal(store.getGlobalTask(run.id).status, 'wip')
    assert.equal(store.getGlobalTask(run.id).title, 'сделать X')
    const t = store.createTask({ title: 't', runId: run.id })
    const d = store.startDispatch(t.id, 'pty_w')
    store.finishDispatch(d.id, 'ok')
    const ev = store.consumeEvents(['worker_done'], run.id, run.id)
    assert.equal(ev.length, 1, 'worker_done по-прежнему доходит до прогона')
    store.moveTask(t.id, 'fin')
    const g = store.getGlobalTask(run.id)
    assert.ok(g.closedAt)
    assert.equal(g.status, 'ai')
    assert.equal(store.consumeEvents(['run_done'], run.id, run.id).length, 1)
    assert.equal(store.finishRun(run.id).finishedAt !== undefined, true)
  })

  it('повторный запуск координатора на закрытой глобальной: переоткрыта, run_done не приходит сразу', () => {
    const store = newStore()
    const run = store.createRun('X')
    store.setRunPty(run.id, 'pty_1', 'claude')
    const t = store.createTask({ title: 't', runId: run.id })
    store.moveTask(t.id, 'fin')
    store.consumeEvents(['run_done'], run.id, run.id)
    store.finishRun(run.id)

    store.setRunPty(run.id, 'pty_2', 'claude')
    const g = store.getGlobalTask(run.id)
    assert.equal(g.closedAt, undefined)
    assert.equal(g.finishedAt, undefined)
    assert.equal(g.status, 'wip')
    assert.equal(g.coordinatorPtyId, 'pty_2')
    assert.equal(store.listGlobalTasks().length, 1, 'дубля глобальной задачи нет')
    store.updateGlobalTask(run.id, { title: 'X2' })
    assert.equal(store.consumeEvents(['run_done'], run.id, run.id).length, 0, 'старые done не закрывают заново')

    const t2 = store.createTask({ title: 't2', runId: run.id })
    store.moveTask(t2.id, 'fin')
    assert.ok(store.getRun(run.id)!.closedAt)
    assert.equal(store.consumeEvents(['run_done'], run.id, run.id).length, 1)
  })

  it('новая подзадача в закрытой глобальной переоткрывает её и выводит карточку с проверки', () => {
    const store = newStore()
    const g = store.createGlobalTask({ title: 'G' })
    const a = store.createTask({ title: 'a', runId: g.id })
    store.moveTask(a.id, 'fin')
    assert.ok(store.getRun(g.id)!.closedAt)
    assert.equal(store.getGlobalTask(g.id).status, 'ai')
    const b = store.createTask({ title: 'b', runId: g.id })
    assert.equal(store.getRun(g.id)!.closedAt, undefined)
    assert.equal(store.getGlobalTask(g.id).status, 'wip')
    store.moveTask(b.id, 'fin')
    assert.ok(store.getRun(g.id)!.closedAt)
  })

  it('ручное закрытие: карточка из in_progress — в done, ручная расстановка не меняется, run_done нет', () => {
    const store = newStore()
    const g = store.createGlobalTask({ title: 'G', status: 'plan' })
    store.closeRun(g.id)
    assert.equal(store.getGlobalTask(g.id).status, 'plan')
    const run = store.createRun('X')
    store.setRunPty(run.id, 'pty_c', 'claude')
    store.closeRun(run.id)
    assert.equal(store.getGlobalTask(run.id).status, 'fin')
    assert.equal(store.listEvents().filter((e) => e.type === 'run_done').length, 0)
  })

  it('повторный запуск без новой работы: runs finish закрывает прогон сам, старый run_done погашен', () => {
    const store = newStore()
    const run = store.createRun('X')
    store.setRunPty(run.id, 'pty_1', 'codex')
    const t = store.createTask({ title: 't', runId: run.id })
    store.moveTask(t.id, 'fin')
    // Первый координатор run_done не забрал — новый не должен получить его сразу.
    store.setRunPty(run.id, 'pty_2', 'codex')
    assert.equal(store.consumeEvents(['run_done'], run.id, run.id).length, 0, 'устаревший run_done погашен')
    assert.equal(store.getRun(run.id)!.closedAt, undefined)

    const fin = store.finishRun(run.id)
    assert.ok(fin.closedAt && fin.finishedAt! >= fin.closedAt)
    assert.equal(fin.reopenedAt, undefined)
    assert.equal(store.getGlobalTask(run.id).status, 'ai', 'runs finish без новой работы — снова на проверку')
    const dones = store.listEvents().filter((e) => e.type === 'run_done')
    assert.equal(dones.length, 2, 'новый run_done для закрытия по runs finish')
    assert.equal(store.consumeEvents(['run_done'], run.id, run.id).length, 0, 'новый run_done уже потреблён runs finish')

    // Терминал codex-координатора закрывается по сигналу runs finish.
    const snap = store.snapshot()
    const toClose = coordinatorsToClose({
      runs: snap.runs,
      tasks: snap.tasks,
      questions: snap.questions,
      events: snap.events,
      isDone: (s) => store.columnKind(s) === 'done',
      lingers: (a) => a === 'codex',
      lastActivityAt: () => fin.finishedAt!,
      now: fin.finishedAt! + COORDINATOR_FINISH_GRACE_MS
    })
    assert.deepEqual(toClose, [{ runId: run.id, ptyId: 'pty_2' }])
  })

  it('повторный запуск: новую подзадачу удалили — runs finish всё равно закрывает прогон', () => {
    const store = newStore()
    const run = store.createRun('X')
    store.setRunPty(run.id, 'pty_1', 'codex')
    store.moveTask(store.createTask({ title: 't', runId: run.id }).id, 'fin')
    store.setRunPty(run.id, 'pty_2', 'codex')
    const extra = store.createTask({ title: 'лишняя', runId: run.id })
    assert.throws(() => store.finishRun(run.id), /run not closed/)
    store.deleteTask(extra.id)
    assert.ok(store.finishRun(run.id).closedAt)
  })

  it('повторный запуск с новой подзадачей: run_done после неё, затем runs finish', () => {
    const store = newStore()
    const run = store.createRun('X')
    store.setRunPty(run.id, 'pty_1', 'codex')
    store.moveTask(store.createTask({ title: 't', runId: run.id }).id, 'fin')
    store.setRunPty(run.id, 'pty_2', 'codex')
    const t2 = store.createTask({ title: 't2', runId: run.id })
    assert.throws(() => store.finishRun(run.id), /run not closed/)
    store.moveTask(t2.id, 'fin')
    assert.equal(store.consumeEvents(['run_done'], run.id, run.id).length, 1)
    assert.ok(store.finishRun(run.id).finishedAt)
  })

  it('ручной перенос в «Сделано»: прогон закрыт, координатор получает run_done {manual}, терминал закрывается', () => {
    const store = newStore()
    const run = store.createRun('X')
    store.setRunPty(run.id, 'pty_c', 'claude')
    const t = store.createTask({ title: 't', runId: run.id })
    store.startDispatch(t.id, 'pty_w')
    const got: string[] = []
    const unsub = store.subscribe(() => got.push(...store.consumeEvents(['run_done'], run.id, run.id).map((e) => e.type)))

    const g = store.moveGlobalTask(run.id, 'fin')
    unsub()
    assert.equal(g.status, 'fin')
    assert.ok(g.closedAt)
    assert.equal(store.getTask(t.id)!.status, 'wip', 'статусы подзадач не меняются')
    assert.deepEqual(got, ['run_done'], 'ждущий координатор (check --follow) получает run_done')
    const ev = store.listEvents().find((e) => e.type === 'run_done')!
    assert.deepEqual(ev.payload, { runId: run.id, objective: 'X', manual: true })

    // Координатор мог и не вызвать runs finish: приложение закрывает его терминал само.
    const snap = store.snapshot()
    const toClose = coordinatorsToClose({
      ...snap,
      isDone: (s) => store.columnKind(s) === 'done',
      lingers: () => false,
      lastActivityAt: () => ev.createdAt,
      now: ev.createdAt + COORDINATOR_FINISH_GRACE_MS
    })
    assert.deepEqual(toClose, [{ runId: run.id, ptyId: 'pty_c' }])
    // runs finish после ручного done не падает.
    assert.ok(store.finishRun(run.id).finishedAt)
  })

  it('повторный перенос в «Сделано» не падает и не шлёт второй run_done', () => {
    const store = newStore()
    const g = store.createGlobalTask({ title: 'G', status: 'wip' })
    store.moveGlobalTask(g.id, 'fin')
    const closedAt = store.getRun(g.id)!.closedAt
    store.moveGlobalTask(g.id, 'fin')
    assert.equal(store.getRun(g.id)!.closedAt, closedAt)
    assert.equal(store.listEvents().filter((e) => e.type === 'run_done').length, 1)
    // Уже закрытый автоматически прогон — тоже без второго события.
    const auto = store.createGlobalTask({ title: 'A' })
    store.moveTask(store.createTask({ title: 'a', runId: auto.id }).id, 'fin')
    store.moveGlobalTask(auto.id, 'fin')
    assert.equal(store.listEvents().filter((e) => e.type === 'run_done' && e.payload.runId === auto.id).length, 1)
  })

  it('возврат из «Сделано»: прогон снова открыт, run_done погашен, повторный перенос шлёт новый', () => {
    const store = newStore()
    const run = store.createRun('X')
    store.setRunPty(run.id, 'pty_c', 'codex')
    const t = store.createTask({ title: 't', runId: run.id })
    store.moveGlobalTask(run.id, 'fin')
    const back = store.moveGlobalTask(run.id, 'plan')
    assert.equal(back.status, 'plan', 'карточка там, куда её перенёс человек')
    assert.equal(back.closedAt, undefined)
    assert.equal(store.consumeEvents(['run_done'], run.id, run.id).length, 0, 'старый run_done не долетает')
    const snap = store.snapshot()
    const toClose = coordinatorsToClose({
      ...snap,
      isDone: (s) => store.columnKind(s) === 'done',
      lingers: () => true,
      lastActivityAt: () => 0,
      now: Date.now() + 10 * COORDINATOR_FINISH_GRACE_MS
    })
    assert.deepEqual(toClose, [], 'терминал ожившего прогона не закрывается')
    // Подзадача дошла до done — прогон закрывается автоматически, как обычно.
    store.moveTask(t.id, 'fin')
    assert.ok(store.getRun(run.id)!.closedAt)
    assert.equal(store.consumeEvents(['run_done'], run.id, run.id).length, 1)
    // Снова вернули и снова вручную в done — новый run_done.
    store.moveGlobalTask(run.id, 'wip')
    store.moveGlobalTask(run.id, 'fin')
    assert.equal(store.consumeEvents(['run_done'], run.id, run.id).length, 1)
  })

  it('«Входящие» в «Сделано» вручную: закрыты, run_done не шлют', () => {
    const store = newStore()
    store.createTask({ title: 'во входящие' })
    const inbox = store.listGlobalTasks().find((g) => g.inbox)!
    assert.ok(store.moveGlobalTask(inbox.id, 'fin').closedAt)
    assert.equal(store.listEvents().filter((e) => e.type === 'run_done').length, 0)
  })

  it('свежий прогон без подзадач: runs finish — ошибка; «Входящие» run_done не шлют', () => {
    const store = newStore()
    const run = store.createRun('X')
    assert.throws(() => store.finishRun(run.id), /run not closed/)
    const t = store.createTask({ title: 'во входящие' })
    store.moveTask(t.id, 'fin')
    const inbox = store.listGlobalTasks().find((g) => g.inbox)!
    assert.ok(inbox.closedAt)
    assert.equal(store.listEvents().filter((e) => e.type === 'run_done').length, 0)
  })
})

describe('сохранение и миграция', () => {
  it('глобальные задачи и связь с подзадачами переживают перезапуск', () => {
    const p = memory()
    const store = newStore(p)
    const g = store.createGlobalTask({ title: 'G', description: 'd' })
    store.moveGlobalTask(g.id, 'wip')
    const a = store.createTask({ title: 'a', runId: g.id })
    const reloaded = newStore(p)
    assert.deepEqual(reloaded.getGlobalTask(g.id), store.getGlobalTask(g.id))
    assert.deepEqual(reloaded.listSubtasks(g.id).map((t) => t.id), [a.id])
  })

  it('старый снапшот: прогоны получают статус, задачи без прогона — во «Входящие», id стабилен', () => {
    const T = 1_000
    const task = (id: string, status: string, runId?: string): Task =>
      ({ id, title: id, spec: '', status, deps: [], runId, agent: 'claude', createdAt: T, updatedAt: T }) as Task
    const legacy = {
      tasks: [task('t_open', 'wip', 'run_open'), task('t_closed', 'fin', 'run_closed'), task('t_ui', 'todo'), task('t_lost', 'plan', 'run_deleted')],
      runs: [
        { id: 'run_open', objective: 'идёт', createdAt: T },
        { id: 'run_closed', objective: 'готово', createdAt: T, closedAt: T + 1 }
      ],
      dispatches: [],
      events: [],
      questions: []
    }
    const p = memory(legacy as Partial<StoreSnapshot>)
    const store = newStore(p)
    assert.equal(p.saves(), 1, 'миграция сохранена сразу')
    assert.equal(store.getGlobalTask('run_open').status, 'wip')
    assert.equal(store.getGlobalTask('run_closed').status, 'fin')
    assert.equal(store.getGlobalTask('run_closed').updatedAt, T)
    const inbox = store.listGlobalTasks().find((g) => g.inbox)!
    assert.deepEqual(store.listSubtasks(inbox.id).map((t) => t.id), ['t_ui', 't_lost'])
    assert.equal(store.getTask('t_ui')!.roleId, 'developer')
    assert.equal(inbox.status, 'wip')

    const again = newStore(p)
    assert.equal(p.saves(), 1, 'повторная загрузка ничего не мигрирует')
    assert.equal(again.listGlobalTasks().find((g) => g.inbox)!.id, inbox.id)
  })

  it('миграция «Входящих» из одних done не шлёт run_done', () => {
    const T = 1_000
    const legacy = {
      tasks: [{ id: 't', title: 't', spec: '', status: 'fin', deps: [], roleId: 'developer', agent: 'claude', createdAt: T, updatedAt: T }],
      runs: [],
      dispatches: [],
      events: [],
      questions: []
    }
    const store = newStore(memory(legacy as Partial<StoreSnapshot>))
    const inbox = store.listGlobalTasks()[0]
    assert.ok(inbox.inbox && inbox.closedAt)
    assert.equal(inbox.status, 'fin')
    store.createGlobalTask({ title: 'commit' })
    assert.equal(store.listEvents().filter((e) => e.type === 'run_done').length, 0)
  })
})

describe('«Нужен ответ» — pending-запросы', () => {
  const req = (id: string, runId: string, taskId: string, status: HumanRequest['status']): HumanRequest =>
    ({ id, runId, taskId, kind: 'question', status, title: '?', options: [], createdAt: 1 })
  const requests = [req('a', 'r1', 't1', 'pending'), req('b', 'r1', 't2', 'resolved'), req('c', 'r2', 't3', 'cancelled')]

  it('предикат только по status === pending', () => {
    assert.deepEqual(pendingRequestsOf(requests, { runId: 'r1' }).map((r) => r.id), ['a'])
    assert.equal(hasPendingRequest(requests, { taskId: 't1' }), true)
    assert.equal(hasPendingRequest(requests, { taskId: 't2' }), false)
    assert.equal(hasPendingRequest(requests, { runId: 'r2' }), false)
  })

  it('карточка в needs_input ⇔ pending-запрос прогона; из done и «Проверки» не уходит', () => {
    const run = (id: string, status: string): Run => ({ id, objective: id, status, createdAt: 1 })
    const globals = toGlobalTasks([run('r1', 'plan'), run('r2', 'wip'), run('r3', 'fin'), run('r4', 'ai')], [], COLUMNS,
      [...requests, req('d', 'r3', 't4', 'pending'), req('e', 'r4', 't5', 'pending')])
    assert.deepEqual(globals.map((g) => [g.id, g.status, g.waiting]), [['r1', 'ask', 1], ['r2', 'wip', 0], ['r3', 'fin', 1], ['r4', 'ai', 1]])
  })
})

describe('«Проверка»: приёмка глобальной задачи человеком', () => {
  /** Прогон с координатором и одной подзадачей, дошедшей до done: карточка на проверке, run_done забран. */
  function reviewed(store: TaskStore): { runId: string; taskId: string } {
    const run = store.createRun('X')
    store.setRunPty(run.id, 'pty_1', 'claude')
    const t = store.createTask({ title: 't', runId: run.id })
    store.moveTask(t.id, 'fin')
    assert.equal(store.consumeEvents(['run_done'], run.id, run.id).length, 1)
    store.finishRun(run.id)
    assert.equal(store.getGlobalTask(run.id).status, 'ai')
    return { runId: run.id, taskId: t.id }
  }
  const runDones = (store: TaskStore, runId: string) => store.listEvents().filter((e) => e.type === 'run_done' && e.payload.runId === runId)

  it('«Подтвердить»: review → done, closedAt не меняется, событий нет; не на проверке — ошибка', () => {
    const store = newStore()
    const { runId } = reviewed(store)
    const closedAt = store.getRun(runId)!.closedAt
    const events = store.listEvents().length
    const g = store.acceptGlobalTask(runId)
    assert.equal(g.status, 'fin')
    assert.equal(g.closedAt, closedAt)
    assert.equal(store.listEvents().length, events)
    assert.throws(() => store.acceptGlobalTask(runId), /не на проверке/)
    const other = store.createGlobalTask({ title: 'G', status: 'wip' })
    assert.throws(() => store.acceptGlobalTask(other.id), /не на проверке/)
  })

  it('«Вернуть в работу»: уточнение сохранено, прогон открыт, старые run_done погашены; повторный цикл — снова review', () => {
    const store = newStore()
    const { runId } = reviewed(store)
    // Непрочитанный run_done прошлого закрытия (координатор его не забрал) новый координатор получить не должен.
    const stale = store.createRun('Y')
    store.moveTask(store.createTask({ title: 'y', runId: stale.id }).id, 'fin')
    assert.throws(() => store.returnGlobalTask(stale.id, '   '), /напиши, что доделать/)
    store.returnGlobalTask(stale.id, 'доделай')
    assert.equal(store.consumeEvents(['run_done'], stale.id, stale.id).length, 0, 'старый run_done погашен')

    const g = store.returnGlobalTask(runId, '  добавь тесты  ')
    assert.equal(g.status, 'wip')
    assert.equal(g.closedAt, undefined)
    assert.deepEqual(g.returns?.map((r) => r.text), ['добавь тесты'])
    assert.ok(store.getRun(runId)!.reopenedAt)
    assert.throws(() => store.returnGlobalTask(runId, 'ещё'), /не на проверке/)

    // Новый координатор, новая подзадача — снова run_done и снова «Проверка».
    store.setRunPty(runId, 'pty_2', 'claude')
    const t2 = store.createTask({ title: 't2', runId })
    store.moveTask(t2.id, 'fin')
    assert.equal(store.getGlobalTask(runId).status, 'ai')
    assert.equal(store.consumeEvents(['run_done'], runId, runId).length, 1)
    assert.equal(runDones(store, runId).length, 2)
    store.finishRun(runId)
    // Второй возврат, координатор решил, что работы нет: runs finish — на проверку.
    store.returnGlobalTask(runId, 'поправь README')
    assert.deepEqual(store.getGlobalTask(runId).returns?.map((r) => r.text), ['добавь тесты', 'поправь README'])
    store.setRunPty(runId, 'pty_3', 'claude')
    store.finishRun(runId)
    assert.equal(store.getGlobalTask(runId).status, 'ai')
  })

  it('«Входящие» никогда не на проверке: автозакрытие — в done, вернуть в работу нельзя', () => {
    const store = newStore()
    store.moveTask(store.createTask({ title: 'во входящие' }).id, 'fin')
    const inbox = store.listGlobalTasks().find((g) => g.inbox)!
    assert.equal(inbox.status, 'fin')
    store.moveGlobalTask(inbox.id, 'ai')
    assert.throws(() => store.returnGlobalTask(inbox.id, 'x'), /«Входящие»/)
  })

  it('ручной перенос: в review и done закрывает с run_done {manual}; review → done и done → review без событий', () => {
    const store = newStore()
    const run = store.createRun('X')
    store.setRunPty(run.id, 'pty_c', 'claude')
    store.createTask({ title: 't', runId: run.id })
    const g = store.moveGlobalTask(run.id, 'ai')
    assert.equal(g.status, 'ai')
    assert.ok(g.closedAt)
    assert.deepEqual(runDones(store, run.id).map((e) => e.payload.manual), [true])
    store.moveGlobalTask(run.id, 'fin')
    store.moveGlobalTask(run.id, 'ai')
    assert.equal(runDones(store, run.id).length, 1, 'закрытый прогон повторно не закрывается')
    // Из review в работу — переоткрыт без уточнения, старый run_done погашен.
    const back = store.moveGlobalTask(run.id, 'wip')
    assert.equal(back.closedAt, undefined)
    assert.equal(back.returns, undefined)
    assert.equal(store.consumeEvents(['run_done'], run.id, run.id).length, 0)
    // В done из работы — как раньше: сразу «Сделано», проверка не нужна.
    assert.equal(store.moveGlobalTask(run.id, 'fin').status, 'fin')
    assert.deepEqual(runDones(store, run.id).map((e) => e.payload.manual), [true, true])
  })

  it('перенос в «Проверку» отменяет запросы прогона к человеку', () => {
    const store = newStore()
    const run = store.createRun('X')
    const t = store.createTask({ title: 't', runId: run.id })
    const d = store.startDispatch(t.id, 'pty_w')
    store.ask({ taskId: t.id, dispatchId: d.id, question: 'вопрос?' })
    store.escalateOpenQuestions(run.id)
    assert.equal(store.pendingRequests().filter((r) => r.runId === run.id).length, 1)
    store.moveGlobalTask(run.id, 'ai')
    assert.equal(store.pendingRequests().filter((r) => r.runId === run.id).length, 0)
  })

  it('closeRun — в done, а не на проверку; запуск координатора на review — в работу', () => {
    const store = newStore()
    const run = store.createRun('X')
    store.setRunPty(run.id, 'pty_c', 'claude')
    store.closeRun(run.id)
    assert.equal(store.getGlobalTask(run.id).status, 'fin')
    const { runId } = reviewed(store)
    store.setRunPty(runId, 'pty_2', 'claude')
    assert.equal(store.getGlobalTask(runId).status, 'wip')
    assert.equal(store.getRun(runId)!.closedAt, undefined)
  })

  it('рестарт: review и returns переживают загрузку, старые done остаются done', () => {
    const T = 1_000
    const snap = {
      tasks: [],
      runs: [
        { id: 'run_old', objective: 'o', status: 'fin', closedAt: T, createdAt: T },
        { id: 'run_rev', objective: 'r', status: 'ai', closedAt: T, createdAt: T + 1, returns: [{ at: T, text: 'было' }] }
      ],
      dispatches: [],
      events: [],
      questions: []
    }
    const p = memory(snap as Partial<StoreSnapshot>)
    const store = newStore(p)
    assert.deepEqual(store.listGlobalTasks().map((g) => g.status), ['fin', 'ai'])
    assert.deepEqual(store.getGlobalTask('run_rev').returns, [{ at: T, text: 'было' }])
    store.returnGlobalTask('run_rev', 'ещё')
    const again = newStore(memory(p.saved()))
    assert.deepEqual(again.getRun('run_rev')!.returns?.map((r) => r.text), ['было', 'ещё'])
  })
})
