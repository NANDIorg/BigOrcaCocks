import type React from 'react'
import { AgentLogo } from './AgentLogo'
import { Icon } from './icons'
import { useT } from './i18n'
import appLogo from '../../../build/icon.svg'

/** Схема иллюстрирует оркестрацию, а реальный результат проверки CLI находится на шаге «Агенты». */
export function OnboardingScene({ step }: { step: 0 | 1 | 2 | 3 }): React.JSX.Element {
  const t = useT()
  return <aside className="onboarding-story">
    <div className="onboarding-brand">
      <img src={appLogo} alt="" width={44} height={44} />
      <div><b>Orca Board</b><span>{t('onboarding.brand.caption')}</span></div>
    </div>
    <div className="onboarding-story-copy">
      <h2>{t('onboarding.story.title')}<br /><span>{t('onboarding.story.accent')}</span></h2>
      <p>{t(`onboarding.story.${step}`)}</p>
    </div>
    <div className="onboarding-network" aria-hidden="true">
      <div className="onboarding-network-orbit" />
      <svg className="onboarding-network-lines" viewBox="0 0 310 240" fill="none">
        <path d="M155 77V103Q155 130 128 130H65V175M155 130V175M155 130H245V175" />
        <path className="onboarding-signal" d="M155 77V103Q155 130 128 130H65V175M155 130V175M155 130H245V175" />
      </svg>
      <div className="onboarding-network-hub"><img src={appLogo} alt="" width={84} height={84} /></div>
      {(['claude', 'codex', 'gemini'] as const).map((agent, index) =>
        <div key={agent} className={`onboarding-network-agent node-${index}`}><AgentLogo agent={agent} size={29} /></div>
      )}
      <span className="onboarding-network-caption">{t('onboarding.story.example')}</span>
    </div>
    <div className="onboarding-workflow" aria-hidden="true">
      <span><Icon.layers />{t('onboarding.story.goal')}</span><Icon.chevron />
      <span><Icon.branch />{t('onboarding.story.work')}</span><Icon.chevron />
      <span><Icon.shield />{t('onboarding.story.review')}</span>
    </div>
    <div className="onboarding-story-foot"><span />{t('onboarding.story.foot')}</div>
  </aside>
}
