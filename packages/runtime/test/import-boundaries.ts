import { builtinModules } from 'node:module'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

export interface RuntimeBoundaryIssue {
  file: string
  specifier: string
  reason: 'electron' | 'outside' | 'dynamic'
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

/** Проверяет весь runtime production graph; общие зависимости могут использовать Node, но не приложения. */
export function auditRuntimeImports(root: string): RuntimeBoundaryIssue[] {
  const repo = canonical(root)
  const contracts = canonical(join(repo, 'packages/contracts/src'))
  const core = canonical(join(repo, 'packages/core/src'))
  const runtime = canonical(join(repo, 'packages/runtime/src'))
  const visited = new Set<string>()
  const issues: RuntimeBoundaryIssue[] = []
  const report = (file: string, specifier: string, reason: RuntimeBoundaryIssue['reason']): void => {
    issues.push({ file: relative(repo, file).split(sep).join('/'), specifier, reason })
  }

  const edge = (file: string, specifier: string): void => {
    if (specifier.startsWith('node:') || builtins.has(specifier)) {
      return
    }
    if (specifier === 'electron' || specifier.startsWith('electron/')) {
      report(file, specifier, 'electron')
      return
    }
    if (specifier !== '@orca-board/core' && specifier !== '@orca-board/contracts' && !specifier.startsWith('./') && !specifier.startsWith('../')) {
      report(file, specifier, 'outside')
      return
    }
    const resolved = specifier === '@orca-board/core' ? join(core, 'index.ts')
      : specifier === '@orca-board/contracts' ? join(contracts, 'index.ts')
      : ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule?.resolvedFileName
    if (!resolved || !existsSync(resolved)) {
      report(file, specifier, 'outside')
      return
    }
    const target = canonical(resolved)
    if ((!within(target, runtime) && !within(target, contracts) && !within(target, core)) || isTest(relative(repo, target))) {
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
      if (isTest(relative(runtime, file))) continue
      if (item.isDirectory()) collect(file)
      else if (item.isFile() && /\.[cm]?tsx?$/.test(item.name)) visit(canonical(file))
    }
  }
  collect(runtime)
  return issues.sort((a, b) => a.file.localeCompare(b.file) || a.specifier.localeCompare(b.specifier) || a.reason.localeCompare(b.reason))
}
