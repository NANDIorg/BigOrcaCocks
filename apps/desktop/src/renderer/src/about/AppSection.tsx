import type React from 'react'
import type { AppSettings } from '../../../shared/ipc'
import { SectionHead, Switch } from './parts'

/** Раздел «Приложение → Общие»: настройки, действующие на все проекты. */
export function AppSection({ settings, error, onChange }: {
  settings: AppSettings | null
  error: string | null
  onChange(patch: Partial<AppSettings>): void
}): React.JSX.Element {
  return (
    <>
      <SectionHead title="Общие настройки приложения" hint="Действуют на все проекты." />
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
