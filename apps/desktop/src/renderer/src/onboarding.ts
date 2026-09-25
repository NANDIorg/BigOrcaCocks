import type { OnboardingCompleteInput, OnboardingState, OrcaApi } from '../../shared/ipc'

/**
 * Мастер первого запуска в renderer (docs/architecture.md → «Мастер первого запуска»). Здесь — только то, что
 * решает «показывать ли мастер» и как пережить старый main/preload: в `pnpm dev` renderer приходит по HMR, а
 * `window.orca` остаётся прежним — без `onboarding` или без хендлеров в main.
 */

/** Часть `window.orca` с мастером; поле необязательное — preload может быть старым. */
export interface OnboardingHost {
  onboarding?: Partial<OrcaApi['onboarding']>
}

/** Методы мастера или undefined, если preload старый. Тогда мастера нет, а «Пройти заново» просит перезапуск. */
export function onboardingApi(api: OnboardingHost | undefined): OrcaApi['onboarding'] | undefined {
  const onboarding = api?.onboarding
  const getState = onboarding?.getState
  const complete = onboarding?.complete
  if (typeof getState !== 'function' || typeof complete !== 'function') return undefined
  return {
    getState: () => getState.call(onboarding),
    complete: (input?: OnboardingCompleteInput) => complete.call(onboarding, input)
  }
}

/** Preload новый, а main старый — invoke падает с «No handler registered for 'onboarding:…'». */
export function isStaleOnboardingError(message: string): boolean {
  return /No handler registered for 'onboarding:/.test(message)
}

/**
 * Состояние мастера или null, если оно неизвестно. Старый main/preload — null, и любая другая ошибка — тоже:
 * мастер, всплывающий при каждом сбое, хуже, чем его отсутствие (статус останется `pending` и покажется в
 * следующий запуск).
 */
export async function loadOnboarding(api: OnboardingHost | undefined): Promise<OnboardingState | null> {
  const onboarding = onboardingApi(api)
  if (!onboarding) return null
  try {
    return await onboarding.getState()
  } catch {
    return null
  }
}

/** Показывать мастер при старте — только по явному `required === true`; неизвестное состояние (null) — нет. */
export function shouldShowOnboarding(state: Pick<OnboardingState, 'required'> | null | undefined): boolean {
  return state?.required === true
}

/**
 * Записать прохождение или пропуск. Ошибку глотаем: человек уже нажал «Готово»/«Пропустить», а не записанный
 * статус означает лишь повторный показ при следующем запуске — блокировать из-за этого окно незачем.
 */
export async function completeOnboarding(api: OnboardingHost | undefined, skipped: boolean): Promise<void> {
  const onboarding = onboardingApi(api)
  if (!onboarding) return
  try {
    await onboarding.complete(skipped ? { skipped: true } : undefined)
  } catch {
    // Старый main без хендлера или сбой записи — статус останется pending.
  }
}
