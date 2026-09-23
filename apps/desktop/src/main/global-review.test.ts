// Запуск: pnpm --filter @orca-board/desktop test. Сквозные сценарии колонки «Проверка» глобальных задач:
// настоящий TaskStore, цель повторного запуска (resumeObjective) и правка стора при «Вернуть в работу»
// (returnGlobalTaskToWork). PTY не участвуют: координатор — фейк, повторяющий контракт startCoordinator
// (resumeObjective → setRunPty), живость терминала — множество `alive`.
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  TaskStore, DEFAULT_COLUMNS, COORDINATOR_RETURN_HEADING, GLOBAL_REVIEW_TITLE, coordinatorsToClose, globalBoardColumns,
  type GlobalTask, type OrcaEvent, type Persistence, type StoreSnapshot
} from '@orca-board/core'
import { resumeObjective, returnGlobalTaskToWork } from './coordinator-resume'
import { describeEvent } from './notify'

let store: TaskStore
let alive: Set<string>
let ptys: number

const isAlive = (ptyId: string): boolean => alive.has(ptyId)

beforeEach(() => {
  store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
  alive = new Set()
  ptys = 0
})

const card = (id: string): GlobalTask => store.getGlobalTask(id)
const runDones = (runId: string): OrcaEvent[] => store.listEvents().filter((e) => e.type === 'run_done' && e.payload.runId === runId)

/** Новый координатор на новой глобальной задаче (startCoordinator без runId). */
function startNew(objective: string): string {
  const run = store.createRun(objective)
  const ptyId = `pty_c${++ptys}`
  alive.add(ptyId)
  store.setRunPty(run.id, ptyId, 'claude')
  return run.id
}

/** Повторный запуск координатора (startCoordinator с runId): проверки и цель — resumeObjective, затем setRunPty. */
function restart(runId: string): string {
  const { objective } = resumeObjective(store, runId, isAlive)
  const ptyId = `pty_c${++ptys}`
  alive.add(ptyId)
  store.setRunPty(runId, ptyId, 'claude')
  return objective
}

/** «Вернуть в работу» в main (returnToWork): правка стора, затем повторный запуск координатора. */
function returnToWork(runId: string, text: string): string {
  returnGlobalTaskToWork(store, runId, text, isAlive)
  return restart(runId)
}

/** Координатор закончил (`runs finish`), приложение закрыло его терминал (coordinatorsToClose). */
function finishAndClose(runId: string): void {
  store.finishRun(runId)
  const run = store.getRun(runId)!
  const toClose = coordinatorsToClose({
    runs: store.listRuns(),
    tasks: store.listTasks(),
    questions: [],
    events: store.listEvents(),
    isDone: (s) => store.columnKind(s) === 'done',
    lingers: () => false,
    lastActivityAt: (ptyId) => (alive.has(ptyId) ? 0 : undefined),
    now: Date.now() + 60_000
  })
  assert.deepEqual(toClose, [{ runId, ptyId: run.coordinatorPtyId }], 'терминал координатора закрывается после runs finish')
  alive.delete(run.coordinatorPtyId!)
}

/** Подзадача координатора, доведённая до done. */
function doneSubtask(runId: string, title: string): string {
  const t = store.createTask({ title, runId })
  store.moveTask(t.id, 'in_progress')
  store.moveTask(t.id, 'done')
  return t.id
}

describe('цикл «Проверки»: работа → проверка → возврат → проверка → подтверждение', () => {
  it('сценарии 1–3: две подзадачи → run_done, runs finish → review; возврат с уточнением; новая работа → снова review; «Подтвердить» → done', () => {
    // 1. Прогон с двумя подзадачами: обе done → run_done координатору, после его runs finish — на «Проверку».
    const runId = startNew('Сделать логин')
    const a = store.createTask({ title: 'Форма', runId })
    const b = store.createTask({ title: 'API', runId })
    store.moveTask(a.id, 'done')
    assert.equal(card(runId).status, 'in_progress', 'одна подзадача не done — работа идёт')
    assert.equal(runDones(runId).length, 0)
    store.moveTask(b.id, 'done')

    assert.equal(card(runId).status, 'in_progress', 'координатор жив и решает, нужна ли ещё работа')
    assert.equal(card(runId).closedAt, undefined)
    const [first] = runDones(runId)
    assert.ok(first, 'run_done пришёл координатору')
    assert.equal(first.payload.manual, undefined)
    assert.equal(first.consumedBy, undefined)
    const note = describeEvent(first, undefined, 'orca', true)!
    assert.equal(note.kind, 'runDone')
    assert.match(`${note.title} ${note.body}`, /проверк/i)

    finishAndClose(runId)
    assert.equal(card(runId).status, 'review', 'после runs finish — на проверку, не в «Сделано»')
    // На глобальном канбане колонка review называется «Проверка».
    const col = globalBoardColumns(store.columns()).find((c) => c.id === card(runId).status)!
    assert.equal(col.title, GLOBAL_REVIEW_TITLE)
    assert.ok(card(runId).closedAt)
    assert.ok(store.getRun(runId)!.finishedAt)
    assert.equal(runDones(runId).length, 1, 'runs finish после run_done второго события не шлёт')

    // 2. «Вернуть в работу» с текстом: in_progress, старый run_done погашен, цель — уточнение + подзадачи.
    const eventsBefore = store.listEvents().length
    const objective = returnToWork(runId, 'Добавь восстановление пароля')
    const g = card(runId)
    assert.equal(g.status, 'in_progress')
    assert.equal(g.closedAt, undefined)
    assert.deepEqual(g.returns?.map((r) => r.text), ['Добавь восстановление пароля'])
    assert.equal(runDones(runId)[0].consumedBy, 'reopen', 'старый run_done не достанется новому координатору')
    assert.equal(store.listEvents().length, eventsBefore, 'возврат событий не шлёт — уточнение в цели')
    assert.ok(objective.startsWith('Сделать логин'))
    assert.match(objective, new RegExp(`${COORDINATOR_RETURN_HEADING}: .*\\n+Добавь восстановление пароля`))
    assert.ok(objective.includes(`- ${a.id} [Сделано] Форма`), objective)
    assert.ok(objective.includes(`- ${b.id} [Сделано] API`), objective)
    assert.match(objective, /Уточнение — новая работа/)
    assert.equal(store.getRun(runId)!.coordinatorPtyId, `pty_c${ptys}`, 'новый координатор привязан к прогону')

    // Переоткрытый прогон не закрывается сам, пока новая подзадача не дойдёт до done.
    const c = store.createTask({ title: 'Сброс пароля', runId })
    assert.equal(card(runId).status, 'in_progress')
    assert.equal(runDones(runId).length, 1)

    // 3. Новая подзадача done → новый (непогашенный) run_done, после runs finish — снова review.
    store.moveTask(c.id, 'done')
    assert.equal(card(runId).status, 'in_progress')
    const dones = runDones(runId)
    assert.equal(dones.length, 2, 'новый run_done после повторной работы')
    assert.equal(dones[1].consumedBy, undefined)
    assert.equal(dones[1].payload.manual, undefined)
    finishAndClose(runId)
    assert.equal(card(runId).status, 'review')

    // «Подтвердить» → done без событий, closedAt не меняется.
    const closedAt = card(runId).closedAt
    const before = store.listEvents().length
    assert.equal(store.acceptGlobalTask(runId).status, 'done')
    assert.equal(card(runId).closedAt, closedAt)
    assert.equal(store.listEvents().length, before, 'приёмка событий не шлёт')
    assert.throws(() => store.acceptGlobalTask(runId), /не на проверке/)
    assert.throws(() => returnToWork(runId, 'ещё'), /не на проверке/, 'из «Сделано» кнопкой не вернуть')
  })

  it('второй возврат: в цели последнее уточнение полностью, прошлые — списком', () => {
    const runId = startNew('Цель')
    doneSubtask(runId, 'Шаг 1')
    finishAndClose(runId)
    returnToWork(runId, 'первое')
    doneSubtask(runId, 'Шаг 2')
    finishAndClose(runId)
    const objective = returnToWork(runId, 'второе')
    assert.match(objective, new RegExp(`${COORDINATOR_RETURN_HEADING}: .*\\n+второе\\n`))
    assert.match(objective, /Прошлые уточнения[^\n]*\n- первое/)
    assert.deepEqual(card(runId).returns?.map((r) => r.text), ['первое', 'второе'])
  })

  it('возврат, пока старый координатор ещё не закрыт (окно после runs finish), — ошибка, стор не тронут', () => {
    const runId = startNew('Цель')
    doneSubtask(runId, 'Шаг')
    store.finishRun(runId) // терминал ещё жив: coordinatorsToClose закроет его через grace
    assert.throws(() => returnToWork(runId, 'доделай'), /ещё завершается/)
    assert.equal(card(runId).status, 'review')
    assert.equal(card(runId).returns, undefined)
    assert.equal(runDones(runId)[0].consumedBy, undefined)
  })

  it('пустое уточнение — ошибка, карточка остаётся на проверке', () => {
    const runId = startNew('Цель')
    doneSubtask(runId, 'Шаг')
    finishAndClose(runId)
    assert.throws(() => returnToWork(runId, '   '), /напиши, что доделать/)
    assert.equal(card(runId).status, 'review')
    assert.equal(card(runId).returns, undefined)
  })
})

describe('все подзадачи done при живом координаторе', () => {
  it('run_done отправлен, но карточка не в «Сделано» и не на «Проверке»; settleIdleRuns живой прогон не трогает', () => {
    const runId = startNew('Цель')
    doneSubtask(runId, 'Шаг')
    const g = card(runId)
    assert.equal(g.status, 'in_progress')
    assert.equal(g.closedAt, undefined)
    assert.ok(store.getRun(runId)!.runDoneAt)
    assert.equal(runDones(runId).length, 1)
    assert.deepEqual(store.settleIdleRuns(isAlive), [], 'координатор жив — решает он')
    assert.equal(card(runId).status, 'in_progress')
    // Повторные коммиты стора второй run_done не шлют.
    store.createGlobalTask({ title: 'другая' })
    assert.equal(runDones(runId).length, 1)
  })

  it('после run_done координатор создал подзадачу → прогон снова открыт, по её done — новый run_done', () => {
    const runId = startNew('Цель')
    doneSubtask(runId, 'Шаг 1')
    assert.equal(store.consumeEvents(['run_done'], runId, runId).length, 1)
    const t = store.createTask({ title: 'Шаг 2', runId })
    assert.equal(store.getRun(runId)!.runDoneAt, undefined, 'прогон снова открыт')
    assert.equal(card(runId).status, 'in_progress')
    assert.throws(() => store.finishRun(runId), /дождись run_done/, 'runs finish до конца новой работы — ошибка')
    store.moveTask(t.id, 'done')
    assert.equal(card(runId).status, 'in_progress')
    assert.equal(store.consumeEvents(['run_done'], runId, runId).length, 1, 'новый run_done')
    finishAndClose(runId)
    assert.equal(card(runId).status, 'review')
  })

  it('подзадачу вернули из done после run_done → прогон открыт, непрочитанный run_done погашен', () => {
    const runId = startNew('Цель')
    const t = doneSubtask(runId, 'Шаг')
    store.moveTask(t, 'in_progress')
    assert.equal(store.getRun(runId)!.runDoneAt, undefined)
    assert.equal(runDones(runId)[0].consumedBy, 'reopen')
    assert.equal(store.consumeEvents(['run_done'], runId, runId).length, 0)
    store.moveTask(t, 'done')
    assert.equal(store.consumeEvents(['run_done'], runId, runId).length, 1)
  })

  it('координатор вышел после run_done без runs finish → «Проверка» без нового run_done', () => {
    const runId = startNew('Цель')
    doneSubtask(runId, 'Шаг')
    alive.delete(store.getRun(runId)!.coordinatorPtyId!)
    assert.deepEqual(store.settleIdleRuns(isAlive), [runId])
    const g = card(runId)
    assert.equal(g.status, 'review')
    assert.ok(g.closedAt)
    assert.equal(runDones(runId).length, 1)
    assert.deepEqual(store.settleIdleRuns(isAlive), [], 'повторно не закрывает')
  })

  it('координатор умер до конца работы: подзадачи дошли до done → run_done, затем settleIdleRuns → «Проверка»', () => {
    const runId = startNew('Цель')
    const t = store.createTask({ title: 'Шаг', runId })
    alive.clear()
    store.moveTask(t.id, 'done')
    assert.equal(card(runId).status, 'in_progress')
    store.settleIdleRuns(isAlive)
    assert.equal(card(runId).status, 'review')
  })

  it('«незакрывающийся» координатор без runs finish: терминал закрывается по страховке, затем «Проверка»', () => {
    const runId = startNew('Цель')
    doneSubtask(runId, 'Шаг')
    const ptyId = store.getRun(runId)!.coordinatorPtyId!
    const toClose = coordinatorsToClose({
      runs: store.listRuns(),
      tasks: store.listTasks(),
      questions: [],
      events: store.listEvents(),
      isDone: (s) => store.columnKind(s) === 'done',
      lingers: () => true,
      lastActivityAt: () => 0,
      now: Date.now() + 60 * 60_000
    })
    assert.deepEqual(toClose, [{ runId, ptyId }])
    alive.delete(ptyId)
    store.settleIdleRuns(isAlive)
    assert.equal(card(runId).status, 'review')
  })

  it('человек перенёс карточку, пока координатор решал: закрыта с run_done {manual}', () => {
    const runId = startNew('Цель')
    doneSubtask(runId, 'Шаг')
    assert.equal(store.moveGlobalTask(runId, 'done').status, 'done')
    assert.ok(card(runId).closedAt)
    assert.deepEqual(runDones(runId).map((e) => e.payload.manual), [undefined, true])
  })

  it('глобальная задача без координатора (завёл человек): все подзадачи done → сразу «Проверка» с run_done', () => {
    const g = store.createGlobalTask({ title: 'Руками' })
    const t = store.createTask({ title: 'Шаг', runId: g.id })
    store.moveTask(t.id, 'done')
    assert.equal(card(g.id).status, 'review')
    assert.equal(runDones(g.id).length, 1)
  })
})

describe('повторный запуск без новой работы', () => {
  it('сценарий 4: после возврата координатор решил, что работы нет, — runs finish → снова review', () => {
    const runId = startNew('Цель')
    doneSubtask(runId, 'Шаг')
    finishAndClose(runId)
    returnToWork(runId, 'проверь, что всё уже есть')
    assert.equal(card(runId).status, 'in_progress')

    const before = runDones(runId).length
    finishAndClose(runId)
    const g = card(runId)
    assert.equal(g.status, 'review', 'finishRun закрывает переоткрытый прогон на проверку')
    assert.ok(g.closedAt)
    const dones = runDones(runId)
    assert.equal(dones.length, before + 1)
    assert.equal(dones.at(-1)!.consumedBy, 'runs finish', 'координатор сам сообщил о конце — ждать run_done ему не нужно')
  })

  it('«Запустить координатора» на карточке в review (без уточнения) → в работу; runs finish → review', () => {
    const runId = startNew('Цель')
    doneSubtask(runId, 'Шаг')
    finishAndClose(runId)
    const objective = restart(runId)
    assert.ok(!objective.includes(COORDINATOR_RETURN_HEADING), 'уточнений не было — блока нет')
    assert.match(objective, /Если все они в done/)
    assert.equal(card(runId).status, 'in_progress')
    finishAndClose(runId)
    assert.equal(card(runId).status, 'review')
  })

  it('упал запуск после возврата: карточка в работе с уточнением, «Запустить координатора» его подхватит', () => {
    const runId = startNew('Цель')
    doneSubtask(runId, 'Шаг')
    finishAndClose(runId)
    returnGlobalTaskToWork(store, runId, 'доделай README', isAlive) // spawn после этого упал
    assert.equal(card(runId).status, 'in_progress')
    assert.match(restart(runId), /Уточнение после проверки[^\n]*\n+доделай README/)
  })

  it('второй живой координатор на той же задаче — ошибка', () => {
    const runId = startNew('Цель')
    assert.throws(() => restart(runId), /уже работает/)
  })
})

describe('сценарий 5: ручной перенос карточки', () => {
  it('in_progress → done: done и run_done {manual}; подзадачи не трогаются', () => {
    const runId = startNew('Цель')
    const t = store.createTask({ title: 'Шаг', runId })
    const status = store.getTask(t.id)!.status
    assert.equal(store.moveGlobalTask(runId, 'done').status, 'done')
    const [e] = runDones(runId)
    assert.equal(e.payload.manual, true)
    assert.equal(store.getTask(t.id)!.status, status)
  })

  it('in_progress → review: review и run_done {manual}; pending-запросы прогона отменены', () => {
    const runId = startNew('Цель')
    const t = store.createTask({ title: 'Шаг', runId })
    store.ask({ taskId: t.id, question: 'Какой цвет?' }, { coordinatorAlive: false })
    assert.equal(store.pendingRequests(runId).length, 1)
    assert.equal(card(runId).status, 'needs_input', 'пока ждёт человека — «Нужен ответ»')

    assert.equal(store.moveGlobalTask(runId, 'review').status, 'review')
    assert.equal(store.pendingRequests(runId).length, 0, 'отвечать больше незачем')
    const [e] = runDones(runId)
    assert.equal(e.payload.manual, true)
    assert.ok(card(runId).closedAt)
  })

  it('review → in_progress: прогон переоткрыт без уточнения, координатор не стартует; старый run_done погашен', () => {
    const runId = startNew('Цель')
    doneSubtask(runId, 'Шаг')
    finishAndClose(runId)
    const started = ptys
    assert.equal(store.moveGlobalTask(runId, 'in_progress').status, 'in_progress')
    const g = card(runId)
    assert.equal(g.closedAt, undefined)
    assert.equal(g.returns, undefined)
    assert.equal(ptys, started, 'координатор не запускался')
    assert.equal(runDones(runId)[0].consumedBy, 'reopen')
  })

  it('review → done и done → review: закрытый прогон не трогается, событий нет', () => {
    const runId = startNew('Цель')
    doneSubtask(runId, 'Шаг')
    finishAndClose(runId)
    const closedAt = card(runId).closedAt
    const before = store.listEvents().length
    assert.equal(store.moveGlobalTask(runId, 'done').status, 'done')
    assert.equal(store.moveGlobalTask(runId, 'review').status, 'review')
    assert.equal(card(runId).closedAt, closedAt)
    assert.equal(store.listEvents().length, before)
  })

  it('closeRun (runs close) — в done, не на проверку, без run_done', () => {
    const runId = startNew('Цель')
    store.closeRun(runId)
    assert.equal(card(runId).status, 'done')
    assert.equal(runDones(runId).length, 0)
  })
})

describe('сценарий 6: рестарт приложения', () => {
  const T = 1_700_000_000_000

  function memory(snap: Partial<StoreSnapshot> | null): Persistence & { data: StoreSnapshot | null } {
    const p = {
      data: null as StoreSnapshot | null,
      load: () => snap,
      save(s: StoreSnapshot) { p.data = s }
    }
    return p
  }

  it('карточка на проверке с уточнениями переживает перезагрузку; после рестарта её можно вернуть и подтвердить', () => {
    const p = memory(null)
    store = new TaskStore(p, () => DEFAULT_COLUMNS)
    const runId = startNew('Цель')
    doneSubtask(runId, 'Шаг')
    finishAndClose(runId)
    returnToWork(runId, 'первое')
    doneSubtask(runId, 'Шаг 2')
    finishAndClose(runId)
    assert.equal(card(runId).status, 'review')

    // Рестарт: PTY координаторов умерли.
    alive.clear()
    const saved = JSON.parse(JSON.stringify(p.data)) as StoreSnapshot
    store = new TaskStore(memory(saved), () => DEFAULT_COLUMNS)
    const g = card(runId)
    assert.equal(g.status, 'review', 'review не сводится к in_progress миграцией')
    assert.deepEqual(g.returns?.map((r) => r.text), ['первое'])

    const objective = returnToWork(runId, 'второе')
    assert.match(objective, /второе/)
    assert.match(objective, /- первое/)
    doneSubtask(runId, 'Шаг 3')
    assert.equal(card(runId).status, 'in_progress', 'координатор жив — ждём его runs finish')
    // Снова рестарт: координатор умер после run_done, runs finish не будет — main закрывает прогон на проверку.
    alive.clear()
    store = new TaskStore(memory(JSON.parse(JSON.stringify(store.snapshot())) as StoreSnapshot), () => DEFAULT_COLUMNS)
    assert.equal(card(runId).status, 'in_progress', 'загрузка сама прогон не закрывает')
    assert.deepEqual(store.settleIdleRuns(isAlive), [runId])
    assert.equal(card(runId).status, 'review')
    assert.equal(store.acceptGlobalTask(runId).status, 'done')
  })

  it('старые снапшоты: done остаётся done, закрытый прогон без статуса — done, не на проверку', () => {
    const snap: Partial<StoreSnapshot> = {
      runs: [
        { id: 'run_done', objective: 'старая', status: 'done', closedAt: T, createdAt: T },
        { id: 'run_old', objective: 'совсем старая', closedAt: T, createdAt: T + 1 },
        { id: 'run_rev', objective: 'на проверке', status: 'review', closedAt: T, createdAt: T + 2, returns: [{ at: T, text: 'было' }] }
      ],
      tasks: [],
      events: []
    }
    store = new TaskStore(memory(snap), () => DEFAULT_COLUMNS)
    assert.equal(card('run_done').status, 'done')
    assert.equal(card('run_old').status, 'done')
    assert.equal(card('run_rev').status, 'review')
    assert.throws(() => store.acceptGlobalTask('run_done'), /не на проверке/)
    assert.equal(store.acceptGlobalTask('run_rev').status, 'done')
  })
})

describe('сценарий 7: «Входящие» не проверяются', () => {
  it('все задачи «Входящих» done → сразу «Сделано», без run_done', () => {
    const t = store.createTask({ title: 'Разовая' })
    const inbox = store.listGlobalTasks().find((g) => g.inbox)!
    store.moveTask(t.id, 'done')
    assert.equal(card(inbox.id).status, 'done')
    assert.equal(runDones(inbox.id).length, 0)
  })

  it('returnGlobalTask и повторный запуск на «Входящих» — ошибка', () => {
    store.createTask({ title: 'Разовая' })
    const inbox = store.listGlobalTasks().find((g) => g.inbox)!
    assert.throws(() => returnGlobalTaskToWork(store, inbox.id, 'доделай', isAlive), /«Входящие» нельзя вернуть/)
    assert.throws(() => resumeObjective(store, inbox.id, isAlive), /«Входящие» — не цель/)
  })

  it('ручной перенос «Входящих» в «Проверку» — ошибка: у них нет ни «Подтвердить», ни «Вернуть»', () => {
    store.createTask({ title: 'Разовая' })
    const inbox = store.listGlobalTasks().find((g) => g.inbox)!
    assert.throws(() => store.moveGlobalTask(inbox.id, 'review'), /«Входящие» не проверяются/)
    assert.equal(card(inbox.id).status, inbox.status, 'карточка осталась на месте')
    assert.equal(store.moveGlobalTask(inbox.id, 'done').status, 'done')
    assert.throws(() => store.moveGlobalTask(inbox.id, 'review'), /«Входящие» не проверяются/, 'и из «Сделано» тоже')
    assert.equal(card(inbox.id).status, 'done')
  })
})
