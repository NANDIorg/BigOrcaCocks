import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { withStatusSource, type Workflow } from '@orca-board/core'
import type { WorkerCommands, ProjectCommandContext } from '@orca-board/contracts'
import { CommandError } from '../src/index.ts'
import { workerFixture } from './worker-command-test-host.ts'

const fixtures: ReturnType<typeof workerFixture>[] = []
afterEach(() => { for (const f of fixtures.splice(0)) f.close() })
const fixture = () => { const f = workerFixture(); fixtures.push(f); return f }
const code = (expected: string) => (e: unknown) => e instanceof CommandError && e.code === expected
const invoke = (commands: WorkerCommands, method: keyof WorkerCommands, context: ProjectCommandContext, ...args: unknown[]) =>
  (commands[method] as (context: ProjectCommandContext, ...args: unknown[]) => unknown)(context, ...args)
function graph(kind: 'work' | 'ask' = 'work', roleId = 'reviewer'): Workflow {
  return { version: 1, nodes: [{ id: 's', type: 'start', x: 0, y: 0 }, { id: 'w', type: kind, roleId, instructions: 'Ask', x: 0, y: 0 },
    { id: 'h', type: 'human', x: 0, y: 0 }], edges: [{ id: 'a', from: 's', outcome: 'next', to: 'w' }, { id: 'b', from: 'w', outcome: 'next', to: 'h' }] }
}
function task(f: ReturnType<typeof fixture>, projectId = 'A') { return f.projects.get(projectId)!.store.createTask({ title: 'Work', roleId: 'developer' }) }

test('start создаёт настоящий worktree/dispatch в явном проекте и возвращает прежний launch DTO', () => {
  const f = fixture(); const t = task(f); const p = f.projects.get('A')!; const before = structuredClone(f.projects.get('B')!.store.snapshot())
  const result = f.commands.start(f.context(), t.id, { cols: 91, rows: 29 })
  assert.equal(f.git(result.worktree, 'branch', '--show-current'), `orca/${t.id}`)
  assert.equal(result.branch, `orca/${t.id}`); assert.equal(p.store.getTask(t.id)?.status, 'in_progress')
  assert.equal(p.store.getDispatch(result.dispatchId)?.ptyId, result.ptyId)
  assert.equal(f.processes[0].options.env.ORCA_PROJECT, 'A'); assert.equal(f.processes[0].options.env.ORCA_TASK_ID, t.id)
  assert.equal(f.processes[0].options.cols, 91); assert.equal(f.processes[0].options.rows, 29)
  assert.deepEqual(f.projects.get('B')!.store.snapshot(), before)
  result.branch = 'caller-mutated'; assert.equal(p.store.getTask(t.id)?.branch, `orca/${t.id}`)
})
for (const method of ['start', 'stop'] as const) test(`${method}: policy прежде payload/lookup/Git/kill`, () => {
  const f = fixture(); f.deny()
  assert.throws(() => invoke(f.commands, method, f.context(), null, null), code('command.forbidden'))
  assert.deepEqual(f.counts(), { lookups: 0, spawns: 0 }); assert.equal(f.policy[0].command, `workers.${method}`)
  assert.equal(existsSync(join(f.dir, '.orca-worktrees')), false)
})
test('context и payload отвергаются до lookup, неизвестный проект не выбирает соседний', () => {
  const f = fixture()
  assert.throws(() => f.commands.start({ ...f.context(), actor: { kind: 'operator', id: '' } }, 'task'), code('command.invalidContext'))
  assert.equal(f.policy.length, 0)
  for (const input of [null, { cols: 0 }, { rows: 1.5 }, { cols: Infinity }, { rows: Number.MAX_SAFE_INTEGER + 1 },
    { roleId: '' }, { roleId: 4 }, { branch: 'master' }, { images: [] }]) {
    assert.throws(() => invoke(f.commands, 'start', f.context(), 'task', input), code('command.invalidInput'))
  }
  assert.throws(() => f.commands.stop(f.context(), ''), code('command.invalidInput'))
  assert.deepEqual(f.counts(), { lookups: 0, spawns: 0 })
  assert.throws(() => f.commands.start(f.context('missing'), 'task'), code('command.projectNotFound'))
  assert.equal(f.processes.length, 0)
})
test('чужой taskId не запускает и не останавливает живой процесс другого проекта', () => {
  const f = fixture(); const t = task(f); const started = f.commands.start(f.context(), t.id)
  const a = structuredClone(f.projects.get('A')!.store.snapshot()); const b = structuredClone(f.projects.get('B')!.store.snapshot())
  for (const method of ['start', 'stop'] as const) assert.throws(() => invoke(f.commands, method, f.context('B'), t.id), code('command.taskNotFound'))
  assert.deepEqual(f.projects.get('A')!.store.snapshot(), a); assert.deepEqual(f.projects.get('B')!.store.snapshot(), b)
  assert.equal(f.sessions.isAlive(started.ptyId), true); assert.equal(f.processes.length, 1)
})
test('policy не может изменить captured project/actor; raw DTO не присваивает поля задачи', () => {
  const f = fixture(); const t = task(f); const ctx = f.context()
  f.host.authorize = context => { context.projectId = 'B'; context.actor.kind = 'system'; return true }
  f.commands.start(ctx, t.id)
  assert.equal(ctx.projectId, 'A'); assert.equal(ctx.actor.kind, 'operator'); assert.equal(f.processes[0].options.env.ORCA_PROJECT, 'A')
})
for (const [kind, by] of [['operator', 'human'], ['agent', 'cli'], ['system', 'app']] as const) test(`stop сохраняет автора ${by}, закрывает dispatch до kill и возвращает ready`, () => {
  const f = fixture(); const t = task(f); const p = f.projects.get('A')!; const result = f.commands.start(f.context(), t.id)
  assert.deepEqual(f.commands.stop(f.context('A', kind), t.id), { stopped: [result.dispatchId] })
  assert.equal(f.sessions.isAlive(result.ptyId), false); assert.equal(p.store.getDispatch(result.dispatchId)?.outcome, 'unknown')
  assert.equal(p.store.getTask(t.id)?.status, 'ready'); assert.equal(p.store.getTask(t.id)?.statusHistory?.at(-1)?.by, by)
  assert.equal(p.store.pendingRequests().length, 0)
  assert.deepEqual(f.commands.stop(f.context(), t.id), { stopped: [] })
})
test('повторный start in_progress не трогает живой dispatch, после stop запускается тот же worktree', () => {
  const f = fixture(); const t = task(f); const p = f.projects.get('A')!; const first = f.commands.start(f.context(), t.id)
  const before = structuredClone(p.store.snapshot())
  assert.throws(() => f.commands.start(f.context(), t.id), code('command.rejected')); assert.deepEqual(p.store.snapshot(), before)
  assert.equal(f.sessions.isAlive(first.ptyId), true)
  f.commands.stop(f.context(), t.id); const next = f.commands.start(f.context(), t.id)
  assert.equal(next.worktree, first.worktree); assert.notEqual(next.dispatchId, first.dispatchId)
})
for (const failure of ['missing', 'disabled', 'notInstalled', 'extraArgs'] as const) test(`${failure}: роль проверяется прежде перехода, отмены request и старого kill`, () => {
  const f = fixture(); const t = task(f); const p = f.projects.get('A')!; const config = f.configs.get('A')!
  config.workflow = graph('work', 'developer')
  const first = f.commands.start(f.context(), t.id); p.store.closeDispatches(t.id); p.store.moveTask(t.id, 'ready')
  p.store.advanceStage(t.id, 'next'); p.store.requestApproval(t.id, { nodeId: 'h', title: 'Review' })
  if (failure === 'missing') config.environment.roles = config.environment.roles.filter(r => r.id !== 'developer')
  if (failure === 'extraArgs') config.environment.roles = config.environment.roles.map(r => r.id === 'developer' ? { ...r, extraArgs: 'positional' } : r)
  if (failure === 'disabled' || failure === 'notInstalled') config.agents = config.agents.map(a => a.id === 'claude' ? { ...a, enabled: failure !== 'disabled', installed: failure !== 'notInstalled' } : a)
  const before = structuredClone(p.store.snapshot())
  assert.throws(() => f.commands.start(f.context(), t.id), code('command.rejected'))
  assert.deepEqual(p.store.snapshot(), before); assert.equal(f.sessions.isAlive(first.ptyId), true); assert.equal(f.processes.length, 1)
})
for (const kind of ['work', 'ask'] as const) test(`${kind}: stage role используется в dispatch; ask не меняет постоянную роль задачи`, () => {
  const f = fixture(); const t = task(f); const p = f.projects.get('A')!; f.configs.get('A')!.workflow = graph(kind)
  const result = f.commands.start(f.context(), t.id)
  assert.equal(p.store.getDispatch(result.dispatchId)?.roleId, 'reviewer')
  assert.equal(p.store.getTask(t.id)?.roleId, kind === 'work' ? 'reviewer' : 'developer')
  assert.equal(p.store.getTask(t.id)?.stage?.nodeId, 'w')
})
test('explicit role override проверяется раньше графа и не переносится с ask на задачу', () => {
  const f = fixture(); const t = task(f); const p = f.projects.get('A')!; const config = f.configs.get('A')!; config.workflow = graph('ask')
  config.agents = config.agents.map(a => a.id === 'codex' ? { ...a, enabled: false } : a)
  const before = structuredClone(p.store.snapshot())
  assert.throws(() => f.commands.start(f.context(), t.id), code('command.rejected')); assert.deepEqual(p.store.snapshot(), before)
  const result = f.commands.start(f.context(), t.id, { roleId: 'developer' })
  assert.equal(p.store.getDispatch(result.dispatchId)?.roleId, 'developer'); assert.equal(p.store.getTask(t.id)?.roleId, 'developer')
})
for (const branch of ['ok', 'error', 'human'] as const) test(`Git ${branch}: фактическая ветка графа, ровно один запуск либо запрос человеку`, () => {
  const f = fixture(); const t = task(f); const p = f.projects.get('A')!; const config = f.configs.get('A')!
  const wf = graph('work', 'developer')
  wf.nodes.push({ id: 'g', type: 'git', operation: 'create_branch', branch: 'prepared', ...(branch !== 'ok' ? { base: 'missing-base' } : {}), x: 0, y: 0 })
  wf.nodes.push(branch === 'human' ? { id: 'repair', type: 'human', x: 0, y: 0 } : { id: 'repair', type: 'work', roleId: 'reviewer', x: 0, y: 0 })
  wf.edges = [{ id: 'a', from: 's', outcome: 'next', to: 'g' }, { id: 'b', from: 'g', outcome: 'ok', to: 'w' }, { id: 'c', from: 'g', outcome: 'error', to: 'repair' }]
  config.workflow = wf; config.agents = config.agents.map(a => ({ ...a, enabled: branch === 'ok' ? a.id === 'claude' : a.id === 'codex' }))
  if (branch === 'human') {
    assert.throws(() => f.commands.start(f.context(), t.id), code('command.rejected'))
    assert.equal(p.store.pendingRequests().length, 1); assert.equal(f.processes.length, 0)
  } else {
    const result = f.commands.start(f.context(), t.id)
    assert.equal(p.store.getDispatch(result.dispatchId)?.roleId, branch === 'ok' ? 'developer' : 'reviewer')
    assert.equal(f.processes.length, 1); assert.equal(existsSync(result.worktree), true)
  }
})
test('restart закрывает оставшийся PTY завершённого dispatch перед новым запуском', () => {
  const f = fixture(); const t = task(f); const p = f.projects.get('A')!; const first = f.commands.start(f.context(), t.id)
  p.store.closeDispatches(t.id); p.store.moveTask(t.id, 'ready')
  const next = f.commands.start(f.context(), t.id)
  assert.equal(f.sessions.isAlive(first.ptyId), false); assert.equal(f.sessions.isAlive(next.ptyId), true)
  assert.equal(p.store.pendingRequests().length, 0)
})
test('done cleanup убирает живой PTY закрытого dispatch, соседняя задача остаётся работать', () => {
  const f = fixture(); const a = task(f); const b = task(f); const p = f.projects.get('A')!
  const first = f.commands.start(f.context(), a.id); const second = f.commands.start(f.context(), b.id)
  p.store.closeDispatches(a.id); p.store.moveTask(a.id, 'done'); f.lifecycle.closeDoneWorkers(p.store)
  assert.equal(f.sessions.isAlive(first.ptyId), false); assert.equal(f.sessions.isAlive(second.ptyId), true)
  assert.equal(p.store.getDispatch(second.dispatchId)?.endedAt, undefined)
})
test('mixed liveness не закрывает живого воркера; оставшиеся dead dispatch закрываются', () => {
  const f = fixture(); const t = task(f); const p = f.projects.get('A')!; const first = f.commands.start(f.context(), t.id)
  const dead = p.store.startDispatch(t.id, 'missing-pty')
  f.lifecycle.syncWorkerLiveness(p.store, t.id)
  assert.equal(p.store.getDispatch(dead.id)?.endedAt, undefined); assert.equal(p.store.getDispatch(first.dispatchId)?.endedAt, undefined)
  f.sessions.killPty(first.ptyId); f.lifecycle.syncWorkerLiveness(p.store, t.id)
  assert.ok(p.store.getDispatch(dead.id)?.endedAt)
})
test('all-dead sync закрывает dispatch без escalation и не сдвигает задачу сам', () => {
  const f = fixture(); const t = task(f); const p = f.projects.get('A')!; const d = p.store.startDispatch(t.id, 'missing-pty')
  f.lifecycle.syncWorkerLiveness(p.store, t.id)
  assert.equal(p.store.getDispatch(d.id)?.outcome, 'unknown'); assert.ok(p.store.getDispatch(d.id)?.endedAt)
  assert.equal(p.store.getTask(t.id)?.status, 'in_progress'); assert.equal(p.store.pendingRequests().length, 0)
})
test('stop убирает PTY закрытого dispatch, сохраняя колонку review', () => {
  const f = fixture(); const t = task(f); const p = f.projects.get('A')!; const first = f.commands.start(f.context(), t.id)
  p.store.closeDispatches(t.id); p.store.moveTask(t.id, 'review')
  assert.deepEqual(f.commands.stop(f.context(), t.id), { stopped: [] })
  assert.equal(f.sessions.isAlive(first.ptyId), false); assert.equal(p.store.getTask(t.id)?.status, 'review')
})
test('trusted socket start сохраняет global/missing причины и источник cli; stop неизвестного id — no-op', () => {
  const f = fixture(); const p = f.projects.get('A')!; const run = p.store.createGlobalTask({ title: 'Goal' })
  assert.throws(() => f.operations.start(p, run.id), /глобальная задача/)
  assert.throws(() => f.operations.start(p, 'missing'), /task not found/)
  assert.deepEqual(f.operations.stop(p, 'missing'), { stopped: [] })
  const t = task(f); const result = withStatusSource('cli', () => f.operations.start(p, t.id))
  assert.equal(p.store.getTask(t.id)?.statusHistory?.at(-1)?.by, 'cli')
  withStatusSource('cli', () => f.operations.stop(p, t.id)); assert.equal(f.sessions.isAlive(result.ptyId), false)
})
