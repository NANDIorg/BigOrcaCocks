import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { startHeadless } from './index.ts'

const dataDir = process.argv[2] ?? process.env.ORCA_DATA_DIR ?? join(homedir(), '.orca-board', 'profiles', 'default')
if (resolve(dataDir) !== dataDir) throw new Error('Каталог профиля должен быть абсолютным')
mkdirSync(dataDir, { recursive: true, mode: 0o700 })
const host = await startHeadless({ dataDir, warn: (message, detail) => console.error(message, detail ?? '') })
process.stdout.write(`Orca runtime: ${host.endpoint.url}\n`)
let stopping = false
const stop = () => { if (stopping) return; stopping = true; void host.stop().then(() => { process.exitCode = 0 }, error => { console.error(error); process.exitCode = 1; stopping = false }) }
process.on('SIGINT', stop); process.on('SIGTERM', stop)
