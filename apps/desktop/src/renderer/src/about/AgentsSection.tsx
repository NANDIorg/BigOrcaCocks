import type React from 'react'
import type { AgentInfo, AgentKind } from '@orca-board/core'
import { AgentLogo } from '../AgentLogo'
import { Icon } from '../icons'
import { SectionHead, Switch } from './parts'

interface Props {
  /** Агенты из реестра; enabled — включённость в текущем режиме (проект или дефолт). */
  agents: AgentInfo[]
  /** Только для дефолта: «все установленные» (enabledAgents не задан) и его переключение. */
  all?: { on: boolean; onChange(on: boolean): void }
  /** Нет проекта — переключатели недоступны. */
  disabled?: boolean
  error: string | null
  onToggle(id: AgentKind, on: boolean): void
  onRefresh(): void
}

/** Раздел «Агенты»: карточки установленных с переключателем; не установленные — под спойлером. */
export function AgentsSection({ agents, all, disabled, error, onToggle, onRefresh }: Props): React.JSX.Element {
  const installed = agents.filter((a) => a.installed)
  const missing = agents.filter((a) => !a.installed)

  const card = (a: AgentInfo): React.JSX.Element => (
    <div key={a.id} className={`agent-card ${a.installed ? '' : 'off'}`}>
      <AgentLogo agent={a.id} size={22} />
      <div className="agent-card-text">
        <b>{a.title}</b>
        <span>{a.installed ? a.version ?? 'установлен' : 'не установлен'}</span>
      </div>
      <Switch
        on={a.installed && a.enabled}
        disabled={disabled || !a.installed || all?.on}
        title={all?.on ? 'Включены все установленные' : a.enabled ? 'Выключить' : 'Включить'}
        onChange={(on) => onToggle(a.id, on)}
      />
    </div>
  )

  return (
    <>
      <SectionHead
        title="Агенты"
        hint="Выключенные агенты нельзя выбрать для роли; координатор их тоже не предложит. Установленные определяются по PATH."
      >
        <button className="btn-sm" onClick={onRefresh}><Icon.refresh /> Обновить</button>
      </SectionHead>
      {all && (
        <div className="about-box">
          <div className="row-act">
            <div className="row-act-text">
              <b>Все установленные</b>
              <span className="hint">Новые агенты, появившиеся в PATH, включатся сами.</span>
            </div>
            <Switch on={all.on} onChange={all.onChange} />
          </div>
        </div>
      )}
      <div className="agent-cards">
        {installed.map(card)}
        {installed.length === 0 && <div className="muted">Установленных агентов не найдено.</div>}
      </div>
      {missing.length > 0 && (
        <details className="agents-missing">
          <summary className="muted">Не установлены · {missing.length}</summary>
          <div className="agent-cards">{missing.map(card)}</div>
        </details>
      )}
      {error && <div className="editor-error">{error}</div>}
    </>
  )
}
