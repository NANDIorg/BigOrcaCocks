import type React from 'react'
import { Icon } from '../icons'
import type { Project } from '../../../shared/ipc'
import { useT } from '../i18n'
import { CopyButton, SectionHead, withCode } from './parts'

interface Props {
  project: Project
  socketPath: string
  stats: { tasks: number; openTasks: number; terminals: number; liveRuns: number; agentsOn: number }
  onRemove(): void
}

/** Папка worktree задач: <repo>/../.orca-worktrees (как в main/worker.ts). */
function worktreeDir(root: string): string {
  return `${root.replace(/\/+$/, '').replace(/\/[^/]*$/, '')}/.orca-worktrees/`
}

const home = (path: string): string => path.replace(/^\/Users\/[^/]+/, '~')

/** Раздел «Обзор»: статистика, паспорт проекта для CLI и удаление из списка. */
export function OverviewSection(props: Props): React.JSX.Element {
  const { project, socketPath, stats, onRemove } = props
  const worktrees = worktreeDir(project.root)
  const t = useT()

  return (
    <>
      <SectionHead title={t('config.about.nav.overview')} hint={t('config.about.overview.hint')} />
      <div className="about-stats">
        <div className="about-stat">
          <b>{stats.tasks}</b>
          <span>{t('config.about.overview.tasks', { count: stats.tasks })} · {t('config.about.overview.open', { count: stats.openTasks })}</span>
        </div>
        <div className="about-stat">
          <b>{stats.terminals}</b>
          <span>{t('config.about.overview.terminals', { count: stats.terminals })}</span>
        </div>
        <div className="about-stat">
          <b>{stats.liveRuns}</b>
          <span>{t('config.about.overview.runs', { count: stats.liveRuns })}</span>
        </div>
        <div className="about-stat">
          <b>{stats.agentsOn}</b>
          <span>{t('config.about.overview.agents', { count: stats.agentsOn })}</span>
        </div>
      </div>

      <div className="about-box">
        <h3>{t('config.about.overview.paths')}</h3>
        <dl className="about-kv">
          <dt>{t('config.about.overview.repo')}</dt>
          <dd><code title={project.root}>{home(project.root)}</code></dd>
          <dd><CopyButton text={project.root} /></dd>
          <dt>{t('config.about.overview.cliId')}</dt>
          <dd><code>{project.id}</code></dd>
          <dd><CopyButton text={project.id} /></dd>
          <dt>{t('config.about.overview.worktree')}</dt>
          <dd><code title={worktrees}>{home(worktrees)}</code></dd>
          <dd><CopyButton text={worktrees} /></dd>
          <dt>{t('config.about.overview.socket')}</dt>
          <dd><code>{socketPath ? home(socketPath) : '—'}</code></dd>
          <dd><CopyButton text={socketPath} /></dd>
        </dl>
        <p className="hint">{withCode(t('config.about.overview.cliHelp'), 'orca-board --help')}</p>
      </div>

      <div className="about-box danger-zone">
        <div className="row-act">
          <div className="row-act-text">
            <b>{t('config.about.overview.remove')}</b>
            <span className="hint">{t('config.about.overview.removeHint')}</span>
          </div>
          <button className="btn-sm danger" onClick={onRemove}><Icon.trash /> {t('config.about.overview.removeBtn')}</button>
        </div>
      </div>
    </>
  )
}
