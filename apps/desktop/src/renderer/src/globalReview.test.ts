import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { OrcaApi } from '../../shared/ipc'
import {
  staleReturnLiveMessage,
  staleReviewMessage,
  globalReviewApi,
  globalTaskActions,
  isRunWorkflow,
  returnHint,
  returnsNewestFirst,
  reviewErrorMessage,
  runApprovalRequest
} from './globalReview'
import type { HumanRequest } from '@orca-board/core'
import { setLocale } from './i18n'

/** Выполнить на английском и вернуть русский: остальные тесты файла ждут язык по умолчанию. */
function inEnglish(fn: () => void): void {
  setLocale('en')
  try {
    fn()
  } finally {
    setLocale('ru')
  }
}

test('globalTaskActions: на «Проверке» — подтвердить и вернуть, без запуска координатора', () => {
  assert.deepEqual(globalTaskActions({}, 'review', false), { startCoordinator: false, accept: true, returnToWork: true })
})

test('globalTaskActions: живой координатор на «Проверке» — возврат доступен и закроет его терминал', () => {
  // Регрессия: кнопка выключалась, а терминал Claude без runs finish не закрывается — уточнение не написать.
  assert.deepEqual(globalTaskActions({}, 'review', true), {
    startCoordinator: false, accept: true, returnToWork: true, returnClosesCoordinator: true
  })
})

test('returnHint: при живом координаторе предупреждает, что его терминал закроется', () => {
  assert.doesNotMatch(returnHint(false), /закрыт/)
  assert.match(returnHint(false), /В работе/)
  assert.match(returnHint(true), /терминал будет закрыт/)
  assert.match(returnHint(true), /В работе/)
})

test('globalTaskActions: вне «Проверки» — только запуск координатора, если он не жив', () => {
  for (const kind of ['backlog', 'in_progress', 'needs_input', 'done', undefined] as const) {
    assert.deepEqual(globalTaskActions({}, kind, false), { startCoordinator: true, accept: false, returnToWork: false }, String(kind))
    assert.equal(globalTaskActions({}, kind, true).startCoordinator, false, String(kind))
  }
})

test('globalTaskActions: у «Входящих» действий нет даже в review', () => {
  assert.deepEqual(globalTaskActions({ inbox: true }, 'review', false), { startCoordinator: false, accept: false, returnToWork: false })
  assert.deepEqual(globalTaskActions({ inbox: true }, 'in_progress', false), { startCoordinator: false, accept: false, returnToWork: false })
})

test('returnsNewestFirst: новые сверху, без возвратов — пусто, исходный массив не трогаем', () => {
  assert.deepEqual(returnsNewestFirst({}), [])
  const returns = [{ at: 1, text: 'a' }, { at: 3, text: 'c' }, { at: 2, text: 'b' }]
  assert.deepEqual(returnsNewestFirst({ returns }).map((r) => r.text), ['c', 'b', 'a'])
  assert.equal(returns[0].text, 'a')
})

test('globalReviewApi: старый preload без методов — «перезапустите приложение»', () => {
  assert.throws(() => globalReviewApi(undefined), { message: staleReviewMessage() })
  const old = { globalTasks: {} } as unknown as Partial<OrcaApi>
  assert.throws(() => globalReviewApi(old), { message: staleReviewMessage() })
})

test('globalReviewApi: новый preload — вызовы уходят в методы', async () => {
  const calls: unknown[][] = []
  const api = {
    globalTasks: {
      accept: async (id: string, decision?: string) => { calls.push(['accept', id, decision]); return {} },
      returnToWork: async (id: string, text: string, cols: number, rows: number) => { calls.push(['return', id, text, cols, rows]); return 'pty1' }
    }
  } as unknown as Partial<OrcaApi>
  const r = globalReviewApi(api)
  await r.accept('g1')
  await r.accept('g2', 'вариант B')
  assert.equal(await r.returnToWork('g1', 'доделай', 120, 30), 'pty1')
  assert.deepEqual(calls, [['accept', 'g1', undefined], ['accept', 'g2', 'вариант B'], ['return', 'g1', 'доделай', 120, 30]])
})

test('isRunWorkflow: только прогон с воркфлоу глобальной задачи; «Входящие», прогон старого формата и старый main — нет', () => {
  assert.equal(isRunWorkflow({ workflowScope: 'run' }), true)
  assert.equal(isRunWorkflow({ workflowScope: 'run', inbox: false }), true)
  assert.equal(isRunWorkflow({ workflowScope: 'run', inbox: true }), false)
  assert.equal(isRunWorkflow({}), false)
})

const request = (id: string, extra: Partial<HumanRequest> = {}): HumanRequest =>
  ({ id, runId: 'run_1', kind: 'approval', status: 'pending', title: 'Проверка человеком', options: [], createdAt: 10, ...extra })

test('runApprovalRequest: ждущий approval прогона без задачи; самый старый; чужие, решённые и задачные не считаются', () => {
  assert.equal(runApprovalRequest(undefined, 'run_1'), undefined)
  assert.equal(runApprovalRequest([], 'run_1'), undefined)
  const list = [
    request('later', { createdAt: 30 }),
    request('first', { createdAt: 20 }),
    request('done', { status: 'resolved', createdAt: 1 }),
    request('of-task', { taskId: 't1', createdAt: 2 }),
    request('other-run', { runId: 'run_2', createdAt: 3 }),
    request('question', { kind: 'question', createdAt: 4 })
  ]
  assert.equal(runApprovalRequest(list, 'run_1')?.id, 'first')
  assert.equal(runApprovalRequest(list, 'run_3'), undefined)
})

test('returnHint: у прогона с воркфлоу — граф вернётся по переходу, терминал координатора не закрывается', () => {
  assert.match(returnHint(false, true), /переходу «Вернуть»/)
  assert.match(returnHint(true, true), /наберёт агентов/)
  assert.doesNotMatch(returnHint(true, true), /терминал будет закрыт/)
  assert.equal(returnHint(false, false), returnHint(false))
})

test('reviewErrorMessage: нет хендлера в старом main — «перезапустите», остальное как есть', () => {
  assert.equal(reviewErrorMessage("No handler registered for 'globalTasks:accept'"), staleReviewMessage())
  assert.equal(reviewErrorMessage("No handler registered for 'globalTasks:returnToWork'"), staleReviewMessage())
  assert.equal(reviewErrorMessage('глобальная задача не на проверке'), 'глобальная задача не на проверке')
  assert.equal(
    reviewErrorMessage("Error invoking remote method 'globalTasks:returnToWork': Error: координатор этой глобальной задачи ещё завершается — повторите через несколько секунд"),
    staleReturnLiveMessage()
  )
})

test('reviewErrorMessage: main с переводом — по коду coordinator.finishing на любом языке, текст без обёртки', () => {
  const coded = new Error("Error invoking remote method 'globalTasks:returnToWork': OrcaError[coordinator.finishing]: the coordinator is still finishing")
  assert.equal(reviewErrorMessage(coded), staleReturnLiveMessage())
  assert.equal(reviewErrorMessage(new Error("Error invoking remote method 'globalTasks:accept': OrcaError[global.notFound]: global task not found: g1")), 'global task not found: g1')
})

test('английский интерфейс: подсказка возврата и ошибки старого main', () => {
  inEnglish(() => {
    assert.equal(returnHint(false), 'The task moves to In progress, and a coordinator terminal opens with this note.')
    assert.match(returnHint(true), /^The previous coordinator is still open/)
    assert.throws(() => globalReviewApi(undefined), { message: /old main\/preload version without global task Review/ })
    assert.equal(reviewErrorMessage("No handler registered for 'globalTasks:accept'"), staleReviewMessage())
    assert.match(staleReviewMessage(), /Restart the app/)
    assert.match(returnHint(false, true), /The graph goes back by the “Send back” edge/)
  })
})
