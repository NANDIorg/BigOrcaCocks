import readline from 'node:readline'
import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const mode = process.env.ORCA_TEST_MODE ?? 'claude'
const log = process.env.ORCA_TEST_LOG
if (log) appendFileSync(log, JSON.stringify({ fixtureSpawn: { argv: process.argv.slice(2), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('ORCA_'))) } }) + '\n')
if (mode === 'claude-child') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  if (log) appendFileSync(log, JSON.stringify({ fixtureChildPid: child.pid }) + '\n')
}
let writeTail = Promise.resolve()
const write = (value) => {
  const line = JSON.stringify(value) + '\n'
  if (mode === 'fragmented') {
    writeTail = writeTail.then(() => new Promise((resolve) => {
      process.stdout.write(line.slice(0, 7))
      setTimeout(() => { process.stdout.write(line.slice(7)); resolve() }, 5)
    }))
  } else process.stdout.write(line)
}
const rpc = (id, result) => write({ jsonrpc: '2.0', id, result })
const control = (id, response = {}) => write({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })
const text = (content) => write({ type: 'assistant', uuid: 'fixture-a', message: { id: 'fixture-m', content: [{ type: 'text', text: content }] } })
let pendingPrompt
let seq = 0
let currentTurn = 'turn-1'
let currentPrompt
if (mode === 'startup-failure') {
  process.stderr.write('Fixture startup refused\n')
  process.exit(7)
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const value = JSON.parse(line)
  if (log) appendFileSync(log, JSON.stringify(value) + '\n')
  if (value.type === 'control_request') {
    control(value.request_id)
    if (value.request.subtype === 'interrupt') {
      write({ type: 'control_cancel_request', request_id: 'permission-1' })
      write({ type: 'result', subtype: 'success', result: '', is_error: false })
    }
    return
  }
  if (value.type === 'user') {
    currentPrompt = value.message.content
    if (typeof currentPrompt !== 'string') currentPrompt = currentPrompt[0].text
    if (currentPrompt === 'question') {
      write({ type: 'control_request', request_id: 'question-1', request: {
        subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'question-tool-1', input: { marker: 'preserve', questions: [
          { question: 'Which project?', header: 'Project', multiSelect: false, options: [{ label: 'One', description: 'First' }, { label: 'Two', description: 'Second' }] },
          { question: 'Which areas?', header: 'Areas', multiSelect: true, options: [{ label: 'UI', description: 'Interface' }, { label: 'API', description: 'Backend' }] }
        ] }
      } })
    } else if (currentPrompt === 'permission' || currentPrompt === 'permission-description' || currentPrompt === 'long') {
      write({ type: 'assistant', uuid: 'a-tool', message: { id: 'tool-message', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'orca-board projects list', description: 'List projects' } }] } })
      write({ type: 'control_request', request_id: 'permission-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tool-1', input: { command: 'orca-board projects list', ...(currentPrompt === 'permission-description' ? { description: 'Friendly description' } : {}) } } })
    } else {
      write({ type: 'future_unrecognized_event', future: 'ignored' })
      write({ type: 'stream_event', event: { type: 'message_start', message: { id: 'fixture-m' } } })
      write({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
      write({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Привет 🌊' } } })
      text('Привет 🌊')
      write({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
      write({ type: 'result', subtype: 'success', result: 'Привет 🌊', is_error: false })
    }
    return
  }
  if (value.type === 'control_response') {
    if (value.response.request_id === 'question-1') text(JSON.stringify(value.response.response))
    else {
      write({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Result', is_error: value.response.response.behavior === 'deny' }] } })
      text(value.response.response.behavior)
    }
    write({ type: 'result', subtype: 'success', result: 'done', is_error: false })
    return
  }
  if (value.method === 'initialize') {
    rpc(value.id, mode.startsWith('codex') ? { userAgent: 'fixture/0.77.0' } : { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] })
  } else if (value.method === 'thread/start') rpc(value.id, { thread: { id: 'thread-1' } })
  else if (value.method === 'session/new') rpc(value.id, { sessionId: 'session-1' })
  else if (value.method === 'turn/start') {
    if (mode === 'codex-reject') { write({ id: value.id, error: { code: -32000, message: 'Turn rejected by configured policy' } }); return }
    currentTurn = `turn-${++seq}`
    currentPrompt = value.params.input[0].text
    rpc(value.id, { turn: { id: currentTurn, status: 'inProgress', items: [] } })
    const params = { threadId: 'thread-1', turnId: currentTurn }
    write({ method: 'item/started', params: { ...params, item: { type: 'commandExecution', id: 'exec-1', command: 'orca-board projects list', cwd: process.cwd(), status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null, processId: null } } })
    write({ id: 'approval-1', method: mode === 'codex-legacy' ? 'execCommandApproval' : 'item/commandExecution/requestApproval', params: mode === 'codex-legacy' ? { conversationId: 'thread-1', callId: 'exec-1', command: ['orca-board', 'projects', 'list'], cwd: process.cwd(), reason: 'Fixture permission' } : { ...params, itemId: 'exec-1', ...(currentPrompt === 'subcommand' ? { command: 'actual-command-needing-approval' } : {}), reason: 'Fixture permission', proposedExecpolicyAmendment: null } })
    if (currentPrompt === 'revoked') setTimeout(() => write({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 'approval-1' } }), 25)
  } else if (value.method === 'turn/interrupt') {
    const oldTurn = currentTurn
    rpc(value.id, {})
    write({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: currentTurn, status: 'interrupted', items: [], error: null } } })
    if (mode === 'codex-late') setTimeout(() => {
      write({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: oldTurn, itemId: 'stale-message', delta: 'STALE' } })
      write({ id: 'stale-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: oldTurn, itemId: 'old-tool' } })
    }, 30)
  } else if (value.method === 'session/prompt') {
    currentPrompt = value.params.prompt[0].text.split('\n\n').at(-1)
    pendingPrompt = value.id
    if (mode === 'acp-unknown-client') {
      write({ jsonrpc: '2.0', id: 'unsupported-client', method: 'terminal/create', params: { sessionId: 'session-1', command: 'sh' } })
    } else if (currentPrompt === 'question') {
      write({ jsonrpc: '2.0', id: 'cursor-question', method: 'cursor/ask_question', params: { toolCallId: 'question-tool', title: 'Choose project', questions: [{ id: 'project', prompt: 'Which project?', allowMultiple: false, options: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }] } })
    } else {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking ' } } } })
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'tool_call', toolCallId: 'exec-1', title: 'List projects', kind: 'execute', status: 'pending', rawInput: { command: 'orca-board projects list', description: 'Friendly description' } } } })
      write({ jsonrpc: '2.0', id: 'permission-acp', method: 'session/request_permission', params: { sessionId: 'session-1', toolCall: { toolCallId: 'exec-1', title: 'List projects' }, options: [{ optionId: 'once-provider-specific', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject-provider-specific', name: 'Reject', kind: 'reject_once' }] } })
    }
  } else if (value.method === 'session/cancel') {
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', status: 'failed' } } })
    rpc(pendingPrompt, { stopReason: 'cancelled' })
  } else if (value.result) {
    if (mode === 'codex-late' && (value.id === 'stale-approval' || currentTurn === 'turn-1')) return
    if (mode.startsWith('codex')) {
      const decision = mode === 'codex-legacy' ? value.result.decision : value.result.decision
      write({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: currentTurn, itemId: 'final-1', delta: `Decision:${decision}` } })
      write({ method: 'item/completed', params: { threadId: 'thread-1', turnId: currentTurn, item: { type: 'agentMessage', id: 'final-1', text: `Decision:${decision}` } } })
      write({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: currentTurn, status: 'completed', items: [], error: null } } })
    } else if (value.result.outcome?.outcome !== 'cancelled') {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(value.result) } } } })
      rpc(pendingPrompt, { stopReason: 'end_turn' })
    }
  }
})
