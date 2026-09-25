import type React from 'react'
import { useId } from 'react'
import { PERMISSION_MODES, type PermissionMode } from '../../../shared/ipc'
import { t, useT } from '../i18n'
import { SectionHead, withCode } from './parts'

/**
 * Название и пояснение режима на языке интерфейса. `PERMISSION_MODES` из shared — русские строки для main,
 * поэтому переводим по ключу режима.
 */
export function permissionParts(mode: PermissionMode): { title: string; desc: string } {
  return { title: t(`config.about.perm.${mode}`), desc: t(`config.about.perm.${mode}Desc`) }
}

/** Раздел «Разрешения агентов»: режим подтверждений Claude Code карточками-радио. */
export function PermissionsSection({ value, error, onChange }: {
  value: PermissionMode
  error: string | null
  onChange(mode: PermissionMode): void
}): React.JSX.Element {
  // Уникальное имя группы: раздел бывает открыт сразу во вкладке «О проекте» и в «Настройках».
  const name = useId()
  const t = useT()
  return (
    <>
      <SectionHead title={t('config.about.perm.title')} hint={t('config.about.perm.hint')} />
      <div className="perm-cards" role="radiogroup">
        {(Object.keys(PERMISSION_MODES) as PermissionMode[]).map((m) => {
          const { title, desc } = permissionParts(m)
          return (
            <label key={m} className={`perm-card ${value === m ? 'on' : ''}`}>
              <b>
                <input
                  type="radio"
                  name={name}
                  checked={value === m}
                  onChange={() => onChange(m)}
                />
                {title}
              </b>
              <span>{desc}</span>
            </label>
          )
        })}
      </div>
      <p className="hint">{withCode(t('config.about.perm.note'), 'orca-board')}</p>
      {error && <div className="editor-error">{error}</div>}
    </>
  )
}
