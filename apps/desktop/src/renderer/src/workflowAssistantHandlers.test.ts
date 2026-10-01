import { AssistantSession } from '../../main/assistant-session'
import type { AssistantSettings } from '@orca-board/core'
import type { WorkflowAgentChoice, WorkflowAttachment } from './workflowAssistant'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as core from '@orca-board/core'
import * as workflowNav from './workflowNav'
import * as workflowForm from './workflowForm'
import * as workflowEditorView from './workflowEditorView'
import * as taskTypeEdit from './taskTypeEdit'
import * as defaultTitles from './defaultTitles'
import * as nodeTemplates from './nodeTemplates'
import * as workflowAssistant from './workflowAssistant'
import * as assistantChat from './assistantChat'
import type { TestContext } from 'node:test'
import { t } from './i18n'
import { ipcErrorMessage } from './ipcError'
import { componentHarness, jsxHandler, namedHandler } from '../../../test/react-handler-harness'
import { assistantAgentOf } from './assistantSettings'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectManager } from '../../main/projects'
import { saveWorkflowDraft } from '../../main/assistant-workflow'
import { PROJECTS_FILE_VERSION } from '../../main/task-types-migration'
import type { TaskTypesHook } from './settings/useTaskTypes'
import type { WorkflowAssistantContext } from '../../shared/assistant-workflow'
import { assistantSavePatch } from './assistantSettings'
import { extraArgsSupported } from './extraArgsHints'
import { versionLabel } from './updateState'

function workflowHarness() {
  return componentHarness(new URL('./settings/TaskTypeWorkflow.tsx', import.meta.url), 'TaskTypeWorkflow', {
    '@orca-board/core': core,
    '../../../shared/assistant-workflow': {},
    '../workflowAssistant': workflowAssistant,
    '../appearance': { motionScrollBehavior: () => 'auto' },
    '../WorkflowCanvas': { WorkflowCanvas: 'canvas' },
    '../WorkflowInspector': { WorkflowInspector: 'inspector' },
    '../icons': { Icon: new Proxy({}, { get: (_target, key) => `icon-${String(key)}` }) },
    '../workflowEdit': { wfPortLabel: (value: string) => value },
    '../workflowNav': workflowNav,
    '../workflowForm': workflowForm,
    '../workflowEditorView': workflowEditorView,
    '../about/parts': { SectionHead: 'head' },
    '../i18n': { useLocale: () => 'ru', useT: () => t },
    '../defaultTitles': defaultTitles,
    '../ipcError': { ipcErrorMessage },
    '../taskTypeEdit': taskTypeEdit,
    '../nodeTemplates': nodeTemplates
  })
}

function fixture(onSave: (workflow: core.Workflow | null, baseline: core.Workflow) => Promise<void>) {
  const harness = workflowHarness()
  let incoming = core.defaultWorkflow(core.DEFAULT_ROLES)
  const props = () => ({ title: 'Workflow', workflow: incoming, roles: core.DEFAULT_ROLES, columns: [], readOnly: false, onSave })
  const flush = () => harness.flush(props())
  const button = (key: Parameters<typeof t>[0]) => harness.find((node) => node.type === 'button' && node.props.children === t(key))
  const graph = () => harness.find((node) => node.type === 'canvas').props.workflow as core.Workflow
  const edit = (workflow: core.Workflow) => { (harness.find((node) => node.type === 'canvas').props.onChange as (value: core.Workflow) => void)(workflow); flush() }
  const conflict = () => { try { harness.find((node) => node.props.role === 'alert' && node.props.children === t('config.wf.tab.externalConflict')); return true } catch { return false } }
  flush()
  return { harness, flush, button, graph, edit, conflict, incoming: (next: core.Workflow) => { incoming = next; flush() } }
}
function titled(graph: core.Workflow, title: string): core.Workflow { const next = structuredClone(graph); next.nodes[0].title = title; return next }
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done }); return { promise, resolve } }
const tick = async () => { await new Promise<void>((resolve) => setImmediate(resolve)) }

test('реальная кнопка ассистента остаётся видимой и отключается для readOnly и pending Save', async () => {
  const pending = deferred()
  const harness = workflowHarness()
  const graph = core.defaultWorkflow(core.DEFAULT_ROLES)
  const base = { title: 'Workflow', workflow: graph, roles: core.DEFAULT_ROLES, columns: [], onSave: () => pending.promise, onAssistant: () => {} }
  const button = () => harness.find((node) => node.type === 'button' && Array.isArray(node.props.children) && node.props.children.includes(t('config.wf.tab.assistant')))
  harness.flush({ ...base, readOnly: true })
  assert.equal(button().props.disabled, true)
  harness.flush({ ...base, readOnly: false })
  assert.equal(button().props.disabled, false)
  ;(harness.find((node) => node.type === 'canvas').props.onChange as (value: core.Workflow) => void)(titled(graph, 'Dirty draft'))
  harness.flush()
  ;(harness.find((node) => node.type === 'button' && node.props.children === t('config.wf.tab.save')).props.onClick as () => void)()
  harness.flush()
  assert.equal(button().props.disabled, true)
  pending.resolve(); await tick(); harness.flush()
  assert.equal(button().props.disabled, false)
  harness.dispose()
})

test('реальный late Save handler пересверяет B, пришедший до завершения onSave', async () => {
  const write = deferred()
  const f = fixture(() => write.promise)
  const a = f.graph(); const d = titled(a, 'draft-D'); const b = titled(a, 'external-B')
  f.edit(d)
  ;(f.button('config.wf.tab.save').props.onClick as () => void)(); f.flush()
  f.incoming(b)
  assert.equal(f.conflict(), true)
  write.resolve(); await tick(); f.flush()
  assert.deepEqual(f.graph(), b)
  assert.equal(f.conflict(), false)
  f.harness.dispose()
})

test('реальный editor effect принимает B, когда ручной draft возвращается к A', () => {
  const f = fixture(async () => {})
  const a = f.graph(); const d = titled(a, 'draft-D'); const b = titled(a, 'external-B')
  f.edit(d); f.incoming(b)
  assert.equal(f.conflict(), true)
  assert.equal(f.button('config.wf.tab.revert').props.disabled, false)
  f.edit(a)
  assert.deepEqual(f.graph(), b)
  assert.equal(f.conflict(), false)
  f.harness.dispose()
})

test('реальный late Reset handler принимает более свежий B после успешной записи default', async () => {
  const write = deferred()
  const f = fixture(() => write.promise)
  const own = titled(f.graph(), 'own-A'); f.incoming(own)
  const b = titled(own, 'external-B')
  const reset = f.harness.find((node) => node.type === 'button' && node.props.className === 'btn-sm danger' && node.props.disabled === false)
  ;(reset.props.onClick as () => void)(); f.flush()
  const confirm = f.button('config.wf.tab.reset')
  ;(confirm.props.onClick as () => void)(); f.flush()
  f.incoming(b)
  write.resolve(); await tick(); f.flush()
  assert.deepEqual(f.graph(), b)
  assert.equal(f.conflict(), false)
  f.harness.dispose()
})


function sessionFixture(agent: AssistantSettings['agent']) {
  let settings: AssistantSettings = { agent }
  const children: { disposed: boolean }[] = []
  const killed: string[] = []
  const session = new AssistantSession({
    settings: () => settings, assertUsable: () => {}, isAlive: () => true,
    startTerminal: () => 'terminal-session', killTerminal: (id) => { killed.push(id) }, onUpdate: () => {},
    create: (input) => {
      const child = { disposed: false }; children.push(child)
      const id = `chat-${children.length}`
      return { id, snapshot: () => ({ id, agent: input.agent, messages: [{ id: 'message', role: 'human', text: 'Existing discussion', at: 1 }], status: 'waiting', interactions: [{ id: 'permission', kind: 'permission', title: 'Bash' }] }), send: async () => {}, respond: async () => {}, interrupt: async () => {}, dispose: () => { child.disposed = true } }
    }
  })
  const id = session.open(80, 30, false).ptyId
  return { session, id, children, killed, setAgent: (next: AssistantSettings['agent']) => { settings = { agent: next } } }
}

function appHandlers(f: ReturnType<typeof sessionFixture>, sourceAgent: 'amp' | 'shell' = 'shell') {
  const attachment: WorkflowAttachment = { nonce: 7, context: { mode: 'create' } }
  const choiceRef = { current: null as WorkflowAgentChoice | null }
  const sessionRef = { current: f.id }
  const attachmentRef = { current: attachment }
  let resets = 0
  const bindings = {
    workflowAttachmentRef: attachmentRef, workflowSessionRef: sessionRef, workflowAgentChoiceRef: choiceRef,
    updateWorkflowAgentChoice: (choice: WorkflowAgentChoice | null) => { choiceRef.current = choice },
    setSettingsSectionRequest: () => {}, setShowSettings: () => {},
    setAppSettings: (next: { assistant: AssistantSettings }) => f.setAgent(next.assistant.agent),
    applyWorkflowAgentChoice: workflowAssistant.applyWorkflowAgentChoice, assistantAgentOf,
    appSettings: { assistant: { agent: f.session.snapshot(f.id).agent } }, workflowAttachment: attachment,
    launchAssistant: (reset: boolean) => { assert.equal(reset, true); resets++; f.session.open(80, 30, reset) }
  }
  const source = new URL('./App.tsx', import.meta.url)
  return { attachment, choiceRef, sessionRef, attachmentRef, resets: () => resets,
    choose: () => jsxHandler(source, 'AssistantPanel', 'onChooseChatAgent', bindings)(f.id, sourceAgent),
    select: (agent: AssistantSettings['agent']) => jsxHandler(source, 'SettingsModal', 'onWorkflowAgentSelected', bindings)(agent),
    settings: (agent: AssistantSettings['agent']) => jsxHandler(source, 'SettingsModal', 'onAppSettings', bindings)({ assistant: { agent } }) }
}

test('реальный App settings completion сохраняет живой chat→chat с attachment и pending permission', () => {
  const f = sessionFixture('claude'); const handlers = appHandlers(f)
  handlers.settings('codex')
  assert.equal(handlers.resets(), 0)
  assert.equal(f.children[0].disposed, false)
  assert.equal(f.session.snapshot(f.id).interactions?.[0].id, 'permission')
  assert.equal(f.session.snapshot(f.id).messages[0].text, 'Existing discussion')
  f.session.dispose()
})

for (const sourceAgent of ['amp', 'shell'] as const) {
  test(`${sourceAgent}: реальные App choose/select/settings callbacks меняют сессию один раз`, () => {
    const f = sessionFixture(sourceAgent); const handlers = appHandlers(f, sourceAgent)
    handlers.choose()
    assert.deepEqual(handlers.choiceRef.current, { sessionId: f.id, attachmentNonce: 7, sourceAgent })
    handlers.settings('gemini')
    assert.equal(handlers.resets(), 0)
    handlers.select('gemini')
    handlers.sessionRef.current = 'other-session'; handlers.settings('gemini')
    assert.equal(handlers.resets(), 0)
    handlers.sessionRef.current = f.id; handlers.attachmentRef.current = { ...handlers.attachment, nonce: 8 }
    handlers.settings('gemini'); assert.equal(handlers.resets(), 0)
    handlers.attachmentRef.current = handlers.attachment; handlers.settings('gemini')
    assert.equal(handlers.resets(), 1)
    assert.equal(handlers.choiceRef.current, null)
    handlers.settings('gemini'); assert.equal(handlers.resets(), 1)
    assert.deepEqual(f.killed, [f.id])
    assert.equal(f.session.snapshot('chat-1').agent, 'gemini')
    assert.equal(handlers.attachmentRef.current.nonce, 7)
    f.session.dispose()
  })
}

/** Граница состояния App: сами переходы берутся из production callbacks, не дублируются здесь. */
function workflowEntryFixture() {
  const source = new URL('./App.tsx', import.meta.url)
  const graph = core.defaultWorkflow(core.DEFAULT_ROLES)
  const initial: Extract<WorkflowAssistantContext, { mode: 'edit' }> = { mode: 'edit', typeId: 'mine', title: 'Workflow', workflow: graph, baseline: structuredClone(graph), dirty: true, path: ['nested'] }
  let attachment: WorkflowAttachment | null = { nonce: 7, context: initial }
  let destination: typeof initial | null = initial
  let choice: WorkflowAgentChoice | null = { sessionId: 'panel-session', attachmentNonce: 7, sourceAgent: 'shell' }
  let request: { nonce: number; text: string } | null = null
  let shown = false
  let settings = true
  let reset = 0
  let inserted = 0
  const attachmentRef = { current: attachment as WorkflowAttachment | null }
  const bindings: Record<string, unknown> = {
    t, structuredClone, workflowNonce: { current: 7 }, workflowAttachmentRef: attachmentRef,
    updateWorkflowAgentChoice: (next: WorkflowAgentChoice | null) => { choice = next },
    setWorkflowAttachment: (next: WorkflowAttachment | null | ((value: WorkflowAttachment | null) => WorkflowAttachment | null)) => { attachment = typeof next === 'function' ? next(attachment) : next; attachmentRef.current = attachment },
    setWorkflowReturn: (next: typeof destination) => { destination = next },
    setWorkflowComposerRequest: (next: typeof request | ((value: typeof request) => typeof request)) => { request = typeof next === 'function' ? next(request) : next },
    setWorkflowResult: () => {}, setSettingsSectionRequest: () => {},
    setShowSettings: (next: boolean) => { settings = next }, setShowInbox: () => {},
    setShowAssistant: (next: boolean | ((value: boolean) => boolean)) => { shown = typeof next === 'function' ? next(shown) : next },
    launchAssistant: () => { reset++ }
  }
  for (const name of ['clearWorkflowContext', 'requestWorkflowCreation', 'toggleAssistant']) bindings[name] = (...args: unknown[]) => namedHandler(source, name, bindings)(...args)
  const attach = (context: WorkflowAssistantContext) => namedHandler(source, 'attachWorkflow', bindings)(context)
  bindings.attachWorkflow = attach
  return { initial, attachment: () => attachment, destination: () => destination, choice: () => choice, request: () => request,
    shown: () => shown, settings: () => settings, reset: () => reset, inserted: () => inserted,
    create: () => jsxHandler(source, 'AssistantPanel', 'onCreateWorkflow', bindings)(),
    settingsCreate: () => jsxHandler(new URL('./settings/SettingsModal.tsx', import.meta.url), 'PopupMenu', 'onPick', {
      closePresetMenu: () => {}, onWorkflowAssistant: attach, createType: () => { inserted++ }
    })('assistant'),
    attach, detach: () => jsxHandler(source, 'AssistantPanel', 'onDetachWorkflow', bindings)(),
    consume: (nonce: number) => jsxHandler(source, 'AssistantPanel', 'onWorkflowSent', bindings)(nonce),
    newDialog: () => jsxHandler(source, 'AssistantPanel', 'onReset', bindings)(),
    rail: () => jsxHandler(source, 'button', 'onClick', bindings, { attribute: 'title', expression: "{t('shell.rail.assistant')}" })(),
    hotkey: () => namedHandler(source, 'onKey', bindings)({ code: 'KeyK', metaKey: true, preventDefault: () => {}, stopPropagation: () => {} }) }
}

for (const entry of ['create', 'settingsCreate'] as const) {
  test(`реальный App ${entry} заполняет composer без контекста, возврата, отправки и пустого типа`, () => {
    const f = workflowEntryFixture()
    f[entry]()
    assert.equal(f.attachment(), null)
    assert.equal(f.destination(), null)
    assert.equal(f.choice(), null)
    assert.equal(f.request()?.text, t('shell.assistant.suggestion.workflow.prompt'))
    assert.equal(f.shown(), true)
    assert.equal(f.settings(), false)
    assert.equal(f.reset(), 0)
    assert.equal(f.inserted(), 0)
  })
}

test('реальный App edit передаёт независимый полный снимок и сохраняет возврат после принятой отправки', () => {
  const f = workflowEntryFixture()
  f.attach(f.initial)
  assert.deepEqual(f.attachment()?.context, f.initial)
  assert.notEqual(f.attachment()?.context, f.initial)
  const nonce = f.attachment()!.nonce
  f.consume(nonce)
  assert.equal(f.attachment(), null)
  assert.deepEqual(f.destination(), f.initial)
  f.initial.workflow.nodes[0].title = 'Later edit'
  assert.notEqual(f.destination()?.workflow.nodes[0].title, 'Later edit')
})

for (const entry of ['detach', 'rail', 'hotkey', 'newDialog'] as const) {
  test(`реальный App ${entry} очищает вложение, возврат и ожидающий выбор агента`, () => {
    const f = workflowEntryFixture()
    f[entry]()
    assert.equal(f.attachment(), null)
    assert.equal(f.destination(), null)
    assert.equal(f.choice(), null)
    assert.equal(f.reset(), entry === 'newDialog' ? 1 : 0)
  })
}

async function panelFixture(context: TestContext, transport: 'chat' | 'terminal' = 'chat', discussion = false, snapshotReady?: Promise<void>) {
  const pending = deferred()
  let reject!: (error: Error) => void
  const sending = new Promise<void>((resolve, failure) => { pending.promise.then(resolve); reject = failure })
  const contextual: { session: string; text: string; context: unknown }[] = []
  const plain: string[] = []
  const consumed: number[] = []
  const choices: string[] = []
  let settings = 0
  let attachment: WorkflowAttachment | null = { nonce: 7, context: { mode: 'create' } }
  let session = 'panel-session'
  let composerRequest: { nonce: number; text: string } | null = null
  const applied: number[] = []
  let focuses = 0
  let open = false
  let entry: ReturnType<typeof workflowEntryFixture> | undefined
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: null } })
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: class {} })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener: () => {}, removeEventListener: () => {}, orca: { assistantChat: {
    getMessages: async (ptyId: string) => {
      await snapshotReady
      return { protocolVersion: 2, ptyId, revision: 1, transport, agent: transport === 'terminal' ? 'shell' : 'codex', messages: discussion ? [{ id: 'human', role: 'human', text: 'Existing discussion', at: 1 }] : [], interactions: [], status: 'done' }
    },
    onMessage: () => () => {}, interrupt: async () => {}, respond: async () => {},
    send: async (_session: string, text: string) => { plain.push(text) },
    sendWithWorkflow: (session: string, text: string, context: unknown) => { contextual.push({ session, text, context }); return sending }
  } } } })
  const harness = componentHarness(new URL('./AssistantPanel.tsx', import.meta.url), 'AssistantPanel', {
    './workflowAssistant': workflowAssistant, './AgentLogo': { AgentLogo: 'logo' }, './defaultTitles': defaultTitles,
    './Markdown': { Markdown: 'markdown' }, './icons': { Icon: new Proxy({}, { get: (_target, key) => `icon-${String(key)}` }) },
    './AssistantInteraction': { AssistantInteraction: 'interaction' }, './assistantChat': assistantChat,
    './ipcError': { ipcErrorMessage }, './useModalFocus': { useModalFocus: () => {} }, './i18n': { useT: () => t }
  })
  context.after(() => {
    harness.dispose()
    if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window')
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document')
    if (previousElement) Object.defineProperty(globalThis, 'HTMLElement', previousElement); else Reflect.deleteProperty(globalThis, 'HTMLElement')
  })
  const noop = () => {}
  const flush = () => harness.flush({ open, suspended: false, activePty: session, status: { busy: false, error: null },
    onClose: noop, onReset: noop, onSettings: () => { settings++ },
    onChooseChatAgent: (session: string, agent: string) => { choices.push(`${session}:${agent}`) },
    onOpenInTerminals: noop, canOpenInTerminals: true, attachment: entry ? entry.attachment() : attachment, returnAvailable: entry ? entry.destination() !== null : true, result: null,
    composerRequest, onComposerRequestApplied: (nonce: number) => { applied.push(nonce) },
    onCreateWorkflow: () => { attachment = null; composerRequest = { nonce: 20, text: t('shell.assistant.suggestion.workflow.prompt') }; flush() }, onDetachWorkflow: () => { entry?.detach(); flush() }, onWorkflowSent: (nonce: number) => { consumed.push(nonce); attachment = null },
    onReturnWorkflow: noop, onOpenWorkflow: noop })
  const textarea = () => harness.find((node) => node.type === 'textarea')
  const focusRef = () => { if (transport === 'chat') (textarea().props.ref as { current: unknown }).current = { focus: () => { focuses++ }, style: {}, scrollHeight: 64 } }
  const edit = (text: string) => { (textarea().props.onChange as (event: { target: { value: string } }) => void)({ target: { value: text } }); flush() }
  const send = () => { (harness.find((node) => node.props.className === 'chat-send').props.onClick as () => void)(); flush() }
  flush(); await tick(); flush(); focusRef()
  return { harness, flush, edit, send, applied,
    connect: (next: ReturnType<typeof workflowEntryFixture>) => { entry = next; flush() },
    open: (next: boolean) => { open = next; flush() }, focuses: () => focuses,
    prefill: (next: { nonce: number; text: string }) => { composerRequest = next; flush() },
    detach: () => { attachment = null; flush() },
    chat: () => { transport = 'chat'; session = 'chat-session'; flush() }, text: () => textarea().props.value, contextual, plain, consumed, choices,
    settings: () => settings, attachment: () => attachment, accept: pending.resolve, reject,
    replace: (next: WorkflowAttachment, nextSession = session) => { attachment = next; session = nextSession; flush() } }
}

test('реальная welcome suggestion заполняет поле, фокусирует его и не отправляет', async (context) => {
  const f = await panelFixture(context)
  f.open(true)
  const focusBefore = f.focuses()
  const create = f.harness.find((node) => node.type === 'button' && Array.isArray(node.props.children) && node.props.children.includes(t('shell.assistant.workflowCreate')))
  ;(create.props.onClick as () => void)(); f.flush()
  assert.equal(f.text(), t('shell.assistant.suggestion.workflow.prompt'))
  assert.ok(f.focuses() > focusBefore)
  assert.equal(f.attachment(), null)
  assert.deepEqual(f.contextual, [])
  assert.deepEqual(f.plain, [])
})

test('загрузка истории не задерживает предложение создания и не стирает введённые требования', async (context) => {
  const snapshot = deferred()
  const f = await panelFixture(context, 'chat', false, snapshot.promise)
  f.open(true)
  const focusBefore = f.focuses()
  const create = f.harness.find((node) => node.type === 'button' && Array.isArray(node.props.children) && node.props.children.includes(t('shell.assistant.workflowCreate')))
  ;(create.props.onClick as () => void)(); f.flush()
  const immediately = f.text()
  const focusedImmediately = f.focuses()
  f.edit('My stages and checks')
  snapshot.resolve(); await tick(); f.flush()
  assert.equal(f.text(), 'My stages and checks')
  assert.equal(immediately, t('shell.assistant.suggestion.workflow.prompt'))
  assert.deepEqual(f.applied, [20])
  assert.ok(focusedImmediately > focusBefore)
  assert.deepEqual(f.contextual, [])
  assert.deepEqual(f.plain, [])
})

test('реальный composer применяет запрос один раз и сохраняет последующие пользовательские правки', async (context) => {
  const f = await panelFixture(context)
  f.detach(); f.open(true)
  f.prefill({ nonce: 20, text: 'Create a workflow' })
  assert.equal(f.text(), 'Create a workflow')
  f.edit('My requirements'); f.open(true); f.open(false); f.open(true); f.flush()
  f.prefill({ nonce: 20, text: 'Create a workflow' })
  assert.equal(f.text(), 'My requirements')
  assert.deepEqual(f.applied, [20])
  f.prefill({ nonce: 21, text: 'Create another workflow' })
  assert.equal(f.text(), 'Create another workflow')
  f.edit('Latest requirements')
  f.prefill({ nonce: 20, text: 'Stale creation' })
  assert.equal(f.text(), 'Latest requirements')
  assert.deepEqual(f.applied, [20, 21])
})

test('реальный composer держит terminal prefill до появления чат-агента без create chip', async (context) => {
  const f = await panelFixture(context, 'terminal')
  f.detach(); f.open(true)
  f.prefill({ nonce: 20, text: 'Create a workflow' })
  assert.deepEqual(f.applied, [])
  f.chat(); await tick(); f.flush()
  assert.equal(f.text(), 'Create a workflow')
  assert.deepEqual(f.applied, [20])
  assert.equal(f.attachment(), null)
  assert.deepEqual(f.contextual, [])
  assert.deepEqual(f.plain, [])
})

test('закрытая панель сохраняет поздний terminal prefill до следующего открытия', async (context) => {
  const f = await panelFixture(context, 'terminal')
  f.detach(); f.prefill({ nonce: 20, text: 'Deferred creation' })
  f.chat(); await tick(); f.flush()
  assert.deepEqual(f.applied, [])
  assert.equal(f.text(), '')
  f.open(true)
  assert.equal(f.text(), 'Deferred creation')
  assert.deepEqual(f.applied, [20])
})

test('реальная кнопка X удаляет чип и возврат, сохраняя текст и текущую дискуссию', async (context) => {
  const app = workflowEntryFixture()
  const f = await panelFixture(context, 'chat', true)
  f.connect(app); f.edit('Keep my draft')
  const message = () => f.harness.find((node) => typeof node.type === 'function' && (node.props.message as { text?: string } | undefined)?.text === 'Existing discussion').props.message
  const before = message()
  const detach = f.harness.find((node) => node.type === 'button' && node.props.title === t('shell.assistant.workflowDetach'))
  ;(detach.props.onClick as () => void)(); f.flush()
  assert.equal(f.text(), 'Keep my draft')
  assert.equal(message(), before)
  assert.equal(app.destination(), null)
  assert.equal(app.choice(), null)
  assert.throws(() => f.harness.find((node) => node.props.className === 'chat-workflow-chip'))
  assert.throws(() => f.harness.find((node) => node.type === 'button' && node.props.children === t('shell.assistant.workflowReturn')))
  app.rail(); f.flush()
  assert.equal(f.text(), 'Keep my draft')
  assert.equal(message(), before)
})

test('реальный App поздний composer ACK не снимает новый запрос', () => {
  const f = workflowEntryFixture()
  f.create(); const previous = f.request()!.nonce
  f.create(); const next = f.request()!.nonce
  assert.notEqual(next, previous)
  // Callback вызывается так же, как effect Panel после изменения props.
  const current = { value: f.request() }
  const ack = jsxHandler(new URL('./App.tsx', import.meta.url), 'AssistantPanel', 'onComposerRequestApplied', {
    setWorkflowComposerRequest: (update: (request: typeof current.value) => typeof current.value) => { current.value = update(current.value) }
  })
  ack(previous)
  assert.equal(current.value?.nonce, next)
  ack(next)
  assert.equal(current.value, null)
})

test('реальный Panel send сохраняет compose и nonce до acceptance и при rejection', async (context) => {
  const f = await panelFixture(context)
  f.edit('Workflow request'); f.send()
  assert.equal(f.contextual.length, 1)
  assert.equal(f.text(), 'Workflow request')
  assert.equal(f.attachment()?.nonce, 7)
  assert.deepEqual(f.consumed, [])
  f.reject(new Error('Turn rejected by configured policy')); await tick(); f.flush()
  assert.equal(f.text(), 'Workflow request')
  assert.equal(f.attachment()?.nonce, 7)
  assert.deepEqual(f.consumed, [])
  assert.ok(f.harness.find((node) => node.props.className === 'chat-failure').props.children)
})

test('реальный Panel consume после acceptance ровно один раз; следующая отправка plain', async (context) => {
  const f = await panelFixture(context)
  f.edit('Workflow request'); f.send(); f.accept(); await tick(); f.flush()
  assert.equal(f.text(), '')
  assert.equal(f.attachment(), null)
  assert.deepEqual(f.consumed, [7])
  f.edit('Follow up'); f.send(); await tick(); f.flush()
  assert.equal(f.contextual.length, 1)
  assert.deepEqual(f.plain, ['Follow up'])
})

for (const [nextSession, nextNonce] of [['panel-session', 8], ['another-session', 7]] as const) {
test(`реальный Panel late acceptance сохраняет compose/attachment: ${nextSession}, nonce ${nextNonce}`, async (context) => {
  const f = await panelFixture(context)
  f.edit('Workflow request'); f.send()
  f.replace({ nonce: nextNonce, context: { mode: 'create' } }, nextSession)
  await tick(); f.flush()
  assert.equal(f.text(), 'Workflow request')
  f.edit('New discussion')
  f.accept(); await tick(); f.flush()
  assert.equal(f.text(), 'New discussion')
  assert.equal(f.attachment()?.nonce, nextNonce)
  assert.deepEqual(f.consumed, [])
})
}

test('реальный terminal choice handler отделён от обычных настроек и сохраняет attachment', async (context) => {
  const f = await panelFixture(context, 'terminal')
  ;(f.harness.find((node) => node.type === 'button' && node.props.children === t('shell.assistant.chooseChatAgent')).props.onClick as () => void)()
  assert.deepEqual(f.choices, ['panel-session:shell'])
  assert.equal(f.settings(), 0)
  ;(f.harness.find((node) => node.type === 'button' && node.props.title === t('shell.assistant.settings')).props.onClick as () => void)()
  assert.equal(f.settings(), 1)
  assert.equal(f.attachment()?.nonce, 7)
})

test('реальный Save завершает запись D до обновления props, не откатывая его к A', async () => {
  const write = deferred(); const f = fixture(() => write.promise)
  const d = titled(f.graph(), 'saved-D'); f.edit(d)
  ;(f.button('config.wf.tab.save').props.onClick as () => void)(); f.flush()
  write.resolve(); await tick(); f.flush()
  assert.deepEqual(f.graph(), d)
  assert.equal(f.conflict(), false)
  assert.equal(f.button('config.wf.tab.save').props.disabled, true)
  f.harness.dispose()
})

test('реальный conflict Revert handler открывает свежий B и разрешает дальнейшую правку', () => {
  const f = fixture(async () => {})
  const a = f.graph(); const b = titled(a, 'external-B')
  f.edit(titled(a, 'dirty-D')); f.incoming(b)
  const revert = f.button('config.wf.tab.revert')
  assert.equal(revert.props.disabled, false)
  ;(revert.props.onClick as () => void)(); f.flush()
  assert.deepEqual(f.graph(), b)
  assert.equal(f.conflict(), false)
  f.edit(titled(b, 'next-D'))
  assert.equal(f.button('config.wf.tab.save').props.disabled, false)
  f.harness.dispose()
})

test('реальный pending Save принимает D после семантически равной копии A', async () => {
  const write = deferred()
  const f = fixture(() => write.promise)
  const a = f.graph(); const d = titled(a, 'saved-D')
  f.edit(d)
  ;(f.button('config.wf.tab.save').props.onClick as () => void)(); f.flush()
  f.incoming(structuredClone(a))
  write.resolve(); await tick(); f.flush()
  assert.deepEqual(f.graph(), d)
  assert.equal(f.conflict(), false)
  assert.equal(f.button('config.wf.tab.save').props.disabled, true)
  f.incoming(structuredClone(a))
  assert.deepEqual(f.graph(), d)
  f.harness.dispose()
})

test('реальный pending Reset принимает default после семантически равной копии custom A', async () => {
  const write = deferred()
  const f = fixture(() => write.promise)
  const next = f.graph(); const a = titled(next, 'own-A'); f.incoming(a)
  const reset = f.harness.find((node) => node.type === 'button' && node.props.className === 'btn-sm danger' && node.props.disabled === false)
  ;(reset.props.onClick as () => void)(); f.flush()
  ;(f.button('config.wf.tab.reset').props.onClick as () => void)(); f.flush()
  f.incoming(structuredClone(a))
  write.resolve(); await tick(); f.flush()
  assert.deepEqual(f.graph(), next)
  assert.equal(f.conflict(), false)
  assert.equal(f.button('config.wf.tab.save').props.disabled, true)
  f.incoming(structuredClone(a))
  assert.deepEqual(f.graph(), next)
  f.harness.dispose()
})

test('реальный pending Save сохраняет приоритет изменённого B, затем нового A', async () => {
  const write = deferred(); const f = fixture(() => write.promise)
  const a = f.graph(); const d = titled(a, 'saved-D'); const b = titled(a, 'external-B')
  f.edit(d)
  ;(f.button('config.wf.tab.save').props.onClick as () => void)(); f.flush()
  f.incoming(b); f.incoming(structuredClone(a))
  write.resolve(); await tick(); f.flush()
  assert.deepEqual(f.graph(), a)
  assert.equal(f.conflict(), false)
  f.harness.dispose()
})

test('реальный второй pending Save не считает props подтверждённого D новым графом', async () => {
  const second = deferred(); let writes = 0
  const f = fixture(() => ++writes === 1 ? Promise.resolve() : second.promise)
  const d = titled(f.graph(), 'saved-D')
  f.edit(d)
  ;(f.button('config.wf.tab.save').props.onClick as () => void)(); await tick(); f.flush()
  const e = titled(d, 'saved-E'); f.edit(e)
  ;(f.button('config.wf.tab.save').props.onClick as () => void)(); f.flush()
  f.incoming(structuredClone(d))
  second.resolve(); await tick(); f.flush()
  assert.deepEqual(f.graph(), e)
  assert.equal(f.conflict(), false)
  assert.equal(f.button('config.wf.tab.save').props.disabled, true)
  f.harness.dispose()
})

/** Связывает настоящие modal/pane/editor/hook с main-моделью; подменена только граница IPC и DOM. */
async function settingsWorkflowFixture(context: TestContext, initial: core.Workflow, restore?: Extract<WorkflowAssistantContext, { mode: 'edit' }>) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-workflow-handlers-'))
  writeFileSync(join(dir, 'projects.json'), JSON.stringify({ version: PROJECTS_FILE_VERSION, projects: [], activeId: null, taskTypesSeeded: true,
    taskTypes: [{ id: 'mine', title: 'Workflow', settings: { roles: core.DEFAULT_ROLES, workflow: initial } }] }))
  const pm = new ProjectManager(dir)
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const storage = new Map<string, string>()
  let afterWrite = () => {}
  let beforeWrite = async () => {}
  let reloadFailure = false
  let afterList: () => void | Promise<void> = () => {}
  let listed: core.Workflow | undefined
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener: () => {}, removeEventListener: () => {}, orca: {
    taskTypes: { list: async () => {
      if (reloadFailure) throw new Error('List unavailable')
      const state = pm.taskTypesState()
      listed = state.taskTypes.find((type) => type.id === 'mine')?.settings.workflow
      return state
    } },
    workflowAssistant: { save: async (id: string, baseline: core.Workflow, workflow: core.Workflow | null) => {
      await beforeWrite()
      saveWorkflowDraft(pm, id, baseline, workflow)
      afterWrite()
    } },
    app: { getSettings: async () => null }, projects: { list: async () => ({ projects: [] }) }
  } } })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) } } })
  const imports = { '@orca-board/core': core, '../useAutoSave': { ipcErrorMessage }, '../taskTypeEdit': taskTypeEdit, '../workflowAssistant': workflowAssistant }
  const hookHarness = componentHarness(new URL('./settings/useTaskTypes.ts', import.meta.url), 'useTaskTypes', imports)
  const changed = async () => { await afterList() }
  const hookProps = changed as unknown as Record<string, unknown>
  let hook = hookHarness.flush(hookProps) as unknown as TaskTypesHook
  await tick()
  hook = hookHarness.flush(hookProps) as unknown as TaskTypesHook
  const icons = { Icon: new Proxy({}, { get: (_target, key) => `icon-${String(key)}` }) }
  const templates = { templates: [], reload: async () => {} }
  const modal = componentHarness(new URL('./settings/SettingsModal.tsx', import.meta.url), 'SettingsModal', {
    '../workflowAssistant': workflowAssistant, '@orca-board/core': core, '../icons': icons, '../useAutoSave': { ipcErrorMessage },
    '../about/parts': { NavItem: 'nav', storeSection: (key: string, value: string) => { storage.set(key, value) } }, '../taskTypeEdit': taskTypeEdit,
    './GeneralSection': { GeneralSection: 'general' }, './AppearanceSection': { AppearanceSection: 'appearance' },
    './NotificationsSection': { NotificationsSection: 'notifications' }, './UpdatesSection': { UpdatesSection: 'updates' },
    './AssistantSection': { AssistantSection: 'assistant' }, './NodeTemplatesSection': { NodeTemplatesSection: 'nodes' },
    './useNodeTemplates': { useNodeTemplates: () => templates }, './TaskTypePane': { TaskTypePane: 'pane' }, './useTaskTypes': { useTaskTypes: () => hook },
    '../i18n': { useT: () => t }, '../appSettingsSave': { saveAppSettings: async () => ({}) }, '../assistantSettings': { assistantSavePatch },
    '../extraArgsHints': { extraArgsSupported }, '../defaultTitles': defaultTitles, '../updateState': { versionLabel }, '../PopupMenu': { PopupMenu: 'popup' }
  })
  const pane = componentHarness(new URL('./settings/TaskTypePane.tsx', import.meta.url), 'TaskTypePane', {
    '@orca-board/core': core, '../RolesEditor': { RolesEditor: 'roles' }, '../icons': icons, '../useAutoSave': { ipcErrorMessage },
    '../agentRules': { agentRulesPlaceholder: () => '' }, '../about/parts': { SectionHead: 'head' }, '../i18n': { useT: () => t },
    '../about/PermissionsSection': { PermissionsSection: 'permissions', permissionParts: () => ({ title: '' }) },
    '../taskTypeEdit': taskTypeEdit, './TaskTypeWorkflow': { TaskTypeWorkflow: 'workflow' }, '../defaultTitles': defaultTitles
  })
  let editor: ReturnType<typeof workflowHarness> | undefined
  let editorKey: string | undefined
  let mounts = 0
  let sectionRequest: workflowAssistant.WorkflowSectionRequest = { section: 'type:mine', nonce: 7, tab: 'workflow', restore }
  const noop = () => {}
  function flush(): void {
    // Effects дочернего редактора могут потребить запрос в modal без его перемонтирования.
    for (let pass = 0; pass < 3; pass++) {
      hook = hookHarness.flush(hookProps) as unknown as TaskTypesHook
      modal.flush({ sectionRequest, agents: [], updates: { state: null }, onProjectsChanged: changed, onRunOnboarding: noop, onClose: noop,
        onWorkflowAssistant: noop, workflowHandoff: false, onWorkflowAgentSelected: noop })
      pane.flush(modal.find((node) => node.type === 'pane').props)
      let child
      try { child = pane.find((node) => node.type === 'workflow') } catch { editor?.dispose(); editor = undefined; editorKey = undefined; continue }
      if (!editor || editorKey !== child.key) { editor?.dispose(); editor = workflowHarness(); editorKey = child.key; mounts++ }
      editor.flush(child.props)
    }
  }
  const button = (key: Parameters<typeof t>[0]) => editor!.find((node) => node.type === 'button' && node.props.children === t(key))
  const graph = () => editor!.find((node) => node.type === 'canvas').props.workflow as core.Workflow
  const conflict = () => { try { editor!.find((node) => node.props.role === 'alert' && node.props.children === t('config.wf.tab.externalConflict')); return true } catch { return false } }
  function tab(id: taskTypeEdit.TaskTypeTab): void {
    const label = t(id === 'roles' ? 'config.taskType.tab.roles' : 'config.taskType.tab.workflow')
    const node = pane.find((node) => node.props.role === 'tab' && Array.isArray(node.props.children) && node.props.children[0] === label)
    ;(node.props.onClick as () => void)(); flush()
  }
  context.after(() => {
    editor?.dispose(); pane.dispose(); modal.dispose(); hookHarness.dispose(); rmSync(dir, { recursive: true, force: true })
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window')
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage); else Reflect.deleteProperty(globalThis, 'localStorage')
  })
  flush(); await tick(); flush()
  return { pm, flush, button, graph, conflict, tab, mounts: () => mounts, hook: () => hook, listed: () => listed,
    persisted: () => new ProjectManager(dir).workflowGet('mine').workflow,
    beginReset: () => {
      const reset = editor!.find((node) => node.type === 'button' && node.props.className === 'btn-sm danger' && node.props.disabled === false)
      ;(reset.props.onClick as () => void)(); flush()
    },
    edit: (workflow: core.Workflow) => { (editor!.find((node) => node.type === 'canvas').props.onChange as (value: core.Workflow) => void)(workflow); flush() },
    beforeWrite: (callback: () => Promise<void>) => { beforeWrite = callback },
    afterWrite: (callback: () => void) => { afterWrite = callback }, afterList: (callback: () => void | Promise<void>) => { afterList = callback },
    failReload: () => { reloadFailure = true },
    returnAgain: (next: Extract<WorkflowAssistantContext, { mode: 'edit' }>) => { sectionRequest = { section: 'type:mine', nonce: 8, tab: 'workflow', restore: next }; flush() } }
}

test('новый Return nonce восстанавливает новый снимок после потребления предыдущего', async (context) => {
  const a = titled(core.defaultWorkflow(core.DEFAULT_ROLES), 'saved-A')
  const first = { mode: 'edit' as const, typeId: 'mine', title: 'Workflow', workflow: titled(a, 'returned-D'), baseline: a, dirty: true, path: [] }
  const f = await settingsWorkflowFixture(context, a, first)
  ;(f.button('config.wf.tab.revert').props.onClick as () => void)(); f.flush()
  f.tab('roles'); f.tab('workflow')
  const next = { ...first, workflow: titled(a, 'returned-E') }
  f.returnAgain(next)
  assert.deepEqual(f.graph(), next.workflow)
  assert.equal(f.mounts(), 3)
  assert.equal(f.button('config.wf.tab.save').props.disabled, false)
})

for (const action of ['save', 'reset'] as const) {
  test(`реальный hook/main ${action} подтверждает запись при equal-copy A до записи и недоступном post-write перечите`, async (context) => {
    const a = titled(core.defaultWorkflow(core.DEFAULT_ROLES), 'saved-A')
    const f = await settingsWorkflowFixture(context, a)
    const d = titled(a, 'local-D')
    const pending = deferred()
    f.beforeWrite(() => pending.promise)
    f.afterList(() => f.flush())
    if (action === 'save') {
      f.edit(d)
      ;(f.button('config.wf.tab.save').props.onClick as () => void)(); f.flush()
    } else {
      f.beginReset()
      ;(f.button('config.wf.tab.reset').props.onClick as () => void)(); f.flush()
    }
    await f.hook().reload(); f.flush()
    assert.deepEqual(f.pm.workflowGet('mine').workflow, a, 'равный перечит произошёл до реальной записи')
    f.failReload(); pending.resolve(); await tick(); f.flush()
    const expected = action === 'save' ? d : core.defaultWorkflow(core.DEFAULT_ROLES)
    assert.deepEqual(f.persisted(), expected)
    assert.deepEqual(f.graph(), expected)
    assert.equal(f.conflict(), false)
    assert.equal(f.button('config.wf.tab.save').props.disabled, true)
    assert.match(f.hook().error ?? '', /List unavailable/)
  })

  for (const returnsToA of [false, true]) {
    test(`реальный hook/main ${action}: перечит ${returnsToA ? 'B→A' : 'B'} после post-write snapshot имеет приоритет`, async (context) => {
      const a = titled(core.defaultWorkflow(core.DEFAULT_ROLES), 'saved-A')
      const b = titled(a, 'external-B')
      const f = await settingsWorkflowFixture(context, a)
      const d = titled(a, 'local-D')
      f.afterList(async () => {
        f.flush()
        f.pm.workflowSet('mine', f.pm.workflowGet('mine').revision, b)
        await f.hook().reload(); f.flush()
        if (returnsToA) {
          f.pm.workflowSet('mine', f.pm.workflowGet('mine').revision, a)
          await f.hook().reload(); f.flush()
        }
      })
      if (action === 'save') {
        f.edit(d)
        ;(f.button('config.wf.tab.save').props.onClick as () => void)(); f.flush()
      } else {
        f.beginReset()
        ;(f.button('config.wf.tab.reset').props.onClick as () => void)(); f.flush()
      }
      await tick(); f.flush()
      const expected = returnsToA ? a : b
      assert.deepEqual(f.persisted(), expected)
      assert.deepEqual(f.graph(), expected)
      assert.equal(f.conflict(), false)
      assert.equal(f.button('config.wf.tab.save').props.disabled, true)
    })
  }
}

for (const action of ['revert', 'save', 'reset'] as const) {
  test(`Return → ${action} → Roles → Workflow не применяет прежний restore повторно`, async (context) => {
    const a = titled(core.defaultWorkflow(core.DEFAULT_ROLES), 'saved-A')
    const d = titled(a, 'returned-D')
    const saved = action === 'revert' ? titled(a, 'external-B') : a
    const f = await settingsWorkflowFixture(context, saved, { mode: 'edit', typeId: 'mine', title: 'Workflow', workflow: d, baseline: a, dirty: true, path: [] })
    assert.deepEqual(f.graph(), d, 'потребление restore должно сохранить восстановленный dirty draft')
    assert.equal(f.mounts(), 1, 'потребление restore не меняет key редактора')
    if (action === 'reset') {
      f.beginReset()
      ;(f.button('config.wf.tab.reset').props.onClick as () => void)(); f.flush()
    } else {
      ;(f.button(action === 'save' ? 'config.wf.tab.save' : 'config.wf.tab.revert').props.onClick as () => void)(); f.flush()
    }
    await tick(); f.flush()
    const expected = action === 'save' ? d : action === 'reset' ? core.defaultWorkflow(core.DEFAULT_ROLES) : saved
    assert.deepEqual(f.pm.workflowGet('mine').workflow, expected)
    assert.deepEqual(f.graph(), expected)
    f.tab('roles'); f.tab('workflow')
    assert.deepEqual(f.graph(), expected, 'новый mount принимает сохранённый граф, а не старый снимок')
    assert.equal(f.conflict(), false)
    assert.equal(f.button('config.wf.tab.save').props.disabled, true)
  })
}

for (const action of ['save', 'reset'] as const) {
  test(`реальный hook/main ${action} принимает post-write A после внешней записи поверх D/default`, async (context) => {
    const a = titled(core.defaultWorkflow(core.DEFAULT_ROLES), 'saved-A')
    const f = await settingsWorkflowFixture(context, a)
    const d = titled(a, 'local-D')
    let localWritten: core.Workflow | undefined
    f.afterWrite(() => {
      localWritten = f.pm.workflowGet('mine').workflow
      f.pm.workflowSet('mine', f.pm.workflowGet('mine').revision, a)
    })
    f.afterList(() => f.flush())
    if (action === 'save') {
      f.edit(d)
      ;(f.button('config.wf.tab.save').props.onClick as () => void)(); f.flush()
    } else {
      f.beginReset()
      ;(f.button('config.wf.tab.reset').props.onClick as () => void)(); f.flush()
    }
    await tick(); f.flush()
    assert.deepEqual(localWritten, action === 'save' ? d : core.defaultWorkflow(core.DEFAULT_ROLES))
    assert.deepEqual(f.listed(), a)
    assert.deepEqual(f.hook().state?.taskTypes.find((type) => type.id === 'mine')?.settings.workflow, a)
    assert.deepEqual(f.persisted(), a)
    assert.deepEqual(f.pm.workflowGet('mine').workflow, a)
    assert.deepEqual(f.graph(), a, 'авторитетный post-write перечит имеет приоритет даже при равенстве исходной базе')
    assert.equal(f.conflict(), false)
    assert.equal(f.button('config.wf.tab.save').props.disabled, true)
    await f.hook().reload(); f.flush()
    assert.deepEqual(f.graph(), a)
  })
}
