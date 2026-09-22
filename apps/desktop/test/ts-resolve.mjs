// Хук для `node --test` (type stripping Node ≥ 22.6): исходники main и core импортируют
// относительные модули без расширения (так требует bundler-резолв electron-vite), node ищет файл
// буквально — пробуем ещё `.ts`.
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (e) {
      if (e?.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.') || specifier.endsWith('.ts')) throw e
      return next(`${specifier}.ts`, context)
    }
  }
})
