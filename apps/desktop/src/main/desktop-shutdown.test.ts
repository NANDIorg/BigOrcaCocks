import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'

// Проверяем production lifecycle с отложенным native exit, без Electron окон и live profile.
const source = ts.createSourceFile('index.ts', readFileSync(new URL('./index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
function javascript(code: string): string {
  return ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
}
function setup() {
  let nativeExit!: () => void; let ownerExit!: () => void
  const native = new Promise<void>(resolve => { nativeExit = resolve })
  const owner = new Promise<void>(resolve => { ownerExit = resolve })
  let handler: (event: { preventDefault(): void }) => void = () => { throw new Error('before-quit отсутствует') }
  let allowed = 0
  const state = { quitting: false, exitAllowed: false, projects: {},
    cleanupDesktop: () => { state.quitting = true; return native },
    desktopRuntime: { stop: () => owner }, updater: { installOnQuit: () => false }, console,
    requestQuit: () => { throw new Error('Второй запрос не должен повторять cleanup') },
    app: { on: (_event: string, callback: typeof handler) => { handler = callback }, quit: () => {
      let prevented = false; handler({ preventDefault: () => { prevented = true } }); if (!prevented) allowed++
    } }
  }
  const context = createContext(state)
  let updaterQuit: ts.Expression | undefined
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'quitNow') runInContext(javascript(node.getText(source)), context)
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'app.on' && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'before-quit') runInContext(javascript(node.getText(source)), context)
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'createUpdater') {
      const options = node.arguments[0] as ts.ObjectLiteralExpression
      const host = options.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source) === 'host') as ts.PropertyAssignment
      const quit = (host.initializer as ts.ObjectLiteralExpression).properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source) === 'quit') as ts.PropertyAssignment
      updaterQuit = quit.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(source); assert.ok(updaterQuit)
  const update = runInContext(javascript(`(${updaterQuit.getText(source)})`), context) as () => void
  return { state, nativeExit, ownerExit, attempt: state.app.quit, allowed: () => allowed,
    quit: () => runInContext('quitNow()', context) as Promise<void>, update }
}
for (const mode of ['normal', 'updater'] as const) test(`повторный quit (${mode}) ждёт native exit и освобождения owner`, async () => {
  const host = setup()
  const pending = mode === 'normal' ? host.quit() : (host.state.quitting = true, host.update(), undefined)
  host.attempt(); assert.equal(host.allowed(), 0)
  host.nativeExit(); await new Promise(resolve => setImmediate(resolve))
  host.attempt(); assert.equal(host.allowed(), 0)
  host.ownerExit(); await pending; await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.allowed(), 1)
})
