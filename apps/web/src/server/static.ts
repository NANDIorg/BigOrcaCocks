import { readFile, realpath, stat } from 'node:fs/promises'
import { join, relative, isAbsolute, extname } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }
export function createStaticHandler(root: string, previewOrigin: string) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    if (!['GET', 'HEAD'].includes(request.method ?? '')) return false
    const raw = request.url?.split('?')[0] ?? '/'
    let path: string
    try { path = decodeURIComponent(raw) } catch { return false }
    const parts = path.slice(1).split('/')
    if (path !== '/' && (!path.startsWith('/assets/') || parts.some(part => !part || part.startsWith('.') || /[\\\0]/.test(part)))) return false
    const canonicalRoot = await realpath(root)
    let file: string
    try { file = await realpath(join(root, path === '/' ? 'index.html' : parts.join('/'))) } catch { return false }
    const rel = relative(canonicalRoot, file)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || !(await stat(file)).isFile() || !mime[extname(file)]) return false
    response.setHeader('content-type', mime[extname(file)])
    response.setHeader('cache-control', path === '/' ? 'no-store' : 'public, max-age=31536000, immutable')
    response.setHeader('x-content-type-options', 'nosniff'); response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader('content-security-policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: ${previewOrigin}; font-src 'self'; connect-src 'self'; frame-src ${previewOrigin}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`)
    response.end(request.method === 'HEAD' ? undefined : await readFile(file)); return true
  }
}
