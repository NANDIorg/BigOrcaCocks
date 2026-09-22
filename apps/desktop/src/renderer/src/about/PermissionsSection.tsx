import type React from 'react'
import { PERMISSION_MODES, type PermissionMode } from '../../../shared/ipc'
import { SectionHead } from './parts'

/** «Авто — Claude сам решает…» → название и пояснение режима. */
export function permissionParts(mode: PermissionMode): { title: string; desc: string } {
  const [title, ...rest] = PERMISSION_MODES[mode].split(' — ')
  return { title, desc: rest.join(' — ') }
}

/** Раздел «Разрешения агентов»: режим подтверждений Claude Code карточками-радио. */
export function PermissionsSection({ value, disabled, error, onChange }: {
  value: PermissionMode
  disabled?: boolean
  error: string | null
  onChange(mode: PermissionMode): void
}): React.JSX.Element {
  return (
    <>
      <SectionHead title="Разрешения агентов" hint="Как Claude Code (координатор и воркеры) обращается с подтверждениями." />
      <div className="perm-cards" role="radiogroup">
        {(Object.keys(PERMISSION_MODES) as PermissionMode[]).map((m) => {
          const { title, desc } = permissionParts(m)
          return (
            <label key={m} className={`perm-card ${value === m ? 'on' : ''}`}>
              <b>
                <input
                  type="radio"
                  name="permission-mode"
                  checked={value === m}
                  disabled={disabled}
                  onChange={() => onChange(m)}
                />
                {title}
              </b>
              <span>{desc}</span>
            </label>
          )
        })}
      </div>
      <p className="hint">Команда <code>orca-board</code> разрешена всегда. Действует на новые терминалы.</p>
      {error && <div className="editor-error">{error}</div>}
    </>
  )
}
