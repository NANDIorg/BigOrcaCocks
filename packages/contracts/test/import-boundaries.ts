import { builtinModules } from 'node:module'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

export interface ContractBoundaryIssue {
  file: string
  specifier: string
  reason: 'node' | 'electron' | 'desktop' | 'outside' | 'dynamic'
}

const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')))
const options: ts.CompilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  resolveJsonModule: true,
  allowImportingTsExtensions: true
}

const within = (file: string, root: string): boolean => file === root || file.startsWith(root + sep)
const canonical = (file: string): string => existsSync(file) ? realpathSync(file) : resolve(file)
const isTest = (file: string): boolean => /(?:^|[/\\])tests?(?:[/\\]|$)|\.test\.[cm]?[jt]sx?$/.test(file)

/** Проверяет production graph, включая type-only edges; Node остаётся только в тестовом инструменте. */
export function auditContractImports(root: string, config?: { roots: string[]; packages: string[]; externals?: string[] }): ContractBoundaryIssue[] {
  const repo = canonical(root)
  const contracts = canonical(join(repo, 'packages/contracts/src'))
  const core = canonical(join(repo, 'packages/core/src'))
  const desktop = canonical(join(repo, 'apps/desktop'))
  const visited = new Set<string>()
  const allowed = config ? config.packages.map(name => canonical(join(repo, 'packages', name))) : [contracts, core]
  const issues: ContractBoundaryIssue[] = []
  const report = (file: string, specifier: string, reason: ContractBoundaryIssue['reason']): void => {
    issues.push({ file: relative(repo, file).split(sep).join('/'), specifier, reason })
  }

  const edge = (file: string, specifier: string): void => {
    if (specifier.startsWith('node:') || builtins.has(specifier)) {
      report(file, specifier, 'node')
      return
    }
    if (specifier === 'electron' || specifier.startsWith('electron/')) {
      report(file, specifier, 'electron')
      return
    }
    if (config?.externals?.some(name => specifier === name || specifier.startsWith(name + '/'))) return
    if (config && /\.(?:css|svg)(?:\?.*)?$/.test(specifier)) {
      if (specifier.startsWith('.')) {
        const target = canonical(resolve(join(file, '..'), specifier.split('?')[0]))
        if (!existsSync(target) || !allowed.some(root => within(target, root))) report(file, specifier, 'outside')
      } else if (!config.externals?.some(name => specifier.startsWith(name + '/'))) report(file, specifier, 'outside')
      return
    }
    if (specifier !== '@orca-board/core' && !(config && specifier.startsWith('@orca-board/') && config.packages.includes(specifier.split('/')[1])) && !specifier.startsWith('./') && !specifier.startsWith('../')) {
      report(file, specifier, 'outside')
      return
    }
    const resolved = specifier === '@orca-board/core' ? join(core, 'index.ts')
      : ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule?.resolvedFileName
    if (!resolved || !existsSync(resolved)) {
      report(file, specifier, 'outside')
      return
    }
    const target = canonical(resolved)
    if (within(target, desktop)) {
      report(file, specifier, 'desktop')
    } else if (!allowed.some(root => within(target, root)) || isTest(relative(repo, target))) {
      report(file, specifier, 'outside')
    } else if (!target.endsWith('.json')) {
      visit(target)
    }
  }

  const visit = (file: string): void => {
    if (visited.has(file)) return
    visited.add(file)
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const scan = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (ts.isStringLiteralLike(node.moduleSpecifier)) edge(file, node.moduleSpecifier.text)
        else report(file, node.moduleSpecifier.getText(source), 'dynamic')
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const argument = node.moduleReference.expression
        report(file, argument && ts.isStringLiteralLike(argument) ? argument.text : argument?.getText(source) ?? 'require', 'dynamic')
      } else if (ts.isImportTypeNode(node)) {
        if (ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) edge(file, node.argument.literal.text)
        else report(file, node.argument.getText(source), 'dynamic')
      } else if (ts.isCallExpression(node)) {
        const argument = node.arguments[0]
        const specifier = argument && ts.isStringLiteralLike(argument) ? argument.text : argument?.getText(source) ?? ''
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          if (argument && ts.isStringLiteralLike(argument)) edge(file, specifier)
          else report(file, specifier, 'dynamic')
        } else if ((ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
          (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'require')) {
          report(file, specifier, 'dynamic')
        }
      }
      ts.forEachChild(node, scan)
    }
    scan(source)
  }

  const collect = (directory: string): void => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, item.name)
      if (isTest(relative(contracts, file))) continue
      if (item.isSymbolicLink()) {
        const target = canonical(file)
        if (!allowed.some(root => within(target, root))) report(file, file, 'outside')
        else if (/\.[cm]?tsx?$/.test(item.name)) visit(target)
      } else if (item.isDirectory()) collect(file)
      else if (item.isFile() && /\.[cm]?tsx?$/.test(item.name)) visit(canonical(file))
    }
  }
  for (const root of config?.roots ?? ['packages/contracts/src']) collect(join(repo, root))
  return issues.sort((a, b) => a.file.localeCompare(b.file) || a.specifier.localeCompare(b.specifier) || a.reason.localeCompare(b.reason))
}
