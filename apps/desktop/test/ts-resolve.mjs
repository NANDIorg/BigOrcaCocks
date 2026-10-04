// Node native root и TS resolver общие для инженерных suites.
import '../../../scripts/ts-resolve.mjs'
import { setUiApiResolver } from '@orca-board/ui/modules/host'
setUiApiResolver(() => globalThis.window?.orca)
