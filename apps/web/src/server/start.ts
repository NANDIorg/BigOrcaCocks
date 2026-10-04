import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startWeb } from './index.ts'
import { loadWebConfig } from './config.ts'
import { warnRoot } from './privileges.ts'

export async function runWebServer(file: string): Promise<void> {
if (!file) throw new Error('Укажите абсолютный путь к Web config JSON')
if (resolve(file) !== file) throw new Error('Путь к Web config должен быть абсолютным')
warnRoot()
const config = await loadWebConfig(file)
const host = await startWeb({ config, resourceDir: dirname(fileURLToPath(import.meta.url)), warn: message => process.stderr.write(`${message}\n`) })
process.stdout.write(`Orca Web: ${config.origin}\n`)
const stop = () => { void host.stop().then(() => { process.exitCode = 0 }, () => { process.stderr.write('Не удалось остановить Web host\n'); process.exitCode = 1 }) }
process.on('SIGINT', stop); process.on('SIGTERM', stop)
}
