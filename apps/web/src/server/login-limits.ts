export function createLoginLimits(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now
  const attempts = new Map<string, { at: number; pending: boolean }[]>()
  return {
    reserve(address: string): { success(): void; failure(): void } | null {
      const at = now()
      for (const [key, entries] of attempts) {
        const kept = entries.filter(entry => entry.pending || at - entry.at < 60_000)
        if (kept.length) attempts.set(key, kept); else attempts.delete(key)
      }
      const entries = attempts.get(address) ?? []
      if (entries.length >= 5 || !attempts.has(address) && attempts.size >= 256) return null
      const entry = { at, pending: true }; entries.push(entry); attempts.set(address, entries)
      let finished = false
      return {
        success() { if (finished) return; finished = true; const current = attempts.get(address); if (current) { const index = current.indexOf(entry); if (index >= 0) current.splice(index, 1); if (!current.length) attempts.delete(address) } },
        failure() { if (finished) return; finished = true; entry.pending = false; entry.at = now() }
      }
    },
    get size() { return attempts.size }
  }
}
