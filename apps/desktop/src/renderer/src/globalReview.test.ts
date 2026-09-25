import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { OrcaApi } from '../../shared/ipc'
import {
  staleReturnLiveMessage,
  staleReviewMessage,
  globalReviewApi,
  globalTaskActions,
  returnHint,
  returnsNewestFirst,
  reviewErrorMessage
} from './globalReview'
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
      accept: async (id: string) => { calls.push(['accept', id]); return {} },
      returnToWork: async (id: string, text: string, cols: number, rows: number) => { calls.push(['return', id, text, cols, rows]); return 'pty1' }
    }
  } as unknown as Partial<OrcaApi>
  const r = globalReviewApi(api)
  await r.accept('g1')
  assert.equal(await r.returnToWork('g1', 'доделай', 120, 30), 'pty1')
  assert.deepEqual(calls, [['accept', 'g1'], ['return', 'g1', 'доделай', 120, 30]])
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

test('английский интерфейс: подсказка возврата и ошибки старого main', () => {
  inEnglish(() => {
    assert.equal(returnHint(false), 'The task moves to In progress, and a coordinator terminal opens with this note.')
    assert.match(returnHint(true), /^The previous coordinator is still open/)
    assert.throws(() => globalReviewApi(undefined), { message: /old main\/preload version without global task Review/ })
    assert.equal(reviewErrorMessage("No handler registered for 'globalTasks:accept'"), staleReviewMessage())
    assert.match(staleReviewMessage(), /Restart the app/)
  })
})
