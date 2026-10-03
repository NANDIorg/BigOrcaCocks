import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Question } from '@orca-board/core'
import type { RequestResolveResult, ReviewInfo } from '@orca-board/contracts'
import { reviewRequestFixture } from '../../../../packages/runtime/test/review-request-command-test-host.ts'
import * as adapter from './review-request-commands'
import { OrcaError, ipcError, setMainLocale } from './i18n'

type Event = { client: string | null }
const fixtures: ReturnType<typeof reviewRequestFixture>[] = []
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); setMainLocale('ru') })
function fixture() {
  assert.equal(typeof adapter.registerDesktopReviewRequestCommands, 'function', 'Desktop использует общие review/request commands')
  const f = reviewRequestFixture(); fixtures.push(f)
  let active: string | undefined; let selections = 0
  f.host.authorize = context => context.clientId === 'desktop:1' && context.actor.kind === 'operator' && context.actor.id === 'local-user'
  const callbacks = new Map<string, (event: Event, ...args: unknown[]) => unknown>()
  adapter.registerDesktopReviewRequestCommands<Event>((channel, callback) => callbacks.set(channel, callback as (event: Event, ...args: unknown[]) => unknown), {
    review: f.review, requests: f.requests, activeProjectId: () => { selections++; return active }, clientId: event => event.client
  })
  assert.deepEqual([...callbacks.keys()].sort(), ['questions:answer', 'requests:list', 'requests:resolve', 'review:accept', 'review:info', 'review:reject'])
  const start = (projectId = 'A') => {
    const p = f.projects.get(projectId)!
    const task = p.store.createTask({ title: 'Legacy', roleId: 'developer' })
    const launch = f.workers.startWorker(p.store, p.root, f.configs.get(projectId)!.environment, task.id)
    return { p, task, launch }
  }
  return { ...f, start, select: (id?: string) => { active = id }, selections: () => selections,
    call: (channel: string, ...args: unknown[]) => callbacks.get(channel)!({ client: 'desktop:1' }, ...args),
    foreign: (channel: string) => callbacks.get(channel)!({ client: null }) }
}
test('caller всех каналов проверяется до selection; no project list=[] и остальные projects.none', () => {
  const f = fixture()
  for (const channel of ['questions:answer', 'requests:list', 'requests:resolve', 'review:accept', 'review:info', 'review:reject']) {
    assert.throws(() => f.foreign(channel), e => e instanceof OrcaError && e.key === 'command.forbidden')
  }
  assert.equal(f.selections(), 0); assert.equal(f.lookupCount(), 0)
  assert.deepEqual(f.call('requests:list'), [])
  assert.throws(() => f.call('review:info', 'task'), e => e instanceof OrcaError && e.key === 'projects.none')
  assert.equal(f.lookupCount(), 0)
})
test('selection фиксируется один раз даже при смене проекта policy; review DTO настоящий Git', () => {
  const f = fixture(); f.select('A'); const { task, launch } = f.start()
  writeFileSync(join(launch.worktree, 'result.txt'), 'result\n'); f.git(launch.worktree, 'add', 'result.txt'); f.git(launch.worktree, 'commit', '-qm', 'result')
  f.host.authorize = context => { f.select('B'); return context.projectId === 'A' }
  const result = f.call('review:info', task.id) as ReviewInfo
  assert.equal(f.selections(), 1); assert.equal(result.branch, launch.branch); assert.match(result.commits.join('\n'), /result/)
  assert.equal(f.projects.get('B')!.store.listTasks().length, 0)
})
test('accept сохраняет прежний void, Git changes и human source', () => {
  const f = fixture(); f.select('A'); const { p, task, launch } = f.start()
  writeFileSync(join(launch.worktree, 'result.txt'), 'result\n'); p.store.finishDispatch(launch.dispatchId, 'Done')
  assert.equal(f.call('review:accept', task.id, 'Approved'), undefined)
  assert.equal(readFileSync(join(p.root, 'result.txt'), 'utf8'), 'result\n'); assert.equal(p.store.getTask(task.id)?.status, 'done')
  assert.equal(p.store.getTask(task.id)?.statusHistory?.at(-1)?.by, 'human')
})
test('questions:answer использует живость и прежний return DTO', () => {
  const f = fixture(); f.select('A'); const { p, task, launch } = f.start()
  const q = p.store.ask({ taskId: task.id, dispatchId: launch.dispatchId, question: 'Choose?' }, { forceHuman: true })
  const result = f.call('questions:answer', q.id, 'Chosen') as Question
  assert.equal(result.answer, 'Chosen'); assert.equal(p.store.pendingRequests().length, 0)
  assert.equal(p.store.getTask(task.id)?.status, 'in_progress'); assert.equal(f.selections(), 1)
})
test('requests:resolve вырезает legacy server paths и возвращает прежний request DTO', () => {
  const f = fixture(); f.select('A'); const { p, task, launch } = f.start()
  p.store.ask({ taskId: task.id, dispatchId: launch.dispatchId, question: 'Choose?' }, { forceHuman: true })
  const request = p.store.pendingRequests()[0]
  const input = { action: 'answer', text: 'Chosen', images: ['/private/secret'] }
  const result = f.call('requests:resolve', request.id, input) as RequestResolveResult
  assert.equal(result.request.status, 'resolved'); assert.equal(p.store.getRequest(request.id)?.resolution?.images, undefined)
  assert.deepEqual(input.images, ['/private/secret']); assert.equal(f.selections(), 1)
})
test('malformed resolution остаётся invalidInput и не меняет store', () => {
  const f = fixture(); f.select('A'); const { p, task, launch } = f.start()
  p.store.ask({ taskId: task.id, dispatchId: launch.dispatchId, question: 'Choose?' }, { forceHuman: true })
  const request = p.store.pendingRequests()[0]; const before = structuredClone(p.store.snapshot())
  assert.throws(() => f.call('requests:resolve', request.id, null), e => e instanceof OrcaError && e.key === 'command.invalidInput')
  assert.deepEqual(p.store.snapshot(), before)
})
for (const language of ['ru', 'en'] as const) test(`scope error локализован ${language}; чужой PTY и request остаются прежними`, () => {
  const f = fixture(); f.select('A'); setMainLocale(language); const { p, task, launch } = f.start()
  p.store.ask({ taskId: task.id, dispatchId: launch.dispatchId, question: 'Choose?' }, { forceHuman: true })
  const request = p.store.pendingRequests()[0]; const before = structuredClone(p.store.snapshot()); f.select('B')
  assert.throws(() => f.call('requests:resolve', request.id, { action: 'answer', text: 'Wrong project' }), e => {
    assert.ok(e instanceof OrcaError); assert.equal(e.key, 'command.requestNotFound')
    const ipc = ipcError(e) as Error; assert.match(ipc.message, language === 'ru' ? /выбранном проекте/ : /selected project/); return true
  })
  assert.deepEqual(p.store.snapshot(), before); assert.equal(f.sessions.isAlive(launch.ptyId), true)
})
for (const language of ['ru', 'en'] as const) test(`invalid attachments сохраняет прежний attachments.invalid ${language}`, () => {
  const f = fixture(); f.select('A'); setMainLocale(language); const { p, task, launch } = f.start()
  p.store.finishDispatch(launch.dispatchId, 'Done'); const before = structuredClone(p.store.snapshot())
  assert.throws(() => f.call('review:reject', task.id, 'Improve', [{ name: 'empty.txt', mime: 'text/plain', data: new Uint8Array() }]), e => {
    assert.ok(e instanceof OrcaError); assert.equal(e.key, 'attachments.invalid')
    const ipc = ipcError(e) as Error; assert.match(ipc.message, language === 'ru' ? /вложени/i : /attachment/i); return true
  })
  assert.deepEqual(p.store.snapshot(), before)
})
