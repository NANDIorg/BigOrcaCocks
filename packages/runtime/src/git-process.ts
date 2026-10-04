import { execFile, spawn, type ChildProcess } from 'node:child_process'

export interface GitProcessOptions {
  input?: string
  timeoutMs?: number
  maxBuffer?: number
  signal?: AbortSignal
  acceptedExitCodes?: readonly number[]
}
export interface GitProcessResult { stdout: string; stderr: string; code: number }
export interface GitProcessService {
  run(cwd: string, args: readonly string[], options?: GitProcessOptions): Promise<GitProcessResult>
  stop(): Promise<void>
}

/** Сохраняет stderr/exit code для domain formatter, не скрывая отмену и таймаут. */
export class GitProcessError extends Error {
  readonly code: string | number | undefined
  readonly stdout: string
  readonly stderr: string
  readonly cancelled: boolean
  readonly timedOut: boolean
  readonly killed: boolean
  constructor(message: string, code: string | number | undefined, stdout: string,
    stderr: string, cancelled = false, timedOut = false, killed = false) {
    super(message); this.name = 'GitProcessError'
    this.code = code; this.stdout = stdout; this.stderr = stderr
    this.cancelled = cancelled; this.timedOut = timedOut; this.killed = killed
  }
}

/** Только собственная detached group; Windows требует taskkill, чтобы завершить также hooks. */
async function killTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* Дерево уже завершилось. */ }
    return
  }
  await new Promise<void>(resolve => {
    execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, error => {
      if (error && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      resolve()
    })
  })
}

/** Один owner владеет всеми вызовами; импорт модуля сам процессов не запускает. */
export function createGitProcessService(): GitProcessService {
  const lifetime = new AbortController()
  const active = new Set<Promise<GitProcessResult>>()
  let stopping: Promise<void> | undefined

  function run(cwd: string, args: readonly string[], options: GitProcessOptions = {}): Promise<GitProcessResult> {
    if (lifetime.signal.aborted || options.signal?.aborted) {
      return Promise.reject(new GitProcessError('Вызов Git отменён', 'ABORT_ERR', '', '', true))
    }
    const timeoutMs = options.timeoutMs ?? 30_000
    const pending = new Promise<GitProcessResult>((resolve, reject) => {
      let cancelled = false; let timedOut = false; let closed = false
      let killing: Promise<void> | undefined
      const cancel = (timeout = false) => {
        if (closed || killing) return
        timedOut = timeout; cancelled = !timeout; killing = killTree(child)
      }
      const onAbort = () => cancel()
      const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024
      const stdoutChunks: Buffer[] = []; const stderrChunks: Buffer[] = []
      let stdoutBytes = 0; let stderrBytes = 0
      let failure: { message: string; code?: string | number } | undefined
      let overflow = false
      const child = spawn('git', [...args], {
        cwd, detached: process.platform !== 'win32', windowsHide: true, shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', NO_COLOR: '1', GIT_PAGER: 'cat' }
      })
      const collect = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
        const used = stream === 'stdout' ? stdoutBytes : stderrBytes
        const room = Math.max(0, maxBuffer - used)
        const kept = chunk.subarray(0, room)
        if (stream === 'stdout') { stdoutChunks.push(kept); stdoutBytes += kept.length }
        else { stderrChunks.push(kept); stderrBytes += kept.length }
        if (chunk.length > room && !overflow) {
          overflow = true; failure = { message: `Вывод Git превышает ${maxBuffer} байт`, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }
          if (!killing) killing = killTree(child)
        }
      }
      child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'))
      child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'))
      child.on('error', (error: NodeJS.ErrnoException) => { failure = { message: error.message, code: error.code } })
      child.on('close', (exitCode, signal) => {
        closed = true; clearTimeout(timer)
        lifetime.signal.removeEventListener('abort', onAbort); options.signal?.removeEventListener('abort', onAbort)
        const stdout = Buffer.concat(stdoutChunks).toString('utf8'); const stderr = Buffer.concat(stderrChunks).toString('utf8')
        const finish = () => {
          const code = failure?.code ?? exitCode ?? undefined
          if (!cancelled && !timedOut && !failure && signal === null && typeof exitCode === 'number'
            && (exitCode === 0 || options.acceptedExitCodes?.includes(exitCode))) {
            resolve({ stdout, stderr, code: exitCode })
          } else {
            reject(new GitProcessError(timedOut ? `Git не ответил за ${Math.round(timeoutMs / 1000)} с`
              : cancelled ? 'Вызов Git отменён' : failure?.message ?? `Git завершился с кодом ${exitCode ?? signal}`,
            timedOut ? 'ETIMEDOUT' : cancelled ? 'ABORT_ERR' : code, stdout, stderr, cancelled, timedOut, cancelled || timedOut || overflow || signal !== null))
          }
        }
        if (killing) void killing.then(finish, finish)
        else finish()
      })
      const timer = setTimeout(() => cancel(true), timeoutMs)
      lifetime.signal.addEventListener('abort', onAbort, { once: true }); options.signal?.addEventListener('abort', onAbort, { once: true })
      // Git может выйти до чтения входа; результат сообщает close, EPIPE не роняет owner.
      child.stdin?.on('error', () => undefined); child.stdin?.end(options.input ?? '')
    })
    active.add(pending)
    void pending.then(() => active.delete(pending), () => active.delete(pending))
    return pending
  }

  return {
    run,
    stop: () => {
      if (!stopping) { lifetime.abort(); stopping = Promise.allSettled([...active]).then(() => undefined) }
      return stopping
    }
  }
}
