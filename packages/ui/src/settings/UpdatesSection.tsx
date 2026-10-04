import type React from 'react'
import { DEFAULT_UPDATE_SETTINGS, type AppSettings, type UpdateSettings } from '../../shared/ipc'
import { SectionHead, Switch } from '../about/parts'
import { useT } from '../i18n'
import { Icon } from '../icons'
import { UpdateCard } from '../UpdateCard'
import { canCheck } from '../updateState'
import { updatesProblem, type UpdatesController } from '../useUpdates'
import { getUiApi } from '../host'

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
      <Switch title={title} on={on} disabled={disabled} onChange={onChange} />
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
  const portable = state?.unsupportedReason === 'portable'
  // Старый main не знает `updates` — показываем дефолты, выключенными.
  const s = settings?.updates ?? DEFAULT_UPDATE_SETTINGS
  const problem = updatesProblem(updates) ?? error
  const web = getUiApi().app.environment === 'web'
  return (
    <>
      <SectionHead title={t('settings.updates.title')} hint={t(web ? 'shell.web.updateHint' : 'settings.updates.hint')}>
        <button type="button" className="btn-sm updates-check" disabled={updates.checking || !canCheck(state)} onClick={updates.check}>
          <Icon.refresh />{t('settings.updates.check')}
        </button>
      </SectionHead>
      <UpdateCard updates={updates} />
      {web && state?.mode !== 'server' && <p className="hint">{t('shell.web.updateUnmanaged')} <code>orca-web update</code></p>}
      {!web && <>
      <div className="updates-preferences-label">{t(portable ? 'settings.updates.checkPreferences' : 'settings.updates.preferences')}</div>
      <div className="about-box notif-rows">
        {portable && <div className="updates-portable-note">
          <Icon.info />
          <div><b>{t('settings.updates.portable.title')}</b><p>{t('settings.updates.portable.hint')}</p></div>
        </div>}
        <SwitchRow
          title={t('settings.updates.autoCheck')}
          hint={t('settings.updates.autoCheckHint')}
          on={s.autoCheck}
          disabled={!settings?.updates}
          onChange={(on) => onChange({ autoCheck: on })}
        />
        {!portable && <SwitchRow
          title={t('settings.updates.autoDownload')}
          hint={t('settings.updates.autoDownloadHint')}
          on={s.autoDownload}
          disabled={!settings?.updates}
          onChange={(on) => onChange({ autoDownload: on })}
        />}
        {!portable && <SwitchRow
          title={t('settings.updates.installWhenIdle')}
          hint={t('settings.updates.installWhenIdleHint')}
          on={s.installWhenIdle}
          disabled={!settings?.updates}
          onChange={(on) => onChange({ installWhenIdle: on })}
        />}
      </div>
      </>}
      {problem && <div className="editor-error">{problem}</div>}
    </>
  )
}
