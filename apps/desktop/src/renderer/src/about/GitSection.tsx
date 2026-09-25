import type React from 'react'
import { useEffect, useState } from 'react'
import { normalizeRunBranchSettings, runBranchName, runBranchSettingsProblems, type RunBranchSettings } from '@orca-board/core'
import type { Project } from '../../../shared/ipc'
import { staleAppMessage } from '../docLinks'
import { currentBranchProtected, GIT_FINISHES, gitFinish, gitFlow, withGitFinish } from '../gitSettingsForm'
import { ipcErrorMessage } from '../useAutoSave'
import { useProjectBranch } from '../useProjectBranch'
import { useT } from '../i18n'
import { SectionHead, withCode } from './parts'

/** Форма: защищённые ветки редактируются строкой через запятую. */
interface Draft extends Omit<RunBranchSettings, 'protected'> {
  protected: string
}

function toDraft(s: RunBranchSettings): Draft {
  return { ...s, protected: s.protected.join(', ') }
}

function fromDraft(d: Draft): RunBranchSettings {
  return normalizeRunBranchSettings({ ...d, protected: d.protected.split(',') })
}

const EXAMPLE_BASE = 'origin/develop'

/**
 * Раздел «Git» проекта. Сначала главный вопрос — куда сливается готовая работа агентов (два режима-карточки),
 * под выбранным режимом — только его настройки; технические поля свёрнуты в «Дополнительно».
 * Сохраняется кнопкой: полусобранный шаблон ветки не должен уходить в main на каждый символ.
 */
export function GitSection({ project, onProjectChanged }: {
  project: Project
  onProjectChanged(): Promise<void>
}): React.JSX.Element {
  const t = useT()
  const saved = normalizeRunBranchSettings(project.git)
  const [draft, setDraft] = useState<Draft>(() => toDraft(saved))
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const branchInfo = useProjectBranch(project.id).info
  const current = branchInfo?.branch ?? null

  // Проект сменился или настройки пришли из main — форма заново.
  const savedKey = JSON.stringify(saved)
  useEffect(() => {
    setDraft(toDraft(normalizeRunBranchSettings(project.git)))
    setError(null)
  }, [project.id, savedKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const next = fromDraft(draft)
  const problems = runBranchSettingsProblems(next)
  const dirty = JSON.stringify(next) !== savedKey
  const example = runBranchName(next.template, { id: 'run_mh2k9x1', title: t('config.about.git.exampleTitle') })
  const finish = gitFinish(draft)
  const blocked = currentBranchProtected(current, draft.protected)

  function set<K extends keyof Draft>(key: K, value: Draft[K]): void {
    setDraft((d) => ({ ...d, [key]: value }))
    setDone(false)
  }

  async function save(): Promise<void> {
    // Renderer обновился по HMR, а preload старый — метода ещё нет.
    const setGit = window.orca.projects.setGit
    if (!setGit) {
      setError(staleAppMessage())
      return
    }
    try {
      await setGit(project.id, next)
      setError(null)
      setDone(true)
    } catch (e) {
      setError(ipcErrorMessage(e))
    }
    await onProjectChanged()
  }

  const protectedField = (
    <label>
      <span>{t('config.about.git.protected')}</span>
      <input value={draft.protected} onChange={(e) => set('protected', e.target.value)} />
      <span className="hint">{t('config.about.git.protectedHint')}</span>
    </label>
  )

  return (
    <>
      <SectionHead title={t('config.about.nav.git')} hint={t('config.about.git.hint')} />
      <h3 className="git-question">{t('config.about.git.question')}</h3>
      <div className="git-modes" role="radiogroup" aria-label={t('config.about.git.question')}>
        <ModeCard
          active={!draft.enabled}
          title={t('config.about.git.mode.current')}
          hint={t('config.about.git.mode.currentHint')}
          flow={gitFlow(next, current, 'current')}
          onSelect={() => set('enabled', false)}
        >
          <div className="git-form">
            {protectedField}
            {blocked && current && (
              <div className="editor-error">{withCode(t('config.about.git.protectedBlocked'), current, 'branch')}</div>
            )}
          </div>
        </ModeCard>
        <ModeCard
          active={draft.enabled}
          title={t('config.about.git.mode.run')}
          hint={t('config.about.git.mode.runHint')}
          flow={gitFlow(next, current, 'run')}
          onSelect={() => set('enabled', true)}
        >
          <div className="git-form">
            <div className="git-finish">
              <span>{t('config.about.git.finish')}</span>
              <div className="segmented" role="radiogroup" aria-label={t('config.about.git.finish')}>
                {GIT_FINISHES.map((f) => (
                  <button
                    key={f}
                    type="button"
                    role="radio"
                    aria-checked={finish === f}
                    className={`seg ${finish === f ? 'active' : ''}`}
                    onClick={() => { setDraft((d) => ({ ...d, ...withGitFinish(f) })); setDone(false) }}
                  >
                    {t(`config.about.git.finish.${f}`)}
                  </button>
                ))}
              </div>
              <span className="hint">{t(`config.about.git.finish.${finish}Hint`)}</span>
            </div>
            <details className="git-more">
              <summary>{t('config.about.git.more')}</summary>
              <div className="git-form">
                <label>
                  <span>{t('config.about.git.base')}</span>
                  <input
                    value={draft.base}
                    placeholder={t('config.about.git.basePlaceholder')}
                    onChange={(e) => set('base', e.target.value)}
                  />
                  <span className="hint">{withCode(t('config.about.git.baseHint'), EXAMPLE_BASE, 'example')}</span>
                </label>
                <label>
                  <span>{t('config.about.git.template')}</span>
                  <input value={draft.template} onChange={(e) => set('template', e.target.value)} />
                  <span className="hint">{withCode(t('config.about.git.templateHint'), example, 'example')}</span>
                </label>
                <label>
                  <span>{t('config.about.git.remote')}</span>
                  <input value={draft.remote} onChange={(e) => set('remote', e.target.value)} />
                </label>
                {protectedField}
              </div>
            </details>
          </div>
        </ModeCard>
      </div>
      <p className="hint git-note">{t('config.about.git.note')}</p>
      <div className="git-actions">
        <button type="button" className="btn-sm primary" disabled={!dirty || problems.length > 0} onClick={() => void save()}>
          {t('config.about.git.save')}
        </button>
        {done && !dirty && <span className="muted">{t('config.about.git.saved')}</span>}
      </div>
      {problems.map((p) => <div key={p.code} className="editor-error">{t(`config.about.git.issue.${p.code}`)}</div>)}
      {error && <div className="editor-error">{error}</div>}
    </>
  )
}

/**
 * Карточка режима: вся шапка — радиокнопка, схема пути работы, настройки режима раскрываются только у выбранного.
 * Настройки не прячутся в скрытый DOM невыбранного режима: так нечего случайно поменять «вслепую».
 */
function ModeCard({ active, title, hint, flow, onSelect, children }: {
  active: boolean
  title: string
  hint: string
  flow: string[]
  onSelect(): void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={`about-box git-mode ${active ? 'active' : ''}`}>
      <button type="button" role="radio" aria-checked={active} className="git-mode-head" onClick={onSelect}>
        <span className="git-mode-dot" aria-hidden="true" />
        <span className="git-mode-text">
          <b>{title}</b>
          <span className="git-flow">
            {flow.map((step, i) => (
              <span key={i}>
                {i > 0 && <span className="git-flow-arrow" aria-hidden="true"> → </span>}
                <code>{step}</code>
              </span>
            ))}
          </span>
          <span className="hint">{hint}</span>
        </span>
      </button>
      {active && <div className="git-mode-body">{children}</div>}
    </div>
  )
}
