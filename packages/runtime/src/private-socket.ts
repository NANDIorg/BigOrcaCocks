import { createConnection, type Server } from 'node:net'
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

/** Проверяем inode и отказ connect; живой или непонятный foreign endpoint не удаляется. */
export async function listenPrivateSocket(server: Server, path: string): Promise<void> {
  if (process.platform !== 'win32') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    if (existsSync(path)) {
      const before = lstatSync(path)
      if (!before.isSocket() || process.getuid && before.uid !== process.getuid()) throw new Error('Путь agent socket занят чужим файлом')
      const stale = await new Promise<boolean>(resolve => {
        const socket = createConnection(path); const timeout = setTimeout(() => finish(false), 1000)
        const finish = (result: boolean) => { clearTimeout(timeout); socket.destroy(); resolve(result) }
        socket.once('connect', () => finish(false)); socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNREFUSED'))
      })
      if (!stale) throw new Error('Agent socket занят живым или неизвестным endpoint')
      const after = lstatSync(path)
      if (after.ino !== before.ino || after.dev !== before.dev || !after.isSocket()) throw new Error('Agent socket изменился во время проверки')
      unlinkSync(path)
    }
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
  if (process.platform !== 'win32') chmodSync(path, 0o600)
}
