import { mountOrcaUi } from '@orca-board/ui'
import { createDesktopBindings } from '@orca-board/client'

const bindings = createDesktopBindings(window.orca, { name: 'orca-desktop', version: __ORCA_CURRENT_RELEASE__.version })
const dispose = mountOrcaUi(document.getElementById('root')!, { ...bindings, release: __ORCA_CURRENT_RELEASE__ })
if (import.meta.hot) import.meta.hot.dispose(() => { dispose(); void bindings.dispose() })
