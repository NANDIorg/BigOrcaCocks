import type React from 'react'
import { Icon } from '../icons'
import type { Project } from '../../../shared/ipc'
import { CopyButton, SectionHead, plural } from './parts'

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

  return (
    <>
      <SectionHead title="Обзор" hint="Паспорт проекта и то, что нужно для CLI." />
      <div className="about-stats">
        <div className="about-stat">
          <b>{stats.tasks}</b>
          <span>{plural(stats.tasks, 'задача', 'задачи', 'задач')} · {stats.openTasks} {plural(stats.openTasks, 'открытая', 'открытых', 'открытых')}</span>
        </div>
        <div className="about-stat">
          <b>{stats.terminals}</b>
          <span>{plural(stats.terminals, 'терминал открыт', 'терминала открыто', 'терминалов открыто')}</span>
        </div>
        <div className="about-stat">
          <b>{stats.liveRuns}</b>
          <span>{plural(stats.liveRuns, 'прогон идёт', 'прогона идёт', 'прогонов идёт')}</span>
        </div>
        <div className="about-stat">
          <b>{stats.agentsOn}</b>
          <span>{plural(stats.agentsOn, 'агент включён', 'агента включено', 'агентов включено')}</span>
        </div>
      </div>

      <div className="about-box">
        <h3>Пути и идентификаторы</h3>
        <dl className="about-kv">
          <dt>Репозиторий</dt>
          <dd><code title={project.root}>{home(project.root)}</code></dd>
          <dd><CopyButton text={project.root} /></dd>
          <dt>ID для CLI</dt>
          <dd><code>{project.id}</code></dd>
          <dd><CopyButton text={project.id} /></dd>
          <dt>Worktree</dt>
          <dd><code title={worktrees}>{home(worktrees)}</code></dd>
          <dd><CopyButton text={worktrees} /></dd>
          <dt>Сокет CLI</dt>
          <dd><code>{socketPath ? home(socketPath) : '—'}</code></dd>
          <dd><CopyButton text={socketPath} /></dd>
        </dl>
        <p className="hint">В терминалах доступна команда <code>orca-board --help</code>.</p>
      </div>

      <div className="about-box danger-zone">
        <div className="row-act">
          <div className="row-act-text">
            <b>Убрать проект из списка</b>
            <span className="hint">Репозиторий и worktree на диске не удаляются.</span>
          </div>
          <button className="btn-sm danger" onClick={onRemove}><Icon.trash /> Убрать из списка</button>
        </div>
      </div>
    </>
  )
}
