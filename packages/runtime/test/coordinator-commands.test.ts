import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CoordinatorCommands, ProjectCommandContext } from '@orca-board/contracts'
import { CommandError } from '../src/index.ts'
import * as runtime from '../src/index.ts'
import { coordinatorFixture, feedbackFile } from './coordinator-command-test-host.ts'

const fixtures: ReturnType<typeof coordinatorFixture>[] = []
afterEach(() => { for (const f of fixtures.splice(0)) f.close() })
const fixture = () => { const f = coordinatorFixture(); fixtures.push(f); return f }
const code = (expected: string) => (e: unknown) => e instanceof CommandError && e.code === expected
const invoke = (commands: CoordinatorCommands, method: keyof CoordinatorCommands, context: ProjectCommandContext, ...args: unknown[]) =>
  (commands[method] as (context: ProjectCommandContext, ...args: unknown[]) => unknown)(context, ...args)

test('новый запуск явно выбирает проект, пишет snapshot и Git worktree, запускает граф и возвращает DTO', () => {
  const f = fixture(); const a = f.projects.get('A')!; const b = f.projects.get('B')!; const before = structuredClone(b.store.snapshot())
  const started = f.commands.start(f.context(), { objective: '  Build A  ', cols: 101, rows: 39, typeId: 'default', images: feedbackFile })
  const run = a.store.getRun(started.runId)!
  assert.equal(run.objective, 'Build A'); assert.equal(run.coordinatorPtyId, started.ptyId)
  assert.equal(run.workflowScope, 'run'); assert.equal(run.stage?.nodeId, 'work'); assert.equal(run.taskType?.id, 'default')
  assert.equal(f.git(run.git!.worktree!, 'branch', '--show-current'), `feature/${run.id}-build-a`)
  assert.equal(f.processes[0].options.env.ORCA_PROJECT, 'A'); assert.equal(f.processes[0].options.env.ORCA_RUN_ID, run.id)
  assert.equal(f.processes[0].options.cols, 101); assert.equal(f.processes[0].options.rows, 39)
  assert.deepEqual(b.store.snapshot(), before)
  assert.equal(readFileSync(join(run.git!.worktree!, '.orca-attachments', run.id, 'file-1-notes.txt'), 'utf8'), 'AB')
})

for (const method of ['start', 'startCoordinator', 'accept', 'returnToWork'] as const) {
  test(`${method}: policy прежде payload/project/PTY`, () => {
    const f = fixture(); f.deny()
    assert.throws(() => invoke(f.commands, method, f.context(), null, null), code('command.forbidden'))
    assert.deepEqual(f.counts(), { lookups: 0, spawns: 0 }); assert.equal(f.policy.length, 1)
    assert.equal(f.policy[0].command, method === 'start' ? 'coordinator.start' : `globalTasks.${method}`)
    assert.equal(existsSync(join(f.dir, '.orca-worktrees')), false)
  })
}
test('невалидный context не вызывает policy; неизвестный проект не выбирает соседний', () => {
  const f = fixture()
  assert.throws(() => f.commands.start({ ...f.context(), clientId: '' }, { objective: 'X' }), code('command.invalidContext'))
  assert.equal(f.policy.length, 0)
  assert.throws(() => f.commands.start(f.context('missing'), { objective: 'X' }), code('command.projectNotFound'))
  assert.equal(f.projects.get('A')!.store.listRuns().length, 0); assert.equal(f.processes.length, 0)
})
test('невалидный payload отвергается до lookup, включая sparse files и присвоение полей store', () => {
  const f = fixture()
  for (const [method, args] of [
    ['start', [{ objective: 4 }]], ['start', [{ objective: 'X', typeId: '' }]], ['start', [{ objective: 'X', runId: 'other' }]],
    ['start', [{ objective: 'X', cols: 0 }]], ['start', [{ objective: 'X', rows: 1.5 }]], ['start', [{ objective: 'X', cols: Infinity }]],
    ['start', [{ objective: 'X', images: new Array(1) }]], ['start', [{ objective: 'X', images: [{ ...feedbackFile[0], data: [] }] }]],
    ['startCoordinator', ['', {}]], ['startCoordinator', ['run', { rows: -1 }]], ['accept', ['run', 4]],
    ['returnToWork', ['run', { text: 4 }]], ['returnToWork', ['run', { text: 'X', images: 'bad' }]]
  ] as const) assert.throws(() => invoke(f.commands, method, f.context(), ...args), code('command.invalidInput'))
  assert.deepEqual(f.counts(), { lookups: 0, spawns: 0 })
})
test('чужой run не запускается, не принимается и не возвращается в выбранном проекте', () => {
  const f = fixture(); const run = f.projects.get('A')!.store.createGlobalTask({ title: 'A' })
  const before = structuredClone(f.projects.get('B')!.store.snapshot())
  for (const [method, args] of [['startCoordinator', [{}]], ['accept', []], ['returnToWork', [{ text: 'X', images: feedbackFile }]]] as const)
    assert.throws(() => invoke(f.commands, method, f.context('B'), run.id, ...args), code('command.globalTaskNotFound'))
  assert.deepEqual(f.projects.get('B')!.store.snapshot(), before); assert.equal(f.processes.length, 0)
  assert.equal(existsSync(join(f.dir, '.orca-worktrees')), false)
})
test('policy не может изменить captured project и автора операции', () => {
  const f = fixture(); f.host.authorize = context => { context.projectId = 'B'; context.actor.kind = 'system'; return true }
  const ctx = f.context(); f.commands.start(ctx, { objective: 'A' })
  assert.equal(ctx.projectId, 'A'); assert.equal(ctx.actor.kind, 'operator')
  assert.equal(f.projects.get('B')!.store.listRuns().length, 0); assert.equal(f.processes[0].options.env.ORCA_PROJECT, 'A')
})
test('пустая цель допускает только attachment-only запуск; host причина сохраняется', () => {
  const f = fixture()
  assert.throws(() => f.commands.start(f.context(), { objective: ' ' }), e => e instanceof CommandError && e.code === 'command.rejected' && String(e.cause).includes('coordinator.noObjective'))
  assert.equal(f.processes.length, 0); assert.equal(f.projects.get('A')!.store.listRuns().length, 0)
  const result = f.commands.start(f.context(), { objective: '', images: feedbackFile })
  assert.ok(f.projects.get('A')!.store.getRun(result.runId)!.objective.length > 0)
})
test('живой координатор отвергает повтор; после exit возобновляется тот же run и граф', () => {
  const f = fixture(); const first = f.commands.start(f.context(), { objective: 'X' }); const store = f.projects.get('A')!.store
  const before = structuredClone(store.snapshot())
  assert.throws(() => f.commands.startCoordinator(f.context(), first.runId), code('command.rejected'))
  assert.deepEqual(store.snapshot(), before); assert.equal(f.processes.length, 1)
  f.sessions.killPty(first.ptyId)
  const second = f.commands.startCoordinator(f.context(), first.runId, { cols: 90, rows: 20 })
  assert.equal(second.runId, first.runId); assert.notEqual(second.ptyId, first.ptyId)
  assert.equal(store.listRuns().length, 1); assert.equal(store.getRun(first.runId)?.stage?.nodeId, 'work')
})
for (const [actor, by] of [['operator', 'human'], ['agent', 'cli'], ['system', 'app']] as const) {
  test(`приёмка ${actor} завершает граф и не даёт заново запустить завершённый run`, () => {
    const f = fixture(); const project = f.projects.get('A')!; const started = f.commands.start(f.context(), { objective: 'X' })
    f.finishWork(started.runId)
    assert.equal(project.store.pendingRequests(started.runId).length, 1)
    const accepted = f.commands.accept(f.context('A', actor), started.runId, 'Reviewed')
    assert.equal(accepted.status, 'done'); assert.equal(project.store.getRun(started.runId)?.stage?.nodeId, 'end')
    assert.equal(accepted.statusHistory?.at(-1)?.by, 'workflow')
    f.sessions.killPty(started.ptyId); const before = structuredClone(project.store.snapshot())
    assert.throws(() => f.commands.startCoordinator(f.context(), started.runId), e => e instanceof CommandError && String(e.cause).includes('workflow.runFinished'))
    assert.deepEqual(project.store.snapshot(), before)
  })
  test(`legacy приёмка сохраняет автора ${by}`, () => {
    const f = fixture(); const store = f.projects.get('A')!.store
    const run = store.createGlobalTask({ title: 'Legacy', status: 'review' })
    const accepted = f.commands.accept(f.context('A', actor), run.id)
    assert.equal(accepted.status, 'done'); assert.equal(accepted.statusHistory?.at(-1)?.by, by)
  })
}
test('неоднозначный fork approval не меняет lanes и не оставляет файлы возврата', () => {
  const f = fixture(); const p = f.projects.get('A')!; const old = p.newRunEnvironment()
  p.newRunEnvironment = () => ({ ...old, type: { ...old.type!, workflow: { version: 2,
    nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }, { id: 'fork', type: 'fork', branches: [{ id: 'left', label: 'L' }, { id: 'right', label: 'R' }], x: 0, y: 0 },
      { id: 'left', type: 'human', x: 0, y: 0 }, { id: 'right', type: 'human', x: 0, y: 0 },
      { id: 'join', type: 'join', forkId: 'fork', x: 0, y: 0 }, { id: 'end', type: 'end', x: 0, y: 0 }],
    edges: [{ id: 'a', from: 'start', outcome: 'next', to: 'fork' }, { id: 'b', from: 'fork', outcome: 'left', to: 'left' },
      { id: 'c', from: 'fork', outcome: 'right', to: 'right' }, { id: 'd', from: 'left', outcome: 'accept', to: 'join' },
      { id: 'e', from: 'right', outcome: 'accept', to: 'join' }, { id: 'f', from: 'join', outcome: 'next', to: 'end' }] } } })
  const started = f.commands.start(f.context(), { objective: 'Fork' }); const before = structuredClone(p.store.snapshot())
  assert.equal(p.store.pendingRequests(started.runId).length, 2)
  for (const operation of [() => f.commands.accept(f.context(), started.runId),
    () => f.commands.returnToWork(f.context(), started.runId, { text: 'Choose path', images: feedbackFile })])
    assert.throws(operation, e => e instanceof CommandError && String(e.cause).includes('global.approvalAmbiguous'))
  assert.deepEqual(p.store.snapshot(), before)
  const returns = join(p.store.getRun(started.runId)!.git!.worktree!, '.orca-attachments', 'returns')
  assert.equal(existsSync(returns) ? readdirSync(returns).length : 0, 0)
})
test('run scope возврат сохраняет feedback и файлы, не убивая живой координатор', () => {
  const f = fixture(); const p = f.projects.get('A')!; const started = f.commands.start(f.context(), { objective: 'X' })
  f.finishWork(started.runId)
  const returned = f.commands.returnToWork(f.context(), started.runId, { text: 'Fix A', images: feedbackFile, cols: 90, rows: 20 })
  assert.equal(returned.ptyId, started.ptyId); assert.equal(f.processes.length, 1)
  const run = p.store.getRun(started.runId)!
  assert.equal(run.stage?.nodeId, 'work'); assert.equal(run.stageInput?.feedback, 'Fix A')
  assert.deepEqual(Array.from(readFileSync(run.stageInput!.images![0])), [65, 66]); assert.equal(f.sessions.isAlive(started.ptyId), true)
})
test('failed restart после human решения оставляет feedback и referenced images для повторного запуска', () => {
  const f = fixture(); const p = f.projects.get('A')!; const started = f.commands.start(f.context(), { objective: 'X' })
  f.finishWork(started.runId); f.sessions.killPty(started.ptyId); f.fail()
  assert.throws(() => f.commands.returnToWork(f.context(), started.runId, { text: 'Retry me', images: feedbackFile }), e => e instanceof CommandError && String(e.cause).includes('workflow.coordinatorNotRunning'))
  const run = p.store.getRun(started.runId)!
  assert.equal(run.stage?.nodeId, 'work'); assert.equal(run.stageInput?.feedback, 'Retry me')
  assert.ok(existsSync(run.stageInput!.images![0])); assert.equal(p.store.pendingRequests(started.runId).length, 0)
})
test('возврат вне approval не оставляет orphan images и не меняет store', () => {
  const f = fixture(); const p = f.projects.get('A')!; const started = f.commands.start(f.context(), { objective: 'X' })
  const before = structuredClone(p.store.snapshot())
  assert.throws(() => f.commands.returnToWork(f.context(), started.runId, { text: 'No approval', images: feedbackFile }), code('command.rejected'))
  assert.deepEqual(p.store.snapshot(), before)
  const returns = join(p.store.getRun(started.runId)!.git!.worktree!, '.orca-attachments', 'returns')
  assert.equal(existsSync(returns) ? readdirSync(returns).length : 0, 0)
})
test('legacy task scope возврат перезапускает PTY и сохраняет feedback в старом прогоне', () => {
  const f = fixture(); const p = f.projects.get('A')!; const run = p.store.createGlobalTask({ title: 'Legacy' })
  const first = f.commands.startCoordinator(f.context(), run.id)
  p.store.moveGlobalTask(run.id, 'review')
  const result = f.commands.returnToWork(f.context(), run.id, { text: 'Fix legacy', cols: 88, rows: 22, images: feedbackFile })
  assert.equal(result.runId, run.id); assert.notEqual(result.ptyId, first.ptyId); assert.equal(f.sessions.isAlive(first.ptyId), false)
  assert.equal(p.store.getRun(run.id)?.workflowScope, undefined)
  assert.equal(p.store.getRun(run.id)?.returns?.at(-1)?.text, 'Fix legacy')
  assert.ok(existsSync(p.store.getRun(run.id)!.returns!.at(-1)!.images![0]))
  assert.equal(f.processes.at(-1)!.options.cols, 88)
})
test('trusted socket orchestration выбирает explicit project и возвращает прежний run/pty', () => {
  const f = fixture(); const operations = runtime.createCoordinatorOperations(f.host)
  const result = operations.start(f.projects.get('B')!, 'Agent B')
  assert.equal(f.projects.get('B')!.store.getRun(result.runId)?.objective, 'Agent B')
  assert.equal(f.projects.get('A')!.store.listRuns().length, 0); assert.equal(f.policy.length, 0)
  assert.equal(f.processes[0].options.env.ORCA_PROJECT, 'B')
})
