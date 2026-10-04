import { request } from 'node:http'
import type { WebConfig } from './config.ts'

/** Node fetch переписывает Host. CLI проверяет loopback listener, сохраняя публичный hostname панели. */
export function localHealth(config: WebConfig): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: config.port, path: '/health', headers: { host: new URL(config.origin).host, 'x-forwarded-proto': 'https' } }, response => {
      const chunks: Buffer[] = []; let size = 0
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 4096) response.destroy(new Error('Некорректный health ответ')); else chunks.push(chunk) })
      response.once('error', reject); response.once('end', () => {
        if (response.statusCode !== 200) { reject(new Error('Сервис не готов')); return }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) } catch { reject(new Error('Некорректный health ответ')) }
      })
    })
    req.setTimeout(5000, () => req.destroy(new Error('Таймаут проверки сервиса'))); req.once('error', reject); req.end()
  })
}
