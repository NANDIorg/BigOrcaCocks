import type React from 'react'
import type { AppSettings, AppSettingsPatch } from '../../../shared/ipc'
import { SectionHead, Switch } from '../about/parts'

/** Раздел «Настройки → Общие»: настройки приложения, действующие на все проекты. */
export function GeneralSection({ settings, error, onChange }: {
  settings: AppSettings | null
  error: string | null
  onChange(patch: AppSettingsPatch): void
}): React.JSX.Element {
  return (
    <>
      <SectionHead title="Общие" hint="Настройки приложения; действуют на все проекты." />
      <div className="about-box">
        <div className="row-act">
          <div className="row-act-text">
            <b>Работать в фоне при закрытии окна</b>
            <span className="hint">Агенты продолжат работу; приложение живёт в иконке строки меню / трея.</span>
          </div>
          <Switch
            on={settings?.keepInBackground ?? true}
            disabled={!settings}
            onChange={(on) => onChange({ keepInBackground: on })}
          />
        </div>
      </div>
      {error && <div className="editor-error">{error}</div>}
    </>
  )
}
