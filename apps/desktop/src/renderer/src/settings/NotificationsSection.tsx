import type React from 'react'
import { useState } from 'react'
import type { Role } from '@orca-board/core'
import type { AppSettings } from '../../../shared/ipc'
import { NOTIFY_KINDS, isTime, type NotificationSettings, type NotificationSettingsPatch } from '../../../shared/notifications'
import { ipcErrorMessage } from '../useAutoSave'
import { SectionHead, Switch } from '../about/parts'
import { useT } from '../i18n'
import { builtinText } from '../defaultTitles'

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
 * Раздел «Настройки → Уведомления»: системные уведомления приложения (main/index.ts notify, фильтр
 * shared/notifications.ts shouldNotify). `roles` — роли всех типов задач библиотеки, без повторов по id.
 */
export function NotificationsSection({ settings, roles, error, onChange }: {
  settings: AppSettings | null
  roles: Role[]
  error: string | null
  onChange(patch: NotificationSettingsPatch): void
}): React.JSX.Element {
  const t = useT()
  const [testError, setTestError] = useState<string | null>(null)
  const n: NotificationSettings | null = settings?.notifications ?? null
  const off = !n || !n.enabled

  function sendTest(): void {
    window.orca.app.testNotification().then(() => setTestError(null), (e) => setTestError(ipcErrorMessage(e)))
  }

  return (
    <>
      <SectionHead title={t('settings.notify.title')} hint={t('settings.notify.hint')}>
        <button type="button" className="btn-sm" disabled={!n} onClick={sendTest}>{t('settings.notify.test')}</button>
      </SectionHead>
      <div className="about-box notif-rows">
        <SwitchRow
          title={t('settings.notify.enabled')}
          hint={t('settings.notify.enabledHint')}
          on={n?.enabled ?? true}
          disabled={!n}
          onChange={(on) => onChange({ enabled: on })}
        />
        <SwitchRow
          title={t('settings.notify.sound')}
          hint={t('settings.notify.soundHint')}
          on={n?.sound ?? true}
          disabled={off}
          onChange={(on) => onChange({ sound: on })}
        />
        <SwitchRow
          title={t('settings.notify.unfocused')}
          hint={t('settings.notify.unfocusedHint')}
          on={n?.onlyWhenUnfocused ?? false}
          disabled={off}
          onChange={(on) => onChange({ onlyWhenUnfocused: on })}
        />
        <SwitchRow
          title={t('settings.notify.preview')}
          hint={t('settings.notify.previewHint')}
          on={n?.showPreview ?? true}
          disabled={off}
          onChange={(on) => onChange({ showPreview: on })}
        />
      </div>

      <div className="about-box">
        <h3>{t('settings.notify.events')}</h3>
        <div className="notif-checks">
          {NOTIFY_KINDS.map((k) => (
            <label key={k} className="notif-check" title={t(`settings.notify.kind.${k}Hint`)}>
              <input
                type="checkbox"
                checked={n?.events[k] ?? false}
                disabled={off}
                onChange={(e) => onChange({ events: { [k]: e.target.checked } })}
              />
              <span>
                {t(`settings.notify.kind.${k}`)}
                <small>{t(`settings.notify.kind.${k}Hint`)}</small>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="about-box">
        <h3>{t('settings.notify.roles')}</h3>
        <p className="hint notif-hint">{t('settings.notify.rolesHint')}</p>
        <div className="notif-checks">
          {roles.map((r) => (
            <label key={r.id} className="notif-check">
              <input
                type="checkbox"
                checked={n?.roles[r.id] !== false}
                disabled={off}
                onChange={(e) => onChange({ roles: { [r.id]: e.target.checked } })}
              />
              <span>
                {r.title ? builtinText(r.title) : r.id}
                <small>{r.id}</small>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="about-box">
        <SwitchRow
          title={t('settings.notify.quiet')}
          hint={t('settings.notify.quietHint')}
          on={n?.quietHours.enabled ?? false}
          disabled={off}
          onChange={(on) => onChange({ quietHours: { enabled: on } })}
        />
        <div className="notif-quiet">
          <span>{t('settings.notify.quietFrom')}</span>
          <input
            type="time"
            value={n?.quietHours.from ?? ''}
            disabled={off || !n?.quietHours.enabled}
            onChange={(e) => isTime(e.target.value) && onChange({ quietHours: { from: e.target.value } })}
          />
          <span>{t('settings.notify.quietTo')}</span>
          <input
            type="time"
            value={n?.quietHours.to ?? ''}
            disabled={off || !n?.quietHours.enabled}
            onChange={(e) => isTime(e.target.value) && onChange({ quietHours: { to: e.target.value } })}
          />
        </div>
      </div>
      {(error || testError) && <div className="editor-error">{error ?? testError}</div>}
    </>
  )
}
