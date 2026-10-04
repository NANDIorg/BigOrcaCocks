import { getUiApi } from '@orca-board/ui/modules/host'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

export interface TestNode { type: unknown; props: Record<string, unknown>; key?: string }
interface Slot { value: unknown; dependencies?: readonly unknown[]; cleanup?: () => void }

/** Выполняет реальные handlers/effects компонента без DOM, браузера и обхода экранов. */
export function componentHarness(source: URL, exportName: string, imports: Record<string, unknown>) {
  const slots: Slot[] = []
  let cursor = 0
  let changed = true
  let props: Record<string, unknown> = {}
  let root: TestNode
  let effects: (() => void)[] = []
  const same = (a?: readonly unknown[], b?: readonly unknown[]): boolean => a !== undefined && b !== undefined && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const react = {
    Fragment: 'fragment',
    useState(initial: unknown) {
      const index = cursor++
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? (initial as () => unknown)() : initial }
      return [slots[index].value, (next: unknown) => {
        const value = typeof next === 'function' ? (next as (old: unknown) => unknown)(slots[index].value) : next
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; changed = true }
      }]
    },
    useRef(initial: unknown) {
      const index = cursor++
      slots[index] ??= { value: { current: initial } }
      return slots[index].value
    },
    useMemo(make: () => unknown, dependencies: readonly unknown[]) {
      const index = cursor++
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) slots[index] = { value: make(), dependencies }
      return slots[index].value
    },
    useCallback(callback: unknown, dependencies: readonly unknown[]) { return react.useMemo(() => callback, dependencies) },
    useEffect(effect: () => void | (() => void), dependencies?: readonly unknown[]) {
      const index = cursor++
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) {
        const old = slots[index]
        slots[index] = { value: undefined, dependencies }
        effects.push(() => { old?.cleanup?.(); const cleanup = effect(); if (cleanup) slots[index].cleanup = cleanup })
      }
    }
  }
  const jsx = (type: unknown, values: Record<string, unknown>, key?: string): TestNode => ({ type, props: values, key })
  const output = ts.transpileModule(readFileSync(source, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const module = { exports: {} as Record<string, unknown> }
  const require = (id: string): unknown => {
    if (id === './host' || id === '../host') return { getUiApi }
    if (id === 'react') return { ...react, useLayoutEffect: react.useEffect }
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' }
    if (!(id in imports)) throw new Error(`Не задан импорт тестового компонента: ${id}`)
    return imports[id]
  }
  new Function('require', 'module', 'exports', output)(require, module, module.exports)
  const component = module.exports[exportName] as (values: Record<string, unknown>) => TestNode
  function flush(next = props): TestNode {
    props = next
    changed = true
    for (let pass = 0; changed; pass++) {
      if (pass > 30) throw new Error('Effects не стабилизировались')
      changed = false
      cursor = 0
      effects = []
      root = component(props)
      for (const effect of effects) effect()
    }
    return root
  }
  function find(predicate: (node: TestNode) => boolean): TestNode {
    const walk = (value: unknown): TestNode | undefined => {
      if (Array.isArray(value)) { for (const item of value) { const found = walk(item); if (found) return found }; return }
      if (value === null || typeof value !== 'object' || !('type' in value) || !('props' in value)) return
      const node = value as TestNode
      return predicate(node) ? node : walk(node.props.children)
    }
    const found = walk(root)
    if (!found) throw new Error('Элемент не найден в дереве компонента')
    return found
  }
  return { flush, find, dispose: () => { for (const slot of slots) slot.cleanup?.() } }
}

/** Извлекает фактический JSX callback, сохраняя его closure через заданные зависимости. */
export function jsxHandler(source: URL, component: string, event: string, bindings: Record<string, unknown>, where?: { attribute: string; expression: string }): (...values: unknown[]) => unknown {
  const file = ts.createSourceFile(source.pathname, readFileSync(source, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let handler: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(file) === component
      && (!where || node.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(file) === where.attribute && attribute.initializer?.getText(file) === where.expression))) {
      for (const attribute of node.attributes.properties) {
        if (ts.isJsxAttribute(attribute) && attribute.name.getText(file) === event && attribute.initializer && ts.isJsxExpression(attribute.initializer)) handler = attribute.initializer.expression
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (!handler || !ts.isArrowFunction(handler)) throw new Error(`Не найден callback ${component}.${event}`)
  const output = ts.transpileModule(`module.exports = ${handler.getText(file)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: undefined as unknown }
  const scope = { getUiApi, ...bindings }
  new Function(...Object.keys(scope), 'module', output)(...Object.values(scope), module)
  return module.exports as (...values: unknown[]) => unknown
}

/** Выполняет настоящий именованный обработчик с явно заданными зависимостями замыкания. */
export function namedHandler(source: URL, name: string, bindings: Record<string, unknown>): (...values: unknown[]) => unknown {
  const file = ts.createSourceFile(source.pathname, readFileSync(source, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let handler: ts.FunctionDeclaration | ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) handler = node
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name && node.initializer) handler = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (!handler) throw new Error(`Не найден обработчик ${name}`)
  const output = ts.transpileModule(`module.exports = ${handler.getText(file)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: undefined as unknown }
  const scope = { getUiApi, ...bindings }
  new Function(...Object.keys(scope), 'module', output)(...Object.values(scope), module)
  return module.exports as (...values: unknown[]) => unknown
}
