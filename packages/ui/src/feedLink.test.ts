import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// В node нет окна: подставляем EventTarget, как `window` в renderer (feedLink обращается к нему при вызове).
const g = globalThis as unknown as { window: EventTarget & { matchMedia?: unknown } }

beforeEach(() => {
  g.window = new EventTarget()
})

async function link(): Promise<typeof import('./feedLink')> {
  return import('./feedLink')
}

test('«в ленте ↑» и имя задачи в ленте доставляют id получателю', async () => {
  const l = await link()
  const feed: string[] = []
  const board: string[] = []
  const offFeed = l.onRevealInFeed((id) => feed.push(id))
  const offBoard = l.onRevealOnBoard((id) => board.push(id))
  l.revealInFeed('t1')
  l.revealOnBoard('t2')
  assert.deepEqual(feed, ['t1'])
  assert.deepEqual(board, ['t2'])
  offFeed()
  offBoard()
  l.revealInFeed('t3')
  l.revealOnBoard('t4')
  assert.deepEqual([feed, board], [['t1'], ['t2']], 'после отписки события не приходят')
})

test('нет получателя — отправка ничего не ломает; события разных каналов не путаются', async () => {
  const l = await link()
  l.revealInFeed('x')
  l.focusFeed()
  let feedFocus = 0
  let boardFocus = 0
  const a = l.onFocusFeed(() => feedFocus++)
  const b = l.onFocusBoard(() => boardFocus++)
  l.focusFeed()
  l.focusFeed()
  l.focusBoard()
  assert.deepEqual([feedFocus, boardFocus], [2, 1])
  a()
  b()
})

test('прокрутка плавная, но не при «уменьшить движение»', async () => {
  const l = await link()
  assert.equal(l.scrollBehavior(), 'smooth')
  g.window.matchMedia = () => ({ matches: true })
  assert.equal(l.scrollBehavior(), 'auto')
})
