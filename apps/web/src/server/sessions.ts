import { randomBytes } from 'node:crypto'

export interface WebSession { accountId: string; token: string; csrfToken: string; createdAt: number; lastSeen: number }
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000
export const SESSION_IDLE_MS = 30 * 60 * 1000
export function createWebSessions(options: { now?: () => number; onRevoke(session: WebSession): void }) {
  const sessions = new Map<string, WebSession>(); const now = options.now ?? Date.now
  let stopped = false
  const revoke = (token: string) => {
    const session = sessions.get(token)
    if (session) { sessions.delete(token); options.onRevoke({ ...session }) }
  }
  const prune = () => { const at = now(); for (const session of sessions.values()) if (at - session.createdAt >= SESSION_TTL_MS || at - session.lastSeen >= SESSION_IDLE_MS) revoke(session.token) }
  return {
    create(accountId: string): WebSession {
      prune()
      if (stopped || sessions.size >= 64) throw new Error('Достигнут лимит Web sessions')
      const at = now(); const session = { accountId, token: randomBytes(32).toString('base64url'), csrfToken: randomBytes(32).toString('base64url'), createdAt: at, lastSeen: at }
      sessions.set(session.token, session); return { ...session }
    },
    get(token: string, touch = true): WebSession | null { prune(); const session = sessions.get(token); if (!session || stopped) return null; if (touch) session.lastSeen = now(); return { ...session } },
    revoke, prune,
    stop() { stopped = true; for (const token of sessions.keys()) revoke(token) },
    get size() { prune(); return sessions.size }
  }
}
export type WebSessions = ReturnType<typeof createWebSessions>
