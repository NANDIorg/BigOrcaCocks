import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ClientCommandContext } from '@orca-board/contracts'
import type { OperatorHttpHandler } from '@orca-board/runtime'
import type { WebConfig } from './config.ts'
import { record } from './private-json.ts'
import { validWebPassword, verifyWebPassword, type WebAccount } from './accounts.ts'
import { createLoginLimits } from './login-limits.ts'
import { SESSION_TTL_MS, type WebSession, type WebSessions } from './sessions.ts'
import type { BrowserUpdates } from './browser-updates.ts'

class HttpError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code }
}
const operatorPaths = new Set(['/hello', '/call', '/select', '/subscribe', '/snapshot', '/events', '/upload', '/binary', '/pty/write', '/pty/resize', '/session'])
function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  response.end(JSON.stringify(value))
}
async function loginBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new HttpError(400, 'protocol.invalidInput')
  const chunks: Buffer[] = []; let size = 0
  for await (const raw of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    size += bytes.length
    if (size > 16 * 1024) throw new HttpError(413, 'protocol.packetTooLarge')
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new HttpError(400, 'protocol.invalidInput') }
}
function equal(left: unknown, right: string): boolean {
  if (typeof left !== 'string' || left.length > 256) return false
  const bytes = Buffer.from(left); const expected = Buffer.from(right)
  return bytes.length === expected.length && timingSafeEqual(bytes, expected)
}
function loopback(address: string | undefined): boolean { return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' }

export function createWebRouter(options: { config: WebConfig; accounts: readonly WebAccount[]; sessions: WebSessions; operator: OperatorHttpHandler; now?: () => number;
  version?: string; updates?: BrowserUpdates; directories?(path?: string): Promise<unknown>; static?(request: IncomingMessage, response: ServerResponse): Promise<boolean> }) {
  const { config, accounts, sessions, operator } = options
  const expectedHost = new URL(config.origin).host
  const cookieName = config.mode === 'proxy' ? '__Host-orca-web-session' : 'orca-web-session'
  const limits = createLoginLimits({ now: options.now })
  const contexts = new Map<string, Map<string, { context: ClientCommandContext; at: number }>>()
  const pending = new Set<Promise<void>>()
  let active = 0; let hashes = 0; let closing = false; let shutdown: Promise<void> | undefined
  const timer = setInterval(() => sessions.prune(), 10_000); timer.unref()
  const cookie = (token: string, age: number) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${config.mode === 'proxy' ? '; Secure' : ''}`
  function security(request: IncomingMessage, mutation = false): void {
    let hosts = 0
    for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i].toLowerCase() === 'host') hosts++
    if (hosts !== 1 || request.headers.host !== expectedHost || config.mode === 'proxy' && (!loopback(request.socket.remoteAddress) || request.headers['x-forwarded-proto'] !== 'https')) throw new HttpError(403, 'command.forbidden')
    if ((mutation || request.headers.origin !== undefined) && request.headers.origin !== config.origin) throw new HttpError(403, 'command.forbidden')
  }
  function sessionFor(request: IncomingMessage): WebSession {
    const matching = (request.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`))
    if (matching.length !== 1) throw new HttpError(401, 'web.authRequired')
    const token = matching[0].slice(cookieName.length + 1)
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(401, 'web.authRequired')
    const session = sessions.get(token, false)
    if (!session) throw new HttpError(401, 'web.authRequired')
    if (request.method !== 'GET' && request.method !== 'HEAD' && !equal(request.headers['x-orca-csrf'], session.csrfToken)) throw new HttpError(403, 'command.forbidden')
    return session
  }
  function authenticateOperator(request: IncomingMessage): ClientCommandContext | null {
    if (closing) return null
    security(request, request.method !== 'GET' && request.method !== 'HEAD')
    const session = sessionFor(request)
    const label = request.headers['x-orca-client']
    if (typeof label !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(label)) throw new HttpError(400, 'protocol.invalidInput')
    const account = accounts.find(value => value.id === session.accountId)
    if (!account) throw new HttpError(401, 'web.authRequired')
    const id = createHash('sha256').update(JSON.stringify([session.token, label])).digest('hex')
    let clients = contexts.get(session.token)
    if (!clients) { clients = new Map(); contexts.set(session.token, clients) }
    for (const [key, value] of clients) if (Date.now() - value.at > 60_000) { operator.detach(value.context); clients.delete(key) }
    if (!clients.has(id) && clients.size >= 8) throw new HttpError(409, 'protocol.capacity')
    const context: ClientCommandContext = { actor: { kind: 'operator', id: `web:${account.id}` }, clientId: id }
    clients.set(id, { context, at: Date.now() })
    sessions.get(session.token)
    return context
  }
  function revokeClients(session: WebSession): void {
    const clients = contexts.get(session.token)
    if (clients) { for (const { context } of clients.values()) operator.detach(context); contexts.delete(session.token) }
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (closing) throw new HttpError(503, 'protocol.capacity')
    security(request, request.method !== 'GET' && request.method !== 'HEAD')
    if (!request.url?.startsWith('/')) throw new HttpError(400, 'protocol.invalidInput')
    const path = new URL(request.url, config.origin).pathname
    if (path === '/health' && request.method === 'GET') { json(response, 200, { status: 'ready', version: options.version }); return }
    if (path === '/auth/login' && request.method === 'POST') {
      const raw = await loginBody(request)
      if (!record(raw) || Object.keys(raw).some(key => !['login', 'password'].includes(key)) || typeof raw.login !== 'string' || raw.login.length > 128 || typeof raw.password !== 'string') throw new HttpError(400, 'protocol.invalidInput')
      const reservation = limits.reserve(request.socket.remoteAddress ?? 'unknown')
      if (!reservation) throw new HttpError(429, 'protocol.capacity')
      if (hashes >= 2) { reservation.success(); throw new HttpError(429, 'protocol.capacity') }
      const account = accounts.find(value => value.login === raw.login)
      let verified = false; hashes++
      try { verified = validWebPassword(raw.password) && await verifyWebPassword(account ?? accounts[0], raw.password) }
      catch { reservation.failure(); throw new HttpError(503, 'protocol.capacity') }
      finally { hashes-- }
      if (!account || !verified) { reservation.failure(); throw new HttpError(401, 'web.invalidCredentials') }
      reservation.success()
      if (closing || response.destroyed) throw new HttpError(503, 'protocol.capacity')
      if (sessions.size >= 64) throw new HttpError(429, 'protocol.capacity')
      const session = sessions.create(account.id)
      response.setHeader('set-cookie', cookie(session.token, SESSION_TTL_MS / 1000))
      json(response, 200, { user: { id: account.id, login: account.login }, csrfToken: session.csrfToken }); return
    }
    if (path === '/auth/session' && request.method === 'GET') {
      const session = sessionFor(request); const account = accounts.find(value => value.id === session.accountId)
      if (!account) throw new HttpError(401, 'web.authRequired')
      sessions.get(session.token)
      json(response, 200, { user: { id: account.id, login: account.login }, csrfToken: session.csrfToken }); return
    }
    if (path === '/auth/logout' && request.method === 'POST') {
      const session = sessionFor(request); sessions.revoke(session.token)
      response.setHeader('set-cookie', cookie('', 0)); response.statusCode = 204; response.end(); return
    }
    if (operatorPaths.has(path)) {
      const context = authenticateOperator(request)
      if (path === '/session' && request.method === 'DELETE') {
        const session = sessionFor(request)
        response.once('finish', () => { contexts.get(session.token)?.delete(context!.clientId); if (!contexts.get(session.token)?.size) contexts.delete(session.token) })
      }
      operator.handle(request, response); return
    }
    if (path === '/directories' && request.method === 'GET' && options.directories) {
      authenticateOperator(request)
      json(response, 200, await options.directories(new URL(request.url, config.origin).searchParams.get('path') ?? undefined)); return
    }
    if (options.updates && ['/updates', '/updates/check', '/updates/download', '/updates/install'].includes(path)) {
      authenticateOperator(request)
      if (path === '/updates' && request.method === 'GET') { json(response, 200, await options.updates.getState()); return }
      if (request.method !== 'POST' || path === '/updates') throw new HttpError(405, 'protocol.routeNotFound')
      const body = await loginBody(request)
      if (!record(body) || Object.keys(body).some(key => key !== 'version')) throw new HttpError(400, 'protocol.invalidInput')
      if (path === '/updates/check') {
        if (Object.keys(body).length) throw new HttpError(400, 'protocol.invalidInput')
        json(response, 200, await options.updates.check()); return
      }
      if (typeof body.version !== 'string' || body.version.length > 32) throw new HttpError(400, 'protocol.invalidInput')
      json(response, 202, await (path === '/updates/download' ? options.updates.download(body.version) : options.updates.install(body.version))); return
    }
    if (options.static && await options.static(request, response)) return
    json(response, 404, { error: { code: 'protocol.routeNotFound' } })
  }
  return {
    authenticateOperator, revokeClients,
    handle(request: IncomingMessage, response: ServerResponse): void {
      if (active >= 32) { json(response, 503, { error: { code: 'protocol.capacity' } }); return }
      active++
      let released = false
      const release = () => { if (!released) { released = true; active-- } }
      response.once('finish', release); response.once('close', release)
      const job = handle(request, response).catch(error => {
        if (response.headersSent || response.destroyed) { response.destroy(); return }
        json(response, error instanceof HttpError ? error.status : 400, { error: { code: error instanceof HttpError ? error.code : 'protocol.invalidInput' } })
      })
      pending.add(job); void job.finally(() => pending.delete(job))
    },
    stop(): Promise<void> {
      if (shutdown) return shutdown
      closing = true; clearInterval(timer)
      shutdown = Promise.resolve().then(async () => { sessions.stop(); await Promise.all([...pending]); contexts.clear() })
      void shutdown.catch(() => { shutdown = undefined })
      return shutdown
    }
  }
}
export type WebRouter = ReturnType<typeof createWebRouter>
