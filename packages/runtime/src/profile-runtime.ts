import { acquireProfileOwnership, type ProfileOwnerInfo } from './profile-ownership.ts'

type Cleanup = () => void | Promise<void>
export interface ProfileRuntimeContext {
  readonly dataDir: string
  readonly owner: ProfileOwnerInfo
  /** Регистрация во время startup; динамическими ресурсами после него владеет зарегистрированный service. */
  deferCleanup(cleanup: Cleanup): void
}
export interface ProfileRuntime<T> {
  readonly value: T
  readonly owner: ProfileOwnerInfo
  stop(): Promise<void>
}
export interface ProfileRuntimeOptions<T> {
  dataDir: string
  start(context: ProfileRuntimeContext): T | Promise<T>
}

/** При неудачном cleanup caller может повторить его; до успеха guard продолжает исключать второго writer. */
export class ProfileRuntimeStartupError extends AggregateError {
  readonly retryCleanup: () => Promise<void>
  constructor(startupError: unknown, cleanupError: unknown, retryCleanup: () => Promise<void>) {
    super([startupError, cleanupError], 'Ошибка запуска и остановки частично созданного runtime.', { cause: startupError })
    this.name = 'ProfileRuntimeStartupError'
    this.retryCleanup = retryCleanup
  }
}

/** Никакой store/migration/backup не создаётся до приобретения lease. Import не запускает host. */
export async function startProfileRuntime<T>(options: ProfileRuntimeOptions<T>): Promise<ProfileRuntime<T>> {
  const lease = await acquireProfileOwnership({ dataDir: options.dataDir })
  const resources: { cleanup: Cleanup }[] = []
  let registrationOpen = true
  let stopped = false
  let pendingStop: Promise<void> | undefined
  const stop = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (pendingStop) return pendingStop
    const attempt = (async () => {
      const failures: unknown[] = []
      // Продолжаем cleanup независимых ресурсов; успешно закрытые не повторяются при retry.
      for (const resource of [...resources].reverse()) {
        try {
          await resource.cleanup()
          resources.splice(resources.indexOf(resource), 1)
        } catch (error) { failures.push(error) }
      }
      if (failures.length) throw new AggregateError(failures, 'Не удалось остановить ресурсы профиля.')
      await lease.release()
      stopped = true
    })()
    pendingStop = attempt
    void attempt.then(() => {}, () => { pendingStop = undefined })
    return attempt
  }
  let value: T
  try {
    value = await options.start({
      dataDir: lease.info.dataDir,
      owner: lease.info,
      deferCleanup(cleanup) {
        if (!registrationOpen) throw new Error('Ресурсы runtime регистрируются до завершения запуска.')
        resources.push({ cleanup })
      }
    })
  } catch (startupError) {
    registrationOpen = false
    try { await stop() } catch (cleanupError) { throw new ProfileRuntimeStartupError(startupError, cleanupError, stop) }
    throw startupError
  }
  registrationOpen = false
  return { value, get owner() { return lease.info }, stop }
}
