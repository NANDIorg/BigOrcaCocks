import type { OperatorCall, OperatorHello, OperatorMetadata, OperatorReply, ObserverCursor, ObserverDelivery, ObserverSnapshot } from '@orca-board/contracts'
import type { OperatorTransport } from './transport.ts'
import { OrcaClientError } from './client.ts'

/** Credentials задаёт host; token не сохраняется client package и не попадает в URL. */
export function createHttpTransport(options: { url: string; clientId: string; headers?: () => Record<string, string>; fetch?: typeof fetch }): OperatorTransport {
  const request = async (path: string, method: string, body?: BodyInit, headers?: Record<string, string>) => {
    const response = await (options.fetch ?? globalThis.fetch)(new URL(path, options.url), { method, body, credentials: 'include', headers: { 'x-orca-client': options.clientId, ...options.headers?.(), ...headers } })
    if (!response.ok) {
      const result: unknown = await response.json().catch(() => null)
      const code = result && typeof result === 'object' && 'error' in result && result.error && typeof result.error === 'object' && 'code' in result.error ? String(result.error.code) : 'protocol.transportRejected'
      throw new OrcaClientError(code)
    }
    return response
  }
  const json = async <T>(path: string, method: string, value?: unknown): Promise<T> => await (await request(path, method, value === undefined ? undefined : JSON.stringify(value), { 'content-type': 'application/json' })).json() as T
  return {
    hello: (value: OperatorHello) => json<OperatorMetadata>('/hello', 'POST', value),
    call: (value: OperatorCall) => json<OperatorReply>('/call', 'POST', value),
    select: value => json<void>('/select', 'POST', value),
    snapshot: () => json<ObserverSnapshot<unknown>>('/snapshot', 'POST', {}),
    subscribe: (cursor: ObserverCursor) => json<void>('/subscribe', 'POST', cursor),
    events: () => json<ObserverDelivery[]>('/events', 'GET'),
    upload: async attachment => await (await request('/upload', 'POST', new Blob([attachment.data as Uint8Array<ArrayBuffer>]), { 'content-type': attachment.mime ?? 'application/octet-stream', 'x-orca-file-name': encodeURIComponent(attachment.name ?? 'attachment'), 'x-orca-file-name-encoded': 'true' })).json() as { uploadId: string },
    binary: async query => new Uint8Array(await (await request(`/binary?${new URLSearchParams(query)}`, 'GET')).arrayBuffer()),
    writer: async packet => {
      await request(packet.data === undefined ? '/pty/resize' : '/pty/write', 'POST', packet.data ?? JSON.stringify({ cols: packet.cols, rows: packet.rows }),
        { 'x-orca-pty': packet.ptyId, 'x-orca-lease': packet.leaseId, 'x-orca-sequence': String(packet.sequence) })
    },
    close: () => json<void>('/session', 'DELETE')
  }
}
