import { registerHooks, createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { ensureNodeNative, nodePtyPath } from './node-native.mjs'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'node-pty' || specifier.startsWith('node-pty/')) {
    ensureNodeNative()
    const require = createRequire(pathToFileURL(nodePtyPath('package.json')))
    return { url: pathToFileURL(require.resolve(nodePtyPath(specifier))).href, shortCircuit: true }
  }
  try { return next(specifier, context) } catch (error) {
    if (!['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT'].includes(error?.code) || !specifier.startsWith('.') || /\.[cm]?[jt]sx?$/.test(specifier)) throw error
    try { return next(`${specifier}.ts`, context) } catch { return next(`${specifier}/index.ts`, context) }
  }
} })
