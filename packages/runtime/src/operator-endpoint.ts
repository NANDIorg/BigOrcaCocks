import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual, createHash } from 'node:crypto'
import type { ClientCommandContext } from '@orca-board/contracts'
import { ATTACHMENT_LIMITS } from '@orca-board/core'
import type { createOrcaRuntime } from './orca-runtime.ts'
import type { OperatorSession } from './operator-session.ts'
import type { ObserverSubscription } from './observer-events.ts'
import { protocolText, OperatorProtocolError } from './operator-handshake.ts'
import { clientCommandContextFrom } from './project-commands.ts'
import { createOperatorUploads, createOperatorWriter, readOperatorBinary, readOperatorSnapshot } from './operator-io.ts'

type Runtime = Awaited<ReturnType<typeof createOrcaRuntime>>['value']
interface Connection { session: OperatorSession; subscription?: ObserverSubscription; at: number }

async function body(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0
  for await (const raw of request) { const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); size += chunk.length; if (size > limit) throw new OperatorProtocolError('protocol.packetTooLarge', 'Слишком большой пакет'); chunks.push(chunk) }
  return Buffer.concat(chunks)
}
async function respond(response: ServerResponse, result: unknown): Promise<void> {
  response.setHeader('content-type', 'application/json; charset=utf-8'); response.setHeader('cache-control', 'no-store')
  const text = Buffer.from(JSON.stringify(result))
  // Полный snapshot сохраняется; backpressure не позволяет HTTP очереди расти с размером доски.
  for (let offset = 0; offset < text.length; offset += 16 * 1024) {
    if (response.destroyed) return
    if (!response.write(text.subarray(offset, offset + 16 * 1024))) await new Promise<void>((resolve, reject) => {
      const clean = () => { clearTimeout(timeout); response.off('drain', drained); response.off('close', drained); response.off('error', failed) }
      const drained = () => { clean(); resolve() }; const failed = (error: Error) => { clean(); reject(error) }
      const timeout = setTimeout(() => { response.destroy(); drained() }, 30_000)
      response.once('drain', drained); response.once('close', drained); response.once('error', failed)
      if (response.destroyed) drained()
    })
  }
  response.end()
}

/** Только loopback/private token. Web host позже передаст свою проверку principal вместо локального credential. */
export async function startOperatorEndpoint(options: { runtime: Runtime; token?: string; maxClients?: number; authenticate?: (request: IncomingMessage) => ClientCommandContext | null | Promise<ClientCommandContext | null> }) {
  const token = Buffer.from(options.token ?? ''); if (!token.length && !options.authenticate) throw new Error('Требуется private operator credential или host authentication')
  const clients = new Map<string, Connection>(); const uploads = createOperatorUploads(); const pending = new Set<Promise<void>>()
  const writer = createOperatorWriter({ sessions: options.runtime.sessionCommands, leases: options.runtime.leases })
  let closing = false; let uploading = 0; let shutdown: Promise<void> | undefined
  const detach = (id: string) => { const entry = clients.get(id); if (entry) { entry.session.close(); clients.delete(id) } }
  const prune = () => {
    for (const [id, entry] of clients) if (Date.now() - entry.at > 60_000) detach(id)

  }
  const timer = setInterval(prune, 10_000); timer.unref()
  const server = createServer((request, response) => {
    if (pending.size >= 32) { response.statusCode = 503; response.end('{"error":{"code":"protocol.capacity"}}'); return }
    const job = handle(request, response).catch(async error => {
      if (response.headersSent) { response.destroy(); return }
      response.statusCode = error instanceof OperatorProtocolError ? error.code === 'protocol.packetTooLarge' ? 413 : 409 : 400
      try { await respond(response, { error: { code: error instanceof OperatorProtocolError ? error.code : 'command.rejected' } }) } catch { response.destroy() }
    })
    pending.add(job); void job.finally(() => pending.delete(job))
  })
  server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.maxHeadersCount = 32
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const header = request.headers.authorization ?? ''; const supplied = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
    let verified: ClientCommandContext | null = null
    if (!closing) {
      if (options.authenticate) verified = await options.authenticate(request)
      else if (supplied.length === token.length && timingSafeEqual(supplied, token)) verified = { clientId: protocolText(request.headers['x-orca-client'], 'client identity'), actor: { kind: 'operator', id: 'local-user' } }
    }
    if (!verified) { response.statusCode = 401; response.setHeader('connection', 'close'); await respond(response, { error: { code: 'command.forbidden' } }); return }
    // Один label разных пользователей не даёт общий writer lease или mutation identity.
    const principal = clientCommandContextFrom(verified)
    const clientId = createHash('sha256').update(JSON.stringify([principal.actor.kind, principal.actor.id, principal.clientId])).digest('hex')
    const context: ClientCommandContext = { ...principal, clientId }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'); const path = url.pathname
    prune(); let entry = clients.get(clientId)
    if (request.method === 'POST' && path === '/hello') {
      const hello: unknown = JSON.parse((await body(request, 64 * 1024)).toString('utf8'))
      if (!entry) {
        if (clients.size >= (options.maxClients ?? 8)) throw new OperatorProtocolError('protocol.capacity', 'Достигнут лимит клиентов')
        const session = options.runtime.operator(context)
        try { const metadata = session.hello(hello); entry = { session, at: Date.now() }; clients.set(clientId, entry); await respond(response, metadata) }
        catch (error) { session.close(); throw error }
      } else { entry.at = Date.now(); await respond(response, entry.session.hello(hello)) }
      return
    }
    if (!entry) throw new OperatorProtocolError('protocol.handshakeRequired', 'Сначала требуется handshake')
    entry.at = Date.now()
    if (request.method === 'DELETE' && path === '/session') { detach(clientId); await respond(response, null); return }
    if (request.method === 'GET' && path === '/events') { await respond(response, entry.subscription?.take() ?? []); return }
    if (request.method === 'POST' && (path === '/pty/write' || path === '/pty/resize')) {
      const ptyId = protocolText(request.headers['x-orca-pty'], 'ptyId'); const leaseId = protocolText(request.headers['x-orca-lease'], 'leaseId')
      const sequence = Number(request.headers['x-orca-sequence']); if (!Number.isSafeInteger(sequence) || sequence < 1) throw new OperatorProtocolError('protocol.invalidInput', 'Некорректная writer sequence')
      const bytes = await body(request, 64 * 1024)
      const packet: unknown = path === '/pty/write' ? { ptyId, leaseId, sequence, data: bytes.toString('utf8') } : { ...JSON.parse(bytes.toString('utf8')), ptyId, leaseId, sequence }
      await respond(response, writer.send(context, packet)); return
    }

    if (request.method === 'POST' && path === '/upload') {
      if (uploading >= 2) throw new OperatorProtocolError('protocol.capacity', 'Слишком много параллельных upload')
      let data: Buffer; uploading++
      try { data = await body(request, ATTACHMENT_LIMITS.maxBytes) } finally { uploading-- }
      const rawName = protocolText(request.headers['x-orca-file-name'], 'file name', 4096)
      const name = protocolText(request.headers['x-orca-file-name-encoded'] === 'true' ? decodeURIComponent(rawName) : rawName, 'file name', 1024)
      await respond(response, uploads.add(clientId, { name, mime: request.headers['content-type'] ?? 'application/octet-stream', data: new Uint8Array(data) })); return
    }

    if (request.method === 'GET' && path === '/binary') {
      const file = await readOperatorBinary({ files: options.runtime.fileCommands, globalTask: options.runtime.globalTaskCommands }, context, Object.fromEntries(url.searchParams))
      response.setHeader('content-type', file.mime); response.setHeader('cache-control', 'no-store'); response.setHeader('x-content-type-options', 'nosniff'); response.setHeader('content-disposition', 'attachment'); response.end(file.bytes); return
    }
    const raw: unknown = JSON.parse((await body(request, 64 * 1024)).toString('utf8'))
    if (request.method === 'POST' && path === '/select') { entry.session.select(raw); entry.subscription?.close(); entry.subscription = undefined; await respond(response, null); return }
    if (request.method === 'POST' && path === '/subscribe') { entry.subscription?.close(); entry.subscription = entry.session.subscribe(raw); await respond(response, options.runtime.events.cursor); return }
    if (request.method === 'POST' && path === '/snapshot') {
      entry.subscription?.close()
      const result = entry.session.snapshot((ctx, selection) => readOperatorSnapshot({ profile: options.runtime.profileCommands, board: options.runtime.boardCommands,
        dialog: options.runtime.dialogCommands, session: options.runtime.sessionCommands, revision: () => options.runtime.revision }, ctx, selection))
      entry.subscription = result.subscription; await respond(response, { snapshot: result.snapshot, cursor: result.cursor }); return
    }
    if (request.method === 'POST' && path === '/call') {
      // Ticket bytes разворачиваются внутри invoke после digest/cache lookup, а не в RPC/base64 payload.
      const result = await entry.session.call(raw, id => uploads.get(clientId, id)); await respond(response, result); return
    }

    response.statusCode = 404; response.end()
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Не удалось открыть operator endpoint')
  return { url: `http://127.0.0.1:${address.port}`, stop(): Promise<void> {
    if (shutdown) return shutdown
    closing = true; clearInterval(timer); for (const id of clients.keys()) detach(id)
    shutdown = Promise.resolve().then(async () => {
      server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await Promise.all([...pending]); uploads.clear(); writer.clear()
    })
    return shutdown
  } }
}
