import type React from 'react'
import type { AppSettings } from '../../shared/ipc'
import { AgentLogo } from './AgentLogo'
import { agentTitle } from './defaultTitles'
import { Icon } from './icons'
import { useLocale, useT } from './i18n'
import appLogo from '../../../build/icon.svg'

const workspaces = [
  { agent: 'claude', input: 'M155 48V62C155 80 53 74 53 100', output: 'M53 206C53 239 155 224 155 260' },
  { agent: 'codex', input: 'M155 48V100', output: 'M155 206V260' },
  { agent: 'gemini', input: 'M155 48V62C155 80 257 74 257 100', output: 'M257 206C257 239 155 224 155 260' }
] as const

/** Схема иллюстрирует оркестрацию, а реальный результат проверки CLI находится на шаге «Агенты». */
export function OnboardingScene({ step, settings }: { step: 0 | 1 | 2 | 3; settings: AppSettings | null }): React.JSX.Element {
  const t = useT()
  return <aside className="onboarding-story">
    <div className="onboarding-brand">
      <img src={appLogo} alt="" width={44} height={44} />
      <div><b>Orca Board</b><span>{t('onboarding.brand.caption')}</span></div>
    </div>
    <div className="onboarding-story-copy">
      <h2>{t(`onboarding.scene.title.${step}`)}</h2>
      <p>{t(`onboarding.story.${step}`)}</p>
    </div>
    <div className="onboarding-illustration" aria-hidden="true">
      <div className={`onboarding-illustration-scene${step === 0 ? ' current' : ''}`}><WorkPicture /></div>
      <div className={`onboarding-illustration-scene${step === 1 ? ' current' : ''}`}><PreferencesPicture settings={settings} /></div>
      <div className={`onboarding-illustration-scene${step === 2 ? ' current' : ''}`}><AgentsPicture /></div>
      <div className={`onboarding-illustration-scene${step === 3 ? ' current' : ''}`}><RepositoryPicture /></div>
    </div>
    <div className="onboarding-story-foot"><span />{t('onboarding.story.foot')}</div>
  </aside>
}

function WorkPicture(): React.JSX.Element {
  const t = useT()
  return <div className="onboarding-workbench">
      <svg className="onboarding-workbench-routes" viewBox="0 0 310 306" fill="none" strokeLinecap="round">
        {workspaces.map(workspace => <g key={workspace.agent}>
          <path d={workspace.input} />
          <path className="onboarding-fork-signal" d={workspace.input} pathLength={1} />
          <path d={workspace.output} />
        </g>)}
      </svg>
      <div className="onboarding-ticket">
        <Icon.layers /><b>{t('onboarding.scene.task')}</b><span><i /><i /><i /></span>
      </div>
      {workspaces.map((workspace, index) => <div key={workspace.agent} className={`onboarding-workspace lane-${index}`} style={{ '--lane-delay': `${index * 650}ms`, '--handoff-path': `path('${workspace.output}')` } as React.CSSProperties}>
        <div className="onboarding-workspace-card">
          <AgentLogo agent={workspace.agent} size={24} />
          <span className="onboarding-workspace-branch"><Icon.branch />{t('onboarding.scene.branch', { index: `0${index + 1}` })}</span>
          <div className="onboarding-code"><span /><span /><span /></div>
          <div className="onboarding-workspace-progress"><span /></div>
        </div>
        <div className="onboarding-packet"><span /><span /></div>
      </div>)}
      <div className="onboarding-review-tray">
        <div className="onboarding-review-back" />
        <Icon.shield /><b>{t('onboarding.story.review')}</b>
        <svg className="onboarding-review-check" viewBox="0 0 20 20" fill="none"><path d="m5 10 3 3 7-7" pathLength={1} /></svg>
      </div>
  </div>
}

/** Декоративные переключатели отражают подтверждённые настройки; ввод остаётся справа. */
function PreferencesPicture({ settings }: { settings: AppSettings | null }): React.JSX.Element {
  const locale = useLocale()
  return <div className="onboarding-preferences-picture">
    <div className="onboarding-control-back"><Icon.gear /><span /><span /><span /></div>
    <div className={`onboarding-language-plate${locale === 'en' ? ' en' : ''}`}>
      <div className="onboarding-language-indicator" /><span>RU</span><span>EN</span>
    </div>
    <div className="onboarding-control-plate">
      <div><Icon.terminal /><span /><div className={`onboarding-picture-switch${settings?.keepInBackground !== false ? ' on' : ''}`}><i /></div></div>
      <div><Icon.bell /><span /><div className={`onboarding-picture-switch${settings?.notifications.enabled !== false ? ' on' : ''}`}><i /></div></div>
    </div>
    <div className={`onboarding-notification-paper${settings?.notifications.enabled === false ? ' muted' : ''}`}>
      <Icon.bell /><div><i /><i /></div><span />
    </div>
  </div>
}

function AgentsPicture(): React.JSX.Element {
  return <div className="onboarding-agents-picture">
    <svg className="onboarding-scanner-frame" viewBox="0 0 310 306" fill="none">
      <path d="M45 37V24h24M265 37V24h-24M45 269v13h24M265 269v13h-24" />
      <path className="onboarding-scanner-guide" d="M155 37v232" />
    </svg>
    {(['claude', 'codex', 'gemini'] as const).map((agent, index) => <div className={`onboarding-discovery-card discovery-${index}`} key={agent}>
      <AgentLogo agent={agent} size={27} /><div><b>{agentTitle(agent)}</b><span /><span /></div><i />
    </div>)}
    <div className="onboarding-scanner-beam"><i /><span /><i /></div>
    <div className="onboarding-scanner-tab"><Icon.terminal /><span>CLI</span></div>
  </div>
}

function RepositoryPicture(): React.JSX.Element {
  const t = useT()
  return <div className="onboarding-repository-picture">
    <svg className="onboarding-folder-back" viewBox="0 0 310 306">
      <path d="M42 228V101q0-12 12-12h55l19 19h125q15 0 15 15v105z" />
    </svg>
    <div className="onboarding-repository-sheet sheet-back"><span /><span /><span /></div>
    <div className="onboarding-repository-sheet sheet-front">
      <svg viewBox="0 0 110 128" fill="none">
        <path d="M30 21v88M30 67c0-29 49-10 49-42" />
        <circle cx="30" cy="21" r="5" /><circle cx="30" cy="109" r="5" /><circle cx="79" cy="25" r="5" />
        <path className="onboarding-repository-trace" d="M30 98V67c0-29 49-10 49-42" pathLength={1} />
      </svg>
    </div>
    <svg className="onboarding-folder-front" viewBox="0 0 310 306">
      <path d="M26 161q-3-12 10-12h238q13 0 10 12l-18 103q-2 11-15 11H59q-13 0-15-11z" />
    </svg>
    <div className="onboarding-folder-label"><Icon.folder /><b>{t('onboarding.scene.repository')}</b></div>
    <div className="onboarding-repository-stamp"><Icon.branch /></div>
  </div>
}
