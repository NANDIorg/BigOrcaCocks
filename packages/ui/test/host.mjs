import '../../../scripts/ts-resolve.mjs'
import { setUiApiResolver } from '../src/host.ts'

// Прежние fixtures заменяют window.orca; production UI получает только injected binding.
setUiApiResolver(() => globalThis.window?.orca)
