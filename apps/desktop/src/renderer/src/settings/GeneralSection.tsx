import type React from 'react'
import type { AppSettings, AppSettingsPatch } from '../../../shared/ipc'
import { SectionHead, Switch } from '../about/parts'
import { onboardingApi } from '../onboarding'
import { LOCALES, LOCALE_NAMES, useLocale, useT } from '../i18n'

/** Раздел «Настройки → Общие»: настройки приложения, действующие на все проекты. */
export function GeneralSection({ settings, error, onChange, onRunOnboarding }: {
  settings: AppSettings | null
  error: string | null
  onChange(patch: AppSettingsPatch): void
  /** Открыть мастер первого запуска заново. */
  onRunOnboarding(): void
}): React.JSX.Element {
  const t = useT()
  // Язык не выбран явно (первый запуск) — отмечен тот, что показан сейчас: русский.
  const locale = useLocale()
  // Старый preload без `onboarding` — строки нет: мастер всё равно не показывается при старте.
  const canRerun = !!onboardingApi(window.orca)
  return (
    <>
      <SectionHead title={t('settings.general.title')} hint={t('settings.general.hint')} />
      <div className="about-box">
        <div className="row-act">
          <div className="row-act-text">
            <b>{t('settings.general.language')}</b>
            <span className="hint">{t('settings.general.languageHint')}</span>
          </div>
          <div className="segmented" role="radiogroup" aria-label={t('settings.general.language')}>
            {LOCALES.map((l) => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={locale === l}
                className={`seg ${locale === l ? 'active' : ''}`}
                onClick={() => onChange({ language: l })}
              >
                {LOCALE_NAMES[l]}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="about-box">
        <div className="row-act">
          <div className="row-act-text">
            <b>{t('settings.general.background')}</b>
            <span className="hint">{t('settings.general.backgroundHint')}</span>
          </div>
          <Switch
            on={settings?.keepInBackground ?? true}
            disabled={!settings}
            onChange={(on) => onChange({ keepInBackground: on })}
          />
        </div>
      </div>
      {canRerun && (
        <div className="about-box">
          <div className="row-act">
            <div className="row-act-text">
              <b>{t('settings.general.onboarding')}</b>
              <span className="hint">{t('settings.general.onboardingHint')}</span>
            </div>
            <button type="button" className="btn-sm" onClick={onRunOnboarding}>{t('settings.general.onboardingRerun')}</button>
          </div>
        </div>
      )}
      {error && <div className="editor-error">{error}</div>}
    </>
  )
}
