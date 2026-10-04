import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'

// Исполняем именно production callbacks; Electron window effects заменены без запуска GUI.
const source = ts.createSourceFile('index.ts', readFileSync(new URL('./index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
function findCall(predicate: (node: ts.CallExpression) => boolean): ts.CallExpression {
  let result: ts.CallExpression | undefined
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && predicate(node)) result = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(result, 'production callback отсутствует')
  return result
}
const registration = findCall(node => ts.isPropertyAccessExpression(node.expression)
  && node.expression.expression.getText(source) === 'app' && node.expression.name.text === 'on'
  && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'second-instance')
const bootstrap = findCall(node => ts.isIdentifier(node.expression) && node.expression.text === 'startProfileRuntime')
function javascript(code: string): string {
  return ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
}

function desktop() {
  let handler: () => void = () => { throw new Error('second-instance handler не зарегистрирован') }
  let shows = 0
  let initialized = false
  const failures: unknown[] = []
  const trace: string[] = []
  const state = {
    desktopInitialized: false, quitting: false,
    app: { isReady: () => true, getPath: () => '/unused', on: (_event: string, callback: () => void) => { handler = callback } },
    initializeEffectJournal: () => { trace.push('journal') },
    initializeDesktop: () => { trace.push('desktop'); initialized = true },
    failDesktopStartup: (error: unknown) => { failures.push(error); state.quitting = true },
    showWindow: () => {
      if (!initialized) throw new TypeError('projects ещё не создан')
      shows++
    }
  }
  const context = createContext(state)
  runInContext(javascript(registration.getText(source)), context)
  const options = runInContext(javascript(`(${bootstrap.arguments[0].getText(source)})`), context) as { start(context: { dataDir: string; owner: { instanceId: string } }): Promise<void> }
  return { state, failures, trace, start: () => options.start({ dataDir: '/unused', owner: { instanceId: 'test' } }), activate: () => handler(), shows: () => shows }
}

test('second-instance между Electron ready и приобретением profile не создаёт окно', () => {
  const host = desktop()
  assert.doesNotThrow(host.activate)
  assert.equal(host.shows(), 0)
})

test('second-instance во время initializer ждёт готовность; после startup фокусирует окно', async () => {
  const host = desktop()
  const initialize = host.state.initializeDesktop
  host.state.initializeDesktop = () => { host.activate(); initialize() }
  await host.start()
  assert.equal(host.shows(), 0)
  host.activate()
  assert.equal(host.shows(), 1)
  assert.deepEqual(host.failures, [])
  assert.deepEqual(host.trace, ['journal', 'desktop'])
})

test('second-instance после запроса quit не создаёт окно даже у готового Desktop', async () => {
  const host = desktop()
  await host.start()
  host.state.quitting = true
  host.activate()
  assert.equal(host.shows(), 0)
})

test('ошибка initializer оставляет activation закрытой и передаёт исходную причину', async () => {
  const host = desktop()
  const error = new Error('failed initialization')
  host.state.initializeDesktop = () => { throw error }
  await assert.rejects(host.start, value => value === error)
  assert.deepEqual(host.failures, [error])
  assert.doesNotThrow(host.activate)
  assert.equal(host.shows(), 0)
})

test('journal preflight failure не вызывает Desktop initializer/backup', async () => {
  const host = desktop(); const error = new Error('future journal')
  host.state.initializeEffectJournal = () => { throw error }
  await assert.rejects(host.start, value => value === error)
  assert.deepEqual(host.trace, []); assert.deepEqual(host.failures, [error])
})
