import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, until, services } from './conversation-fixture.ts'
const structuredLaunch = services().structuredLaunch

for (const agent of ['claude', 'codex', 'gemini', 'cursor', 'opencode', 'copilot', 'goose'] as const) {
  test(`${agent}: флаги настроек доходят до CLI без shell, перед служебными флагами`, async (t) => {
    const extraArgs = ['--config', 'path with spaces & %PATH%', '--user-switch']
    const { engine, wire } = fixture(t, agent === 'claude' ? 'claude' : agent === 'codex' ? 'codex' : 'acp', agent, { extraArgs })
    await engine.send('permission')
    await until(() => engine.snapshot().status === 'waiting')
    const args = (wire().find((frame) => frame.fixtureSpawn)?.fixtureSpawn as { argv: string[] }).argv
    const offset = agent === 'goose' || agent === 'codex' ? 1 : 0
    assert.deepEqual(args.slice(offset, offset + extraArgs.length), extraArgs)
    if (agent === 'goose' || agent === 'codex') assert.equal(args[0], agent === 'codex' ? 'app-server' : 'acp')
    else assert.equal(args[extraArgs.length], agent === 'claude' ? '--print' : agent === 'gemini' || agent === 'copilot' ? '--acp' : 'acp')
  })
}

test('Codex: variadic-флаги не поглощают подкоманду app-server', async (t) => {
  const { engine, wire } = fixture(t, 'codex', 'codex', { extraArgs: ['--image', 'a.png'] })
  await engine.send('permission')
  await until(() => engine.snapshot().status === 'waiting')
  const args = (wire().find((frame) => frame.fixtureSpawn)?.fixtureSpawn as { argv: string[] }).argv
  assert.deepEqual(args, ['app-server', '--image', 'a.png'])
})

test('Claude fragmented protocol emits one human and one streamed agent reply without duplicating complete blocks', async (t) => {
  const { engine } = fixture(t, 'fragmented')
  await engine.send('Hello')
  await until(() => engine.snapshot().status === 'done')
  assert.deepEqual(engine.snapshot().messages.map((m) => [m.role, m.text]), [['human', 'Hello'], ['agent', 'Привет 🌊']])
})

test('Claude question maps option ids to original labels and preserves tool input on response', async (t) => {
  const { engine } = fixture(t)
  await engine.send('question')
  await until(() => engine.snapshot().interactions.length > 0)
  const question = engine.snapshot().interactions[0]
  assert.equal(question.kind, 'question')
  await engine.respond(question.id, { kind: 'answers', answers: [
    { questionId: question.questions![0].id, optionIds: [question.questions![0].options[1].id] },
    { questionId: question.questions![1].id, optionIds: question.questions![1].options.map((option) => option.id) }
  ] })
  await until(() => engine.snapshot().status === 'done')
  const payload = JSON.parse(engine.snapshot().messages.find((m) => m.role === 'agent')!.text) as { behavior: string; updatedInput: { marker: string; answers: Record<string, string> } }
  assert.equal(payload.behavior, 'allow')
  assert.equal(payload.updatedInput.marker, 'preserve')
  assert.deepEqual(payload.updatedInput.answers, { 'Which project?': 'Two', 'Which areas?': 'UI, API' })
  await assert.rejects(engine.respond(question.id, { kind: 'cancel' }), /запрос|request/i)
})

test('Claude permission refusal resolves blocked tool and rejects forged option without answering it', async (t) => {
  const { engine, wire } = fixture(t)
  await engine.send('permission')
  await until(() => engine.snapshot().interactions.length > 0)
  const interaction = engine.snapshot().interactions[0]
  await assert.rejects(engine.respond(interaction.id, { kind: 'option', optionId: 'forged' }), /вариант|option/i)
  assert.equal(wire().filter((v) => v.type === 'control_response').length, 0)
  await engine.respond(interaction.id, { kind: 'option', optionId: 'deny' })
  await until(() => engine.snapshot().status === 'done')
  assert.equal(engine.snapshot().messages.flatMap((m) => m.toolCalls ?? [])[0].status, 'error')
})

test('Claude interrupt clears waiting requests, marks unfinished tool cancelled and retains partial history', async (t) => {
  const { engine } = fixture(t)
  await engine.send('long')
  await until(() => engine.snapshot().status === 'waiting')
  const requestId = engine.snapshot().interactions[0].id
  await engine.interrupt()
  await until(() => engine.snapshot().status === 'interrupted')
  assert.equal(engine.snapshot().interactions.length, 0)
  assert.equal(engine.snapshot().messages.flatMap((m) => m.toolCalls ?? [])[0].status, 'cancelled')
  await assert.rejects(engine.respond(requestId, { kind: 'option', optionId: 'allow' }), /запрос|request/i)
})

test('ACP keeps actual provider option ids, completes the prompt and does not splice tool output into streamed prose', async (t) => {
  const { engine } = fixture(t, 'acp', 'gemini')
  await engine.send('permission')
  await until(() => engine.snapshot().interactions.length > 0)
  const permission = engine.snapshot().interactions[0]
  await engine.respond(permission.id, { kind: 'option', optionId: 'once-provider-specific' })
  await until(() => engine.snapshot().status === 'done')
  assert.equal(engine.snapshot().messages[0].text, 'permission')
  const agent = engine.snapshot().messages.filter((m) => m.role === 'agent').map((m) => m.text).join('')
  assert.ok(agent.includes('"optionId":"once-provider-specific"'))
})

test('ACP cancellation answers all pending permissions with cancelled outcome before accepting final updates', async (t) => {
  const { engine, wire } = fixture(t, 'acp', 'opencode')
  await engine.send('permission')
  await until(() => engine.snapshot().status === 'waiting')
  await engine.interrupt()
  await until(() => engine.snapshot().status === 'interrupted')
  const reply = wire().find((v) => v.id === 'permission-acp' && v.result)
  assert.deepEqual(reply?.result, { outcome: { outcome: 'cancelled' } })
  assert.equal(engine.snapshot().messages.flatMap((m) => m.toolCalls ?? [])[0].status, 'cancelled')
})

test('Cursor ACP questions preserve question ids and selected option ids', async (t) => {
  const { engine } = fixture(t, 'acp', 'cursor')
  await engine.send('question')
  await until(() => engine.snapshot().interactions.length > 0)
  const question = engine.snapshot().interactions[0]
  const item = question.questions![0]
  assert.equal(item.id, 'project')
  await engine.respond(question.id, { kind: 'answers', answers: [{ questionId: 'project', optionIds: ['two'] }] })
  await until(() => engine.snapshot().status === 'done')
  assert.ok(engine.snapshot().messages.find((m) => m.role === 'agent')!.text.includes('"selectedOptionIds":["two"]'))
})

for (const mode of ['codex', 'codex-legacy']) {
  test(`Codex ${mode} native approval responses preserve default policies and execute the selected refusal`, async (t) => {
    const { engine, wire } = fixture(t, mode, 'codex')
    await engine.send('permission')
    await until(() => engine.snapshot().interactions.length > 0)
    const permission = engine.snapshot().interactions[0]
    if (mode === 'codex-legacy') assert.deepEqual(JSON.parse(permission.tool!.input).command, ['orca-board', 'projects', 'list'])
    else assert.ok(permission.tool?.input.includes('orca-board projects list'))
    await engine.respond(permission.id, { kind: 'option', optionId: 'decline' })
    await until(() => engine.snapshot().status === 'done')
    assert.equal(engine.snapshot().messages.find((m) => m.role === 'agent')?.text, mode === 'codex-legacy' ? 'Decision:denied' : 'Decision:decline')
    const start = wire().find((v) => v.method === 'thread/start')!
    const params = start.params as Record<string, unknown>
    assert.ok(params.approvalPolicy == null)
    assert.ok(params.sandbox == null)
  })
}

test('startup failure rejects sending, exposes actionable error and does not erase accepted history', async (t) => {
  const { engine } = fixture(t, 'startup-failure')
  await assert.rejects(engine.send('hello'), /Fixture startup refused|заверш|запуск/i)
  await until(() => engine.snapshot().status === 'error')
  assert.ok(engine.snapshot().error)
})

test('disposed engine never emits later updates and refuses late send or permission response', async (t) => {
  const { engine, updates } = fixture(t)
  await engine.send('permission')
  await until(() => engine.snapshot().status === 'waiting')
  const id = engine.snapshot().interactions[0].id
  engine.dispose()
  const count = updates.length
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(updates.length, count)
  await assert.rejects(engine.send('late'), /закрыт|closed/i)
  await assert.rejects(engine.respond(id, { kind: 'option', optionId: 'allow' }), /закрыт|closed/i)
})

test('unsupported Amp and shell report unavailable capability without spawning a terminal or another provider', async (t) => {
  for (const agent of ['amp', 'shell'] as const) {
    const { engine } = fixture(t, 'claude', agent)
    await assert.rejects(engine.send('hello'), /поддерж|чат|transport/i)
    assert.equal(engine.snapshot().status, 'error')
    assert.equal(engine.snapshot().agent, agent)
  }
})

test('send resolves and emits accepted human text while a permission still waits', async (t) => {
  const { engine, updates } = fixture(t)
  const accepted = await Promise.race([engine.send('permission').then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 1000))])
  assert.equal(accepted, true)
  assert.ok(updates.some((update) => update.type === 'message' && update.message.role === 'human'))
  await until(() => engine.snapshot().status === 'waiting')
  await assert.rejects(engine.send('second'), /ответ|запрос|request/i)
})

test('question validation rejects unknown, duplicate and multiple single-choice answers without writing a response', async (t) => {
  const { engine, wire } = fixture(t)
  await engine.send('question')
  await until(() => engine.snapshot().status === 'waiting')
  const question = engine.snapshot().interactions[0]
  const attempts = [
    [{ questionId: 'unknown', optionIds: ['0'] }, { questionId: '1', optionIds: ['0'] }],
    [{ questionId: '0', optionIds: ['0', '1'] }, { questionId: '1', optionIds: ['0'] }],
    [{ questionId: '0', optionIds: ['0'] }, { questionId: '0', optionIds: ['0'] }],
    [{ questionId: '0', optionIds: ['forged'] }, { questionId: '1', optionIds: ['0'] }]
  ]
  for (const answers of attempts) await assert.rejects(engine.respond(question.id, { kind: 'answers', answers }))
  assert.equal(wire().filter((frame) => frame.type === 'control_response').length, 0)
  assert.equal(engine.snapshot().status, 'waiting')
})

test('interaction identifiers are scoped to their owning conversation', async (t) => {
  const left = fixture(t)
  const right = fixture(t)
  await left.engine.send('permission')
  await right.engine.send('permission')
  await until(() => left.engine.snapshot().status === 'waiting' && right.engine.snapshot().status === 'waiting')
  await assert.rejects(right.engine.respond(left.engine.snapshot().interactions[0].id, { kind: 'option', optionId: 'allow' }))
  assert.equal(right.wire().filter((frame) => frame.type === 'control_response').length, 0)
})

test('Codex cancellation ignores late messages and approvals from the preceding turn', async (t) => {
  const { engine } = fixture(t, 'codex-late', 'codex')
  await engine.send('permission')
  await until(() => engine.snapshot().status === 'waiting')
  await engine.interrupt()
  await until(() => engine.snapshot().status === 'interrupted')
  await engine.send('second')
  await until(() => engine.snapshot().status === 'waiting')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(engine.snapshot().interactions.length, 1)
  assert.ok(!engine.snapshot().messages.some((message) => message.text === 'STALE'))
})

test('unknown ACP blocking client request returns method-not-found and a capability error instead of hanging', async (t) => {
  const { engine, wire } = fixture(t, 'acp-unknown-client', 'gemini')
  await engine.send('unknown')
  await until(() => engine.snapshot().status === 'error')
  await until(() => wire().some((frame) => frame.id === 'unsupported-client' && frame.error !== undefined))
  assert.ok(wire().some((frame) => frame.id === 'unsupported-client' && (frame.error as { code: number }).code === -32601))
})

test('unsupported ACP reply reaches a busy CLI before the owned process is stopped', async (t) => {
  const { engine, wire } = fixture(t, 'acp-unknown-client-delayed', 'gemini')
  await engine.send('unknown')
  await until(() => engine.snapshot().status === 'error')
  await until(() => wire().some((frame) => frame.id === 'unsupported-client' && frame.error !== undefined))
  assert.ok(wire().some((frame) => frame.id === 'unsupported-client' && (frame.error as { code: number }).code === -32601))
  const pid = wire().find((frame) => typeof frame.fixtureHeldPid === 'number')?.fixtureHeldPid as number
  assert.ok(pid > 0)
  await until(() => { try { process.kill(pid, 0); return false } catch { return true } })
})

test('unsupported explicit effort and model are visible capabilities, not silently ignored', async (t) => {
  for (const selection of [{ effort: 'high' }, { model: 'selected-model' }]) {
    const { engine } = fixture(t, 'acp', 'goose', selection)
    await assert.rejects(engine.send('hello'), /поддерж|модел|capability/i)
    assert.equal(engine.snapshot().status, 'error')
  }
})

test('Windows npm shim launches its script directly and preserves argv metacharacters', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-windows-launch-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'fixture.cmd'), '@ECHO off\n"%dp0%entry.mjs" %*\n')
  writeFileSync(join(dir, 'entry.mjs'), '')
  writeFileSync(join(dir, 'node.exe'), '')
  const args = ['--append-system-prompt', 'Hello & %PATH%\n(orca) "quoted"']
  const launch = structuredLaunch('fixture', args, { PATH: dir, PATHEXT: '.CMD;.EXE' }, 'win32')
  assert.equal(launch.command, join(dir, 'node.exe'))
  assert.deepEqual(launch.args, [join(dir, 'entry.mjs'), ...args])
})

test('dispose terminates the owned process group including its timer subprocess', async (t) => {
  const { engine, wire } = fixture(t, 'claude-child')
  await engine.send('permission')
  await until(() => engine.snapshot().status === 'waiting')
  const childPid = wire().find((frame) => typeof frame.fixtureChildPid === 'number')?.fixtureChildPid as number
  assert.ok(childPid > 0)
  const alive = (): boolean => { try { process.kill(childPid, 0); return true } catch { return false } }
  assert.equal(alive(), true)
  engine.dispose()
  await until(() => !alive())
})

test('Codex asynchronous turn rejection exposes native error and retains the already accepted human message', async (t) => {
  const { engine } = fixture(t, 'codex-reject', 'codex')
  await engine.send('accepted text')
  await until(() => engine.snapshot().status === 'error')
  assert.match(engine.snapshot().error ?? '', /Turn rejected/)
  assert.equal(engine.snapshot().messages[0].text, 'accepted text')
})

test('assistant launch removes inherited task bindings and retains socket role env', async (t) => {
  const keys = ['ORCA_PROJECT', 'ORCA_RUN_ID', 'ORCA_TASK_ID', 'ORCA_DISPATCH_ID']
  const previous = keys.map((key) => process.env[key])
  keys.forEach((key) => { process.env[key] = 'must-not-leak' })
  t.after(() => keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] }))
  const { engine, wire } = fixture(t)
  await engine.send('permission')
  await until(() => engine.snapshot().status === 'waiting')
  const env = (wire().find((frame) => frame.fixtureSpawn)?.fixtureSpawn as { env: Record<string, string> }).env
  assert.equal(env.ORCA_ROLE, 'assistant')
  for (const key of keys) assert.equal(env[key], undefined)
})


test('Claude permission reveals actual Bash arguments alongside the friendly description', async (t) => {
  const { engine } = fixture(t)
  await engine.send('permission-description')
  await until(() => engine.snapshot().status === 'waiting')
  const permission = engine.snapshot().interactions[0]
  assert.ok(permission.tool?.input.includes('orca-board projects list'))
  assert.ok(permission.text?.includes('Friendly description'))
})

test('Codex approval shows the current subcommand rather than its parent tool command', async (t) => {
  const { engine } = fixture(t, 'codex', 'codex')
  await engine.send('subcommand')
  await until(() => engine.snapshot().status === 'waiting')
  assert.ok(engine.snapshot().interactions[0].tool?.input.includes('actual-command-needing-approval'))
})

test('Codex resolved notification removes permission and rejects stale UI confirmation', async (t) => {
  const { engine, wire } = fixture(t, 'codex', 'codex')
  await engine.send('revoked')
  await until(() => engine.snapshot().interactions.length > 0)
  const permission = engine.snapshot().interactions[0]
  // Под нагрузкой фикстура и событие main могут прийти позже 100 мс; ждём сам результат отзыва.
  await until(() => engine.snapshot().interactions.length === 0)
  assert.equal(engine.snapshot().interactions.length, 0)
  assert.equal(engine.snapshot().status, 'thinking')
  await assert.rejects(engine.respond(permission.id, { kind: 'option', optionId: 'accept' }), /активен|active/)
  assert.equal(wire().some((frame) => frame.id === 'approval-1' && frame.result), false)
})

test('ACP permission retains real tool arguments when only the friendly title is repeated', async (t) => {
  const { engine } = fixture(t, 'acp', 'gemini')
  await engine.send('permission')
  await until(() => engine.snapshot().status === 'waiting')
  assert.ok(engine.snapshot().interactions[0].tool?.input.includes('orca-board projects list'))
})

for (const agent of ['claude', 'codex', 'gemini', 'cursor', 'opencode', 'copilot', 'goose'] as const) {
  test(`${agent}: скрытый контекст получает провайдер, история содержит только текст человека`, async (t) => {
    const { engine, updates, wire } = fixture(t, agent === 'claude' ? 'claude' : agent === 'codex' ? 'codex' : 'acp', agent)
    await engine.send('Discuss workflow', 'Hidden workflow context: fixture-baseline')
    await until(() => engine.snapshot().status === 'done' || engine.snapshot().interactions.length > 0)
    const frames = wire()
    const prompt = agent === 'claude' ? frames.find((f) => f.type === 'user')
      : frames.find((f) => f.method === (agent === 'codex' ? 'turn/start' : 'session/prompt'))
    assert.match(JSON.stringify(prompt), /fixture-baseline/)
    if (agent !== 'claude' && agent !== 'codex') assert.match(JSON.stringify(prompt), /Use orca-board/)
    assert.equal(engine.snapshot().messages.find((m) => m.role === 'human')?.text, 'Discuss workflow')
    assert.deepEqual(updates.filter((u) => u.type === 'message' && u.message.role === 'human').map((u) => u.type === 'message' ? u.message.text : ''), ['Discuss workflow'])
    const pending = engine.snapshot().interactions[0]
    if (pending) await engine.respond(pending.id, { kind: 'option', optionId: pending.options![0].id })
    await until(() => engine.snapshot().status === 'done')
    await engine.send('Follow up')
    await until(() => engine.snapshot().status === 'done' || engine.snapshot().interactions.length > 0)
    const next = wire().filter((f) => agent === 'claude' ? f.type === 'user' : f.method === (agent === 'codex' ? 'turn/start' : 'session/prompt')).at(-1)
    assert.equal(JSON.stringify(next).includes('fixture-baseline'), false)
  })
}


test('Codex contextual send ждёт ACK, принимает permission без ожидания завершения turn', async (t) => {
  const { engine, wire, release } = fixture(t, 'codex-hold-ack', 'codex')
  let accepted = false
  const sending = engine.send('Workflow request', 'Hidden workflow baseline').then(() => { accepted = true })
  await until(() => wire().some((frame) => frame.method === 'turn/start'))
  assert.equal(accepted, false)
  release()
  await sending
  await until(() => engine.snapshot().status === 'waiting')
  assert.equal(accepted, true)
  assert.equal(engine.snapshot().messages.find((m) => m.role === 'human')?.text, 'Workflow request')
})

test('Codex contextual rejection отклоняет send; обычный early-resolve контракт сохранён', async (t) => {
  const contextual = fixture(t, 'codex-reject', 'codex')
  await assert.rejects(contextual.engine.send('Workflow request', 'Hidden workflow baseline'), /Turn rejected by configured policy/)
  assert.equal(contextual.engine.snapshot().status, 'error')
  const plain = fixture(t, 'codex-reject', 'codex')
  await plain.engine.send('Plain request')
  await until(() => plain.engine.snapshot().status === 'error')
  assert.equal(plain.engine.snapshot().messages.find((m) => m.role === 'human')?.text, 'Plain request')
})

test('ACP contextual send принимает первую activity/permission, отклоняет error до activity', async (t) => {
  const { engine, wire, release } = fixture(t, 'acp-hold-activity', 'gemini')
  let accepted = false
  const sending = engine.send('Workflow request', 'Hidden workflow baseline').then(() => { accepted = true })
  await until(() => wire().some((frame) => frame.method === 'session/prompt'))
  assert.equal(accepted, false)
  release()
  await sending
  await until(() => engine.snapshot().status === 'waiting')
  assert.equal(accepted, true)
  const rejected = fixture(t, 'acp-reject', 'gemini')
  await assert.rejects(rejected.engine.send('Workflow request', 'Hidden workflow baseline'), /Prompt rejected before activity/)
  assert.equal(rejected.engine.snapshot().status, 'error')
})

for (const [mode, agent] of [['codex-hold-ack', 'codex'], ['acp-hold-activity', 'gemini']] as const) {
  test(`${agent}: contextual pending dispose/interrupt завершают promise до acceptance`, async (t) => {
    const disposed = fixture(t, mode, agent)
    const sending = disposed.engine.send('Workflow request', 'Hidden workflow baseline')
    const rejection = assert.rejects(sending, /closed|закрыт|прерван|interrupted/i)
    await until(() => disposed.wire().some((f) => f.method === (agent === 'codex' ? 'turn/start' : 'session/prompt')))
    disposed.engine.dispose()
    await rejection
    const stopped = fixture(t, mode, agent)
    const pending = stopped.engine.send('Workflow request', 'Hidden workflow baseline')
    const interruptedSend = assert.rejects(pending, /прерван|interrupted/i)
    await until(() => stopped.wire().some((f) => f.method === (agent === 'codex' ? 'turn/start' : 'session/prompt')))
    const interrupt = stopped.engine.interrupt()
    if (agent === 'codex') stopped.release()
    await interruptedSend
    await interrupt
    await until(() => stopped.engine.snapshot().status === 'interrupted')
  })
  test(`${agent}: выход до acceptance отклоняет contextual send`, async (t) => {
    const f = fixture(t, agent === 'codex' ? 'codex-exit-before-ack' : 'acp-exit-before-activity', agent)
    await assert.rejects(f.engine.send('Workflow request', 'Hidden workflow baseline'), /Fixture exit before acceptance/)
    assert.equal(f.engine.snapshot().status, 'error')
  })
}

for (const [mode, agent] of [['codex-context-early', 'codex'], ['acp-context-early', 'gemini']] as const) {
  test(`${agent}: contextual human предшествует раннему ответу без permission`, async (t) => {
    const { engine, updates } = fixture(t, mode, agent)
    await engine.send('Workflow request', 'Hidden workflow baseline')
    await until(() => engine.snapshot().status === 'done')
    assert.deepEqual(engine.snapshot().messages.map((message) => [message.role, message.text]), [
      ['human', 'Workflow request'], ['agent', 'Early response']
    ])
    assert.deepEqual(updates.filter((update) => update.type === 'message').map((update) => update.type === 'message' ? update.message.role : ''), ['human', 'agent'])
    assert.equal(JSON.stringify(engine.snapshot().messages).includes('Hidden workflow baseline'), false)
  })
}

test('ACP contextual permission без preceding activity принимает send до ответа человека', async (t) => {
  const { engine } = fixture(t, 'acp', 'cursor')
  await engine.send('question', 'Hidden workflow baseline')
  assert.equal(engine.snapshot().status, 'waiting')
  assert.equal(engine.snapshot().interactions[0].kind, 'question')
  assert.equal(engine.snapshot().messages[0].text, 'question')
})
