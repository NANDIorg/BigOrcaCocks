import type React from 'react'
import { useRef, useState } from 'react'
import type { AppSettings, AppSettingsPatch } from '../../../shared/ipc'
import { APP_THEMES, getAppTheme, type ThemeDefinition } from '../../../shared/theme'
import type { AppearanceSettings, MotionPreference } from '../../../shared/appearance'
import { SectionHead, Switch } from '../about/parts'
import { useT } from '../i18n'
import { useAppearance } from '../useAppearance'

/** Миниатюра настоящей компоновки Orca: навигация, три колонки и рабочие карточки. */
function ThemePreview({ theme }: { theme: ThemeDefinition }): React.JSX.Element {
  const c = theme.colors
  return <svg className="appearance-preview" viewBox="0 0 360 186" aria-hidden="true" focusable="false">
    <rect width="360" height="186" fill={c.page} />
    <rect width="28" height="186" fill={c.frame} />
    <rect x="28" width="68" height="186" fill={c.side} />
    <path d="M28 0v186M96 0v186" stroke={c.line} />
    {[30, 58, 86].map((y, i) => <rect key={y} x="9" y={y} width="10" height="10" rx="3" fill={i === 0 ? c.accent : c.muted} opacity={i === 0 ? 1 : .5} />)}
    <rect x="39" y="19" width="43" height="5" rx="2.5" fill={c.text} opacity=".65" />
    {[44, 65, 86].map((y, i) => <g key={y}>
      {i === 0 && <rect x="33" y={y - 5} width="58" height="17" rx="4" fill={c['side-2']} />}
      <rect x="41" y={y} width={i === 1 ? 29 : 39} height="4" rx="2" fill={i === 0 ? c.text : c.muted} opacity=".6" />
    </g>)}
    <rect x="109" y="18" width="87" height="7" rx="3" fill={c.text} opacity=".75" />
    <rect x="298" y="13" width="48" height="17" rx="4" fill={c.accent} />
    <path d="M318 21.5h8m-4-4v8" stroke={c['on-accent']} strokeWidth="1.5" strokeLinecap="round" />
    <path d="M109 43h25" stroke={c.accent} strokeWidth="2" strokeLinecap="round" />
    <path d="M143 43h25m9 0h25" stroke={c.muted} strokeWidth="2" strokeLinecap="round" opacity=".45" />
    {[c['col-ready'], c['col-progress'], c['col-done']].map((status, column) => <g key={column}>
      <rect x={109 + column * 82} y="57" width="74" height="115" rx="6" fill={c.side} />
      <path d={`M${117 + column * 82} 68h25`} stroke={c.muted} strokeWidth="3" strokeLinecap="round" opacity=".7" />
      {Array.from({ length: column === 1 ? 1 : 2 }, (_, card) => <g key={card}>
        <rect x={114 + column * 82} y={79 + card * 42} width="64" height="35" rx="4" fill={c.card} />
        <rect x={114 + column * 82} y={85 + card * 42} width="2" height="21" rx="1" fill={status} />
        <path d={`M${122 + column * 82} ${89 + card * 42}h43m-43 7h28`} stroke={c.text} strokeWidth="2.5" strokeLinecap="round" opacity=".5" />
        <circle cx={124 + column * 82} cy={105 + card * 42} r="2" fill={status} />
        <path d={`M${130 + column * 82} ${105 + card * 42}h16`} stroke={c.muted} strokeWidth="2" strokeLinecap="round" opacity=".45" />
      </g>)}
    </g>)}
  </svg>
}

export function AppearanceSection({ settings, error, onChange }: {
  settings: AppSettings | null
  error: string | null
  onChange(patch: AppSettingsPatch): Promise<void>
}): React.JSX.Element {
  const t = useT()
  const current = useAppearance().settings
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)

  async function choose(patch: Partial<AppearanceSettings>): Promise<void> {
    if (pending.current || !settings) return
    pending.current = true
    setBusy(true)
    try { await onChange({ appearance: patch }) } finally { pending.current = false; setBusy(false) }
  }

  return <>
    <SectionHead title={t('settings.appearance.title')} hint={t('settings.appearance.hint')} />
    <div className="appearance-status" role="status" aria-live="polite">
      {!settings ? t('common.loading') : busy ? t('settings.appearance.saving') : t('settings.appearance.autosave')}
    </div>
    <div className="appearance-controls" aria-busy={busy}
      onClickCapture={event => { if (busy) event.preventDefault() }}
      onKeyDownCapture={event => { if (busy && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Enter'].includes(event.key)) event.preventDefault() }}>
      <fieldset className="appearance-themes" disabled={!settings}>
        <legend>{t('settings.appearance.theme')}</legend>
        <div className="appearance-grid">
          {APP_THEMES.map(id => <label className="appearance-choice" key={id}>
            <input className="sr-only" type="radio" name="app-theme" value={id} checked={current.theme === id}
              aria-disabled={busy} aria-describedby={`appearance-${id}-hint`} onChange={() => void choose({ theme: id })} />
            <span className="appearance-card">
              <span className="appearance-preview-frame"><ThemePreview theme={getAppTheme(id, current.highSaturation)} /></span>
              <span className="appearance-card-text">
                <span className="appearance-card-title"><span className="appearance-radio" aria-hidden="true" />{t(`settings.appearance.theme.${id}`)}</span>
                <span className="appearance-card-hint" id={`appearance-${id}-hint`}>{t(`settings.appearance.theme.${id}.hint`)}</span>
              </span>
            </span>
          </label>)}
        </div>
      </fieldset>
      <div className="about-box appearance-saturation">
        <div className="row-act">
          <div className="row-act-text">
            <b>{t('settings.appearance.highSaturation')}</b>
            <span className="hint">{t('settings.appearance.highSaturationHint')}</span>
          </div>
          <Switch on={current.highSaturation} disabled={!settings || busy}
            title={t('settings.appearance.highSaturation')}
            onChange={highSaturation => void choose({ highSaturation })} />
        </div>
      </div>
      <fieldset className="appearance-motion about-box" disabled={!settings}>
        <legend className="sr-only">{t('settings.appearance.motion')}</legend>
        <h3>{t('settings.appearance.motion')}</h3>
        <p className="hint">{t('settings.appearance.motionHint')}</p>
        <div className="appearance-motion-options">
          {(['system', 'reduced'] as MotionPreference[]).map(motion => <label key={motion}>
            <input type="radio" name="app-motion" value={motion} checked={current.motion === motion}
              aria-disabled={busy} onChange={() => void choose({ motion })} />
            <span>{t(`settings.appearance.motion.${motion}`)}</span>
          </label>)}
        </div>
      </fieldset>
    </div>
    {error && <div className="editor-error" role="alert">{error}</div>}
  </>
}
