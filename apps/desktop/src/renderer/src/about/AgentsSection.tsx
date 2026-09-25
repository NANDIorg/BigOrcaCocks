import type React from 'react'
import type { AgentInfo, AgentKind } from '@orca-board/core'
import { AgentLogo } from '../AgentLogo'
import { Icon } from '../icons'
import { useT } from '../i18n'
import { SectionHead, Switch } from './parts'

interface Props {
  /** Агенты из реестра; enabled — включённость в проекте или в дефолте. */
  agents: AgentInfo[]
  /** Только для дефолта: «все установленные» (enabledAgents не задан) и его переключение. */
  all?: { on: boolean; onChange(on: boolean): void }
  error: string | null
  onToggle(id: AgentKind, on: boolean): void
  onRefresh(): void
}

/** Раздел «Агенты»: карточки установленных с переключателем; не установленные — под спойлером. */
export function AgentsSection({ agents, all, error, onToggle, onRefresh }: Props): React.JSX.Element {
  const t = useT()
  const installed = agents.filter((a) => a.installed)
  const missing = agents.filter((a) => !a.installed)

  const card = (a: AgentInfo): React.JSX.Element => (
    <div key={a.id} className={`agent-card ${a.installed ? '' : 'off'}`}>
      <AgentLogo agent={a.id} size={22} />
      <div className="agent-card-text">
        <b>{a.title}</b>
        <span>{a.installed ? a.version ?? t('config.about.agents.installed') : t('config.about.agents.notInstalled')}</span>
      </div>
      <Switch
        on={a.installed && a.enabled}
        disabled={!a.installed || all?.on}
        title={all?.on ? t('config.about.agents.allOnTitle') : a.enabled ? t('config.about.agents.disable') : t('config.about.agents.enable')}
        onChange={(on) => onToggle(a.id, on)}
      />
    </div>
  )

  return (
    <>
      <SectionHead
        title={t('config.about.nav.agents')}
        hint={t('config.about.agents.hint')}
      >
        <button className="btn-sm" onClick={onRefresh}><Icon.refresh /> {t('config.about.agents.refresh')}</button>
      </SectionHead>
      {all && (
        <div className="about-box">
          <div className="row-act">
            <div className="row-act-text">
              <b>{t('config.about.agents.all')}</b>
              <span className="hint">{t('config.about.agents.allHint')}</span>
            </div>
            <Switch on={all.on} onChange={all.onChange} />
          </div>
        </div>
      )}
      <div className="agent-cards">
        {installed.map(card)}
        {installed.length === 0 && <div className="muted">{t('config.about.agents.none')}</div>}
      </div>
      {missing.length > 0 && (
        <details className="agents-missing">
          <summary className="muted">{t('config.about.agents.missing', { count: missing.length })}</summary>
          <div className="agent-cards">{missing.map(card)}</div>
        </details>
      )}
      {error && <div className="editor-error">{error}</div>}
    </>
  )
}
