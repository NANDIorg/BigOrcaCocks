import type React from 'react'
import { useState } from 'react'
import type { Role } from '@orca-board/core'
import type { AppSettings } from '../../../shared/ipc'
import { NOTIFY_KINDS, NOTIFY_KIND_TITLES, isTime, type NotificationSettings, type NotificationSettingsPatch } from '../../../shared/notifications'
import { ipcErrorMessage } from '../useAutoSave'
import { SectionHead, Switch } from '../about/parts'

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
 * shared/notifications.ts shouldNotify). `roles` — роли всех проектов и дефолта, без повторов по id.
 */
export function NotificationsSection({ settings, roles, error, onChange }: {
  settings: AppSettings | null
  roles: Role[]
  error: string | null
  onChange(patch: NotificationSettingsPatch): void
}): React.JSX.Element {
  const [testError, setTestError] = useState<string | null>(null)
  const n: NotificationSettings | null = settings?.notifications ?? null
  const off = !n || !n.enabled

  function sendTest(): void {
    window.orca.app.testNotification().then(() => setTestError(null), (e) => setTestError(ipcErrorMessage(e)))
  }

  return (
    <>
      <SectionHead title="Уведомления" hint="Системные уведомления о событиях, которые ждут человека. Действуют на все проекты.">
        <button type="button" className="btn-sm" disabled={!n} onClick={sendTest}>Отправить тестовое уведомление</button>
      </SectionHead>
      <div className="about-box notif-rows">
        <SwitchRow
          title="Показывать уведомления"
          hint="Общий выключатель: без него уведомлений нет совсем."
          on={n?.enabled ?? true}
          disabled={!n}
          onChange={(on) => onChange({ enabled: on })}
        />
        <SwitchRow
          title="Со звуком"
          hint="Иначе уведомление приходит беззвучно."
          on={n?.sound ?? true}
          disabled={off}
          onChange={(on) => onChange({ sound: on })}
        />
        <SwitchRow
          title="Только когда окно не в фокусе"
          hint="Не уведомлять, пока вы смотрите на приложение."
          on={n?.onlyWhenUnfocused ?? false}
          disabled={off}
          onChange={(on) => onChange({ onlyWhenUnfocused: on })}
        />
        <SwitchRow
          title="Показывать текст"
          hint="Название задачи и текст вопроса / итога. Выключено — только вид события и проект."
          on={n?.showPreview ?? true}
          disabled={off}
          onChange={(on) => onChange({ showPreview: on })}
        />
      </div>

      <div className="about-box">
        <h3>События</h3>
        <div className="notif-checks">
          {NOTIFY_KINDS.map((k) => (
            <label key={k} className="notif-check" title={NOTIFY_KIND_TITLES[k].hint}>
              <input
                type="checkbox"
                checked={n?.events[k] ?? false}
                disabled={off}
                onChange={(e) => onChange({ events: { [k]: e.target.checked } })}
              />
              <span>
                {NOTIFY_KIND_TITLES[k].title}
                <small>{NOTIFY_KIND_TITLES[k].hint}</small>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="about-box">
        <h3>Роли</h3>
        <p className="hint notif-hint">От задач каких ролей уведомлять. «Прогон завершён» — от координатора. Новые роли включены.</p>
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
                {r.title || r.id}
                <small>{r.id}</small>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="about-box">
        <SwitchRow
          title="Тихие часы"
          hint="В этот интервал уведомления не показываются. Можно через полночь (22:00 — 08:00)."
          on={n?.quietHours.enabled ?? false}
          disabled={off}
          onChange={(on) => onChange({ quietHours: { enabled: on } })}
        />
        <div className="notif-quiet">
          <span>с</span>
          <input
            type="time"
            value={n?.quietHours.from ?? ''}
            disabled={off || !n?.quietHours.enabled}
            onChange={(e) => isTime(e.target.value) && onChange({ quietHours: { from: e.target.value } })}
          />
          <span>до</span>
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
