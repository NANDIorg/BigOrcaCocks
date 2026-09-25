import type React from 'react'
import { DEFAULT_UPDATE_SETTINGS, type AppSettings, type UpdateSettings } from '../../../shared/ipc'
import { SectionHead, Switch } from '../about/parts'
import { useT } from '../i18n'
import { canCheck, statusLine, versionLabel } from '../updateState'
import { updatesProblem, type UpdatesController } from '../useUpdates'

/** Строка «подпись + пояснение + переключатель». */
function SwitchRow({ title, hint, on, disabled, onChange }: {
  title: string
  hint: string
  on: boolean
  disabled?: boolean
  onChange(on: boolean): void
}): React.JSX.Element {
  return (
    <div className="row-act">
      <div className="row-act-text">
        <b>{title}</b>
        <span className="hint">{hint}</span>
      </div>
      <Switch on={on} disabled={disabled} onChange={onChange} />
    </div>
  )
}

/**
 * Раздел «Настройки → Обновления»: версия, «Проверить сейчас» и переключатели `AppSettings.updates`.
 * Состояние обновления — общее с плашкой в сайдбаре (`useUpdates` в App); настройки хранит main.
 */
export function UpdatesSection({ settings, updates, error, onChange }: {
  settings: AppSettings | null
  updates: UpdatesController
  error: string | null
  onChange(patch: Partial<UpdateSettings>): void
}): React.JSX.Element {
  const t = useT()
  const { state } = updates
  // Старый main не знает `updates` — показываем дефолты, выключенными.
  const s = settings?.updates ?? DEFAULT_UPDATE_SETTINGS
  const problem = updatesProblem(updates) ?? error
  return (
    <>
      <SectionHead title={t('settings.updates.title')} hint={t('settings.updates.hint')}>
        <button type="button" className="btn-sm" disabled={!canCheck(state)} onClick={updates.check}>
          {t('settings.updates.check')}
        </button>
      </SectionHead>
      <div className="about-box">
        <div className="row-act">
          <div className="row-act-text">
            <b>{t('settings.updates.current')}</b>
            <span className="hint">{state ? versionLabel(state.currentVersion) : t('common.loading')}</span>
          </div>
        </div>
        {state && <p className="hint updates-status">{statusLine(state)}</p>}
      </div>
      <div className="about-box notif-rows">
        <SwitchRow
          title={t('settings.updates.autoCheck')}
          hint={t('settings.updates.autoCheckHint')}
          on={s.autoCheck}
          disabled={!settings?.updates}
          onChange={(on) => onChange({ autoCheck: on })}
        />
        <SwitchRow
          title={t('settings.updates.autoDownload')}
          hint={t('settings.updates.autoDownloadHint')}
          on={s.autoDownload}
          disabled={!settings?.updates}
          onChange={(on) => onChange({ autoDownload: on })}
        />
        <SwitchRow
          title={t('settings.updates.installWhenIdle')}
          hint={t('settings.updates.installWhenIdleHint')}
          on={s.installWhenIdle}
          disabled={!settings?.updates}
          onChange={(on) => onChange({ installWhenIdle: on })}
        />
      </div>
      {problem && <div className="editor-error">{problem}</div>}
    </>
  )
}
