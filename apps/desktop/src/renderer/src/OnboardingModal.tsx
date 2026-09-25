import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { AgentInfo } from '@orca-board/core'
import type { AppSettings, AppSettingsPatch, Project } from '../../shared/ipc'
import { AgentLogo } from './AgentLogo'
import { Icon } from './icons'
import { LOCALES, LOCALE_NAMES, useLocale, useT } from './i18n'
import { agentTitle } from './defaultTitles'
import { saveAppSettings } from './appSettingsSave'
import { completeOnboarding } from './onboarding'
import { ipcErrorMessage } from './ipcError'
import { Switch } from './about/parts'

/** `first` — первый запуск: «Готово»/«Пропустить» записывают статус; `rerun` — из «Настроек», статус уже записан. */
export type OnboardingMode = 'first' | 'rerun'

const STEPS = 3

interface Props {
  mode: OnboardingMode
  /** Проекты приложения: шаг 3 показывает добавленные (App перечитывает их после `addProject`). */
  projects: Project[]
  /** Тот же флоу «Добавить репозиторий», что в сайдбаре (`addProject` в App.tsx): папка → тип → проект. */
  onAddProject(): Promise<void>
  /** Поверх мастера открыта другая модалка (выбор типа проекта): Esc принадлежит ей. */
  suspended: boolean
  onClose(): void
}

/**
 * Мастер первого запуска: оверлей из трёх шагов (язык и фон → агенты → первый проект). Ничто не блокирует «Далее»:
 * агентов и проект можно добавить позже. «Пропустить»/Esc/крестик записывают `skipped`, «Готово» — `completed`.
 */
export function OnboardingModal({ mode, projects, onAddProject, suspended, onClose }: Props): React.JSX.Element {
  const t = useT()
  const [step, setStep] = useState(0)
  const finishing = useRef(false)

  /** Закрыть мастер: в первом запуске сначала записать статус (ошибка записи не мешает закрытию). */
  async function finish(skipped: boolean): Promise<void> {
    if (finishing.current) return
    finishing.current = true
    if (mode === 'first') await completeOnboarding(window.orca, skipped)
    onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || suspended) return
      e.stopPropagation()
      void finish(true)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const last = step === STEPS - 1
  return (
    <div className="modal-backdrop onboarding-backdrop">
      <div className="modal onboarding" role="dialog" aria-modal="true" aria-label={t('onboarding.title')}>
        <div className="onboarding-head">
          <div className="onboarding-head-text">
            <h3>{t('onboarding.title')}</h3>
            <span className="muted onboarding-step">{t('onboarding.step', { n: step + 1, total: STEPS })}</span>
          </div>
          <button
            className="icon-btn task-modal-close"
            title={mode === 'first' ? t('onboarding.skip') : t('onboarding.close')}
            aria-label={mode === 'first' ? t('onboarding.skip') : t('onboarding.close')}
            onClick={() => void finish(true)}
          >
            <Icon.close />
          </button>
        </div>
        <div className="onboarding-dots" role="list" aria-label={t('onboarding.progressAria')}>
          {Array.from({ length: STEPS }, (_, i) => (
            <span key={i} role="listitem" aria-current={i === step ? 'step' : undefined} className={`onboarding-dot${i === step ? ' active' : i < step ? ' passed' : ''}`} />
          ))}
        </div>
        <div className="onboarding-body">
          {step === 0 && <LanguageStep />}
          {step === 1 && <AgentsStep />}
          {step === 2 && <ProjectStep projects={projects} onAddProject={onAddProject} />}
        </div>
        <div className="row onboarding-foot">
          <button className="btn-text" onClick={() => void finish(true)}>
            {mode === 'first' ? t('onboarding.skip') : t('onboarding.close')}
          </button>
          <span className="onboarding-foot-gap" />
          {step > 0 && <button className="btn-text" onClick={() => setStep(step - 1)}>{t('onboarding.back')}</button>}
          <button className="btn-primary" autoFocus onClick={() => (last ? void finish(false) : setStep(step + 1))}>
            {last ? t('onboarding.done') : t('onboarding.next')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Шаг 1: язык (переводится на лету) и «Работать в фоне». Запись — тот же хелпер, что в «Настройки → Общие». */
function LanguageStep(): React.JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.orca.app.getSettings().then(setSettings, (e) => setError(ipcErrorMessage(e)))
  }, [])

  async function save(patch: AppSettingsPatch): Promise<void> {
    const res = await saveAppSettings(window.orca.app, patch)
    if (res.settings) setSettings(res.settings)
    setError(res.error)
  }

  return (
    <>
      <h4>{t('onboarding.language.title')}</h4>
      <p className="muted">{t('onboarding.language.hint')}</p>
      <div className="about-box">
        <div className="row-act">
          <div className="row-act-text">
            <b>{t('onboarding.language.label')}</b>
          </div>
          <div className="segmented" role="radiogroup" aria-label={t('onboarding.language.label')}>
            {LOCALES.map((l) => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={locale === l}
                className={`seg ${locale === l ? 'active' : ''}`}
                onClick={() => void save({ language: l })}
              >
                {LOCALE_NAMES[l]}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="about-box">
        <div className="row-act">
          <div className="row-act-text">
            <b>{t('onboarding.background.label')}</b>
            <span className="hint">{t('onboarding.background.hint')}</span>
          </div>
          <Switch on={settings?.keepInBackground ?? true} disabled={!settings} onChange={(on) => void save({ keepInBackground: on })} />
        </div>
      </div>
      {error && <div className="editor-error">{error}</div>}
    </>
  )
}

/** Шаг 2: какие агенты нашлись в PATH. Только проверка — включение агентов живёт у проекта. */
function AgentsStep(): React.JSX.Element {
  const t = useT()
  const [agents, setAgents] = useState<AgentInfo[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function check(): Promise<void> {
    setBusy(true)
    try {
      setAgents(await window.orca.agents.list(true))
      setError(null)
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void check()
  }, [])

  // Оболочка (`shell`) — не агент для мастера: она есть всегда и не отвечает на вопрос «что установлено».
  const list = (agents ?? []).filter((a) => a.id !== 'shell')
  const sorted = [...list.filter((a) => a.installed), ...list.filter((a) => !a.installed)]
  const none = agents !== null && !list.some((a) => a.installed)

  return (
    <>
      <div className="onboarding-agents-head">
        <div>
          <h4>{t('onboarding.agents.title')}</h4>
          <p className="muted">{t('onboarding.agents.hint')}</p>
        </div>
        <button className="btn-sm" disabled={busy} onClick={() => void check()}>
          <Icon.refresh /> {busy ? t('onboarding.agents.checking') : t('onboarding.agents.recheck')}
        </button>
      </div>
      <div className="agent-cards">
        {sorted.map((a) => (
          <div key={a.id} className={`agent-card ${a.installed ? '' : 'off'}`}>
            <AgentLogo agent={a.id} size={22} />
            <div className="agent-card-text">
              <b>{agentTitle(a.id)}</b>
              <span>{a.installed ? a.version ?? t('onboarding.agents.installed') : t('onboarding.agents.missing')}</span>
            </div>
          </div>
        ))}
      </div>
      {none && <div className="onboarding-note">{t('onboarding.agents.none')}</div>}
      {error && <div className="editor-error">{t('onboarding.agents.error', { error })}</div>}
    </>
  )
}

/** Шаг 3: первый проект — тем же `addProject()`, что в сайдбаре; список добавленных обновляется вместе с App. */
function ProjectStep({ projects, onAddProject }: { projects: Project[]; onAddProject(): Promise<void> }): React.JSX.Element {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function add(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await onAddProject()
    } catch (e) {
      setError(t('onboarding.project.error', { error: ipcErrorMessage(e) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h4>{t('onboarding.project.title')}</h4>
      <p className="muted">{t('onboarding.project.hint')}</p>
      <div>
        <button className="btn-primary ghost onboarding-add" disabled={busy} onClick={() => void add()}>
          <Icon.plus /> {busy ? t('onboarding.project.adding') : t('onboarding.project.add')}
        </button>
      </div>
      {error && <div className="editor-error">{error}</div>}
      <div className="onboarding-projects">
        <span className="muted">{t('onboarding.project.added')}</span>
        {projects.length === 0 ? (
          <span className="muted onboarding-none">{t('onboarding.project.none')}</span>
        ) : (
          projects.map((p) => (
            <div key={p.id} className="onboarding-project" title={p.root}>
              <Icon.folder />
              <b>{p.name}</b>
              <span className="muted">{p.root}</span>
            </div>
          ))
        )}
      </div>
    </>
  )
}
