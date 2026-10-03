import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AttachmentInput, RequestResolution, Workflow } from '@orca-board/core'
import { CommandError } from '../src/index.ts'
import { reviewRequestFixture } from './review-request-command-test-host.ts'
import { feedbackFile } from './coordinator-command-test-host.ts'

const fixtures: ReturnType<typeof reviewRequestFixture>[] = []
afterEach(() => { for (const f of fixtures.splice(0)) f.close() })
function fixture() { const f = reviewRequestFixture(); fixtures.push(f); return f }
function errorCode(code: string) { return (e: unknown) => e instanceof CommandError && e.code === code }
function task(f: ReturnType<typeof fixture>, projectId = 'A', answerFor?: 'human') {
  const p = f.projects.get(projectId)!
  const t = p.store.createTask({ title: 'Work', roleId: 'developer', ...(answerFor ? { answerFor } : {}) })
  // Старые задачи без stage проверяют legacy review; общий worker API отдельно покрыт его suite.
  const launch = f.workers.startWorker(p.store, p.root, f.configs.get(projectId)!.environment, t.id)
  return { p, t, launch }
}
function finished(f: ReturnType<typeof fixture>, answerFor?: 'human') {
  const result = task(f, 'A', answerFor)
  result.p.store.finishDispatch(result.launch.dispatchId, 'Result', [], answerFor ? 'Full answer' : undefined)
  return result
}
function asked(f: ReturnType<typeof fixture>, projectId = 'A') {
  const result = task(f, projectId)
  const q = result.p.store.ask({ taskId: result.t.id, dispatchId: result.launch.dispatchId, question: 'Choose?' }, { forceHuman: true })
  return { ...result, q, request: result.p.store.pendingRequests()[0] }
}

test('review info возвращает настоящие Git commits и отдельный DTO выбранного проекта', () => {
  const f = fixture(); const { p, t, launch } = task(f)
  writeFileSync(join(launch.worktree, 'result.txt'), 'result\n')
  f.git(launch.worktree, 'add', 'result.txt'); f.git(launch.worktree, 'commit', '-qm', 'worker result')
  const before = structuredClone(f.projects.get('B')!.store.snapshot())
  const info = f.review.info(f.context(), t.id)
  assert.equal(info.branch, launch.branch); assert.equal(info.base, 'master')
  assert.match(info.commits.join('\n'), /worker result/); assert.match(info.stat, /result.txt/)
  assert.equal(info.dirty, false); info.commits.push('client mutation')
  assert.ok(!f.review.info(f.context(), t.id).commits.includes('client mutation'))
  assert.deepEqual(f.projects.get('B')!.store.snapshot(), before); assert.equal(p.store.getTask(t.id)?.status, 'in_progress')
})
test('accept сохраняет реальные Git changes и удаляет свой worktree после done', () => {
  const f = fixture(); const { p, t, launch } = finished(f)
  writeFileSync(join(launch.worktree, 'result.txt'), 'result\n')
  const before = structuredClone(f.projects.get('B')!.store.snapshot())
  const result = f.review.accept(f.context(), t.id, 'Approved')
  assert.equal(result?.status, 'done'); assert.equal(readFileSync(join(p.root, 'result.txt'), 'utf8'), 'result\n')
  assert.equal(existsSync(launch.worktree), false); assert.equal(p.store.getTask(t.id)?.statusHistory?.at(-1)?.by, 'human')
  assert.deepEqual(f.projects.get('B')!.store.snapshot(), before)
})
test('чужой task/request/question не вызывает Git, spawn, kill или изменение обоих store', () => {
  const f = fixture(); const { p, t, launch, q, request } = asked(f)
  const a = structuredClone(p.store.snapshot()); const b = structuredClone(f.projects.get('B')!.store.snapshot())
  assert.throws(() => f.review.accept(f.context('B'), t.id), errorCode('command.taskNotFound'))
  assert.throws(() => f.requests.resolve(f.context('B'), request.id, { action: 'answer', text: 'B' }), errorCode('command.requestNotFound'))
  assert.throws(() => f.requests.answer(f.context('B'), q.id, 'B'), errorCode('command.questionNotFound'))
  assert.deepEqual(p.store.snapshot(), a); assert.deepEqual(f.projects.get('B')!.store.snapshot(), b)
  assert.equal(f.sessions.isAlive(launch.ptyId), true); assert.equal(f.processes.length, 1)
})
test('policy раньше payload/project lookup сохраняет store и живой PTY', () => {
  const f = fixture(); const { p, launch } = task(f); const before = structuredClone(p.store.snapshot()); const lookups = f.lookupCount()
  f.denyCommands()
  assert.throws(() => f.review.reject(f.context(), '', '', []), errorCode('command.forbidden'))
  assert.throws(() => f.requests.resolve(f.context(), '', {} as RequestResolution), errorCode('command.forbidden'))
  assert.equal(f.lookupCount(), lookups); assert.deepEqual(p.store.snapshot(), before); assert.equal(f.sessions.isAlive(launch.ptyId), true)
})
test('невалидный context отказывает раньше policy и lookup', () => {
  const f = fixture()
  assert.throws(() => f.requests.list({ projectId: '', clientId: 'x', actor: { kind: 'operator', id: 'x' } }), errorCode('command.invalidContext'))
  assert.equal(f.lookupCount(), 0); assert.equal(f.policy.length, 0)
})
for (const bad of [{ pending: 'yes' }, { runId: '' }, { extra: true }]) test(`list отклоняет payload до lookup: ${JSON.stringify(bad)}`, () => {
  const f = fixture()
  assert.throws(() => f.requests.list(f.context(), bad as never), errorCode('command.invalidInput'))
  assert.equal(f.lookupCount(), 0)
})
for (const bad of [{ action: 'unknown' }, { action: 'answer', text: 1 }, { action: 'answer', optionId: '' }, { action: 'answer', images: ['/private/secret'] }]) test(`resolve whitelist до lookup: ${JSON.stringify(bad)}`, () => {
  const f = fixture()
  assert.throws(() => f.requests.resolve(f.context(), 'request', bad as never), errorCode('command.invalidInput'))
  assert.equal(f.lookupCount(), 0)
})
test('sparse вложения и нестроковый feedback отклоняются до lookup', () => {
  const f = fixture()
  assert.throws(() => f.review.reject(f.context(), 'task', 'feedback', new Array<AttachmentInput>(1)), errorCode('command.invalidInput'))
  assert.throws(() => f.review.reject(f.context(), 'task', 1 as never), errorCode('command.invalidInput'))
  assert.equal(f.lookupCount(), 0)
})
test('list фильтрует run/pending и не отдаёт изменяемый request из store', () => {
  const f = fixture(); const { p, request } = asked(f)
  const list = f.requests.list(f.context(), { runId: request.runId, pending: true })
  assert.equal(list.length, 1); assert.equal(list[0].id, request.id); list[0].title = 'client mutation'
  assert.equal(p.store.getRequest(request.id)?.title, 'Choose?')
  assert.deepEqual(f.requests.list(f.context(), { runId: 'other' }), [])
})
for (const kind of ['operator', 'agent', 'system'] as const) test(`question answer сохраняет источник ${kind} и закрывает human request`, () => {
  const f = fixture(); const { p, q, request } = asked(f)
  const result = f.requests.answer(f.context('A', kind), q.id, 'Chosen')
  assert.equal(result.answer, 'Chosen'); assert.equal(p.store.getRequest(request.id)?.status, 'resolved')
  assert.equal(p.store.getTask(q.taskId)?.status, 'in_progress')
  assert.equal(p.store.getTask(q.taskId)?.statusHistory?.at(-1)?.by, kind === 'operator' ? 'human' : kind === 'agent' ? 'cli' : 'app')
  result.answer = 'mutated'; assert.equal(p.store.getQuestion(q.id)?.answer, 'Chosen')
})
test('dead PTY до answer закрывает stale dispatch и возвращает задачу в ready', () => {
  const f = fixture(); const p = f.projects.get('A')!
  const t = p.store.createTask({ title: 'Lost exit', roleId: 'developer' })
  const dispatch = p.store.startDispatch(t.id, 'unregistered-dead-pty')
  const q = p.store.ask({ taskId: t.id, dispatchId: dispatch.id, question: 'Choose?' }, { forceHuman: true })
  const request = p.store.pendingRequests()[0]
  f.requests.resolve(f.context(), request.id, { action: 'answer', text: 'Chosen' })
  assert.ok(p.store.getDispatch(dispatch.id)?.endedAt); assert.equal(p.store.getTask(q.taskId)?.status, 'ready')
})
test('повторный answer отказывает и не меняет новое состояние', () => {
  const f = fixture(); const { p, q } = asked(f)
  f.requests.answer(f.context(), q.id, 'First'); const before = structuredClone(p.store.snapshot())
  assert.throws(() => f.requests.answer(f.context(), q.id, 'Second'), errorCode('command.rejected'))
  assert.deepEqual(p.store.snapshot(), before)
})
test('resolved request отказывает до записи вложений и не заменяет первый ответ', () => {
  const f = fixture(); const { p, request, launch } = asked(f)
  f.requests.resolve(f.context(), request.id, { action: 'answer', text: 'First' }); const before = structuredClone(p.store.snapshot())
  assert.throws(() => f.requests.resolve(f.context(), request.id, { action: 'reject', text: 'Second' }, feedbackFile), errorCode('command.rejected'))
  assert.deepEqual(p.store.snapshot(), before); assert.equal(existsSync(join(launch.worktree, '.orca-attachments', 'returns')), false)
})
test('trusted resolution отбрасывает client paths перед записью ответа', () => {
  const f = fixture(); const { p, request } = asked(f)
  const result = f.operations.resolve(p, request.id, { action: 'answer', text: 'Chosen', images: ['/private/secret'] })
  assert.equal(result.request.status, 'resolved'); assert.equal(p.store.getRequest(request.id)?.resolution?.images, undefined)
})
test('clarify сохраняет вложения в cwd воркера и запускает его один раз', () => {
  const f = fixture(); const { p, t, launch } = finished(f, 'human'); const request = p.store.pendingRequests()[0]
  const result = f.requests.resolve(f.context(), request.id, { action: 'clarify', text: 'Improve' }, feedbackFile)
  assert.ok(result.worker); assert.equal(f.processes.length, 2); assert.equal(p.store.getTask(t.id)?.feedback, 'Improve')
  const paths = p.store.getRequest(request.id)?.resolution?.images
  assert.equal(paths?.length, 1); assert.ok(paths![0].startsWith(launch.worktree)); assert.equal(readFileSync(paths![0], 'utf8'), 'AB')
})
test('failed spawn после clarify сохраняет принятое решение и escalation', () => {
  const f = fixture(); const { p, t } = finished(f, 'human'); const request = p.store.pendingRequests()[0]; f.fail()
  const result = f.requests.resolve(f.context(), request.id, { action: 'clarify', text: 'Improve' })
  assert.equal(result.request.status, 'resolved'); assert.equal(result.worker, undefined); assert.ok(result.startError)
  assert.ok(p.store.listEvents().some(e => e.type === 'escalation' && e.taskId === t.id && e.payload.startFailed === true && e.payload.requestId === request.id))
})
test('reject задачи вне workflow сохраняет feedback с вложениями и ready без нового spawn', () => {
  const f = fixture(); const { p, t } = finished(f)
  const result = f.review.reject(f.context(), t.id, 'Improve', feedbackFile)
  assert.equal(result?.status, 'ready'); assert.equal(f.processes.length, 1)
  const feedback = p.store.getTask(t.id)?.feedback
  assert.equal(feedback, 'Improve'); assert.equal(readFileSync(p.store.getTask(t.id)!.feedbackImages![0], 'utf8'), 'AB')
})
test('нет текста вложений — отказ до изменения feedback/store', () => {
  const f = fixture(); const { p, t } = finished(f); const before = structuredClone(p.store.snapshot())
  assert.throws(() => f.review.reject(f.context(), t.id, '', feedbackFile), errorCode('command.rejected'))
  assert.deepEqual(p.store.snapshot(), before); assert.equal(f.processes.length, 1)
})

function run(f: ReturnType<typeof fixture>, middle: 'human' | 'decision' | 'gate') {
  const p = f.projects.get('A')!
  const workflow: Workflow = { version: 2,
    nodes: [{ id: 'start', type: 'start', x: 0, y: 0 },
      middle === 'human' ? { id: 'middle', type: 'human', x: 0, y: 0 }
        : middle === 'decision' ? { id: 'middle', type: 'decision', roleId: 'reviewer', question: 'Ready?', options: [{ id: 'yes', label: 'Yes' }], x: 0, y: 0 }
          : { id: 'middle', type: 'gate', roleId: 'reviewer', x: 0, y: 0 },
      { id: 'human', type: 'human', x: 0, y: 0 }, { id: 'end', type: 'end', x: 0, y: 0 }],
    edges: [{ id: 'a', from: 'start', outcome: 'next', to: 'middle' },
      { id: 'b', from: 'middle', outcome: middle === 'decision' ? 'yes' : 'accept', to: middle === 'gate' ? 'human' : 'end' },
      { id: 'c', from: 'human', outcome: 'accept', to: 'end' }] }
  const g = p.store.createGlobalTask({ title: 'Global', workflow })
  f.common.ensureRunBranch(p.store, p.root, g.id)
  p.store.setRunPty(g.id, 'test-coordinator')
  f.workflow.run.startRunWorkflow(p.workflow, g.id)
  return { p, g }
}
test('taskless approval идёт через run router и завершает свой прогон', () => {
  const f = fixture(); const { p, g } = run(f, 'human'); const request = p.store.pendingRequests(g.id)[0]
  assert.equal(request.taskId, undefined)
  const before = structuredClone(f.projects.get('B')!.store.snapshot())
  const result = f.requests.resolve(f.context(), request.id, { action: 'accept', text: 'Ready' })
  assert.equal(result.request.status, 'resolved'); assert.equal(p.store.getRun(g.id)?.status, 'done')
  assert.deepEqual(f.projects.get('B')!.store.snapshot(), before)
})
test('taskless decision выбирает ветку, review decider не обходит decision guard', () => {
  const f = fixture(); const { p, g } = run(f, 'decision')
  const decider = p.store.listTasks().find(t => t.gateFor?.runId === g.id)!
  assert.throws(() => f.review.accept(f.context(), decider.id), errorCode('command.rejected'))
  const escalation = f.workflow.run.escalateDecision(p.workflow, decider.id, 'uncertain')
  const request = p.store.getRequest(escalation.requestId)!
  assert.equal(request.taskId, undefined)
  f.requests.resolve(f.context(), request.id, { action: 'answer', optionId: 'yes', text: 'Ready' })
  assert.equal(p.store.getRun(g.id)?.status, 'done')
  assert.equal(p.store.getRun(g.id)?.stageHistory?.find(s => s.nodeId === 'middle')?.decision?.by, 'human')
})
test('review run gate принимает исход через run router, не закрывая живой PTY преждевременно', () => {
  const f = fixture(); const { p, g } = run(f, 'gate')
  const gate = p.store.listTasks().find(t => t.gateFor?.runId === g.id)!
  const beforeSpawns = f.processes.length
  const result = f.review.accept(f.context(), gate.id, 'Ready')
  assert.equal(result?.status, 'in_progress'); assert.equal(p.store.getRun(g.id)?.stage?.nodeId, 'human')
  assert.equal(f.processes.length, beforeSpawns)
})
test('cancelled request сохраняет store и не создаёт вложений', () => {
  const f = fixture(); const { p, g } = run(f, 'human'); const request = p.store.pendingRequests(g.id)[0]
  p.store.moveGlobalTask(g.id, 'done'); const before = structuredClone(p.store.snapshot())
  assert.throws(() => f.requests.resolve(f.context(), request.id, { action: 'reject', text: 'Improve' }, feedbackFile), errorCode('command.rejected'))
  assert.deepEqual(p.store.snapshot(), before)
})
test('отказ review decision после записи вложений убирает orphan файлы без feedback', () => {
  const f = fixture(); const { p, g } = run(f, 'decision')
  const decider = p.store.listTasks().find(t => t.gateFor?.runId === g.id)!
  const cwd = p.store.getRun(g.id)!.git!.worktree!
  const before = structuredClone(p.store.snapshot())
  assert.throws(() => f.review.reject(f.context(), decider.id, 'Wrong action', feedbackFile), errorCode('command.rejected'))
  assert.deepEqual(p.store.snapshot(), before)
  assert.ok(!readdirSync(join(cwd, '.orca-attachments'), { recursive: true }).some(path => String(path).includes('ret_')))
})
test('mixed liveness не закрывает живой dispatch при ответе на вопрос другого запуска', () => {
  const f = fixture(); const { p, t, launch } = task(f)
  const dead = p.store.startDispatch(t.id, 'unregistered-dead-pty')
  const q = p.store.ask({ taskId: t.id, dispatchId: dead.id, question: 'Choose?' }, { forceHuman: true })
  f.requests.answer(f.context(), q.id, 'Ready')
  assert.equal(p.store.getDispatch(launch.dispatchId)?.endedAt, undefined)
  assert.equal(p.store.getDispatch(dead.id)?.endedAt, undefined)
  assert.equal(f.sessions.isAlive(launch.ptyId), true); assert.equal(p.store.getTask(t.id)?.status, 'in_progress')
})
