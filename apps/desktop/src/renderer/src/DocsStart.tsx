import type React from 'react'
import type { DocFile, DocGroup } from '../../shared/ipc'
import { formatSize } from './docLinks'
import { dayTime, shortTime, type DocRef, type TaskMark } from './docTree'
import { DocBadge, TaskDot } from './DocsTree'
import { DocIcon } from './docsIcons'
import { t as translateNow, useT } from './i18n'

const dirLabel = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : translateNow('config.docs.rootDir'))
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export interface DocsStartProps {
  /** Ошибка открытия файла — над карточками. */
  notice?: React.ReactNode
  projectName: string
  groups: DocGroup[]
  marks: Map<string, TaskMark>
  now: number
  /** Первые строки файлов задач (`source:path` → текст), подгружаются лениво. */
  excerpts: Map<string, string>
  onOpen(doc: DocRef): void
}

/** Карточки файлов, изменённых задачами в работе, — не больше стольких. */
export const START_TASK_CARDS = 6
const START_RECENT_CARDS = 6

/** Файлы задач для стартового экрана: свежие сверху. */
export function taskCards(groups: DocGroup[]): { group: DocGroup; file: DocFile }[] {
  return groups
    .filter((g) => g.source !== 'project')
    .flatMap((group) => group.files.map((file) => ({ group, file })))
    .sort((a, b) => b.file.mtime - a.file.mtime)
    .slice(0, START_TASK_CARDS)
}

/** Стартовый экран без выбранного файла: сводка, «Изменены задачами в работе», «Недавние в проекте». */
export function DocsStart(p: DocsStartProps): React.JSX.Element {
  const project = p.groups.find((g) => g.source === 'project')
  const byTasks = taskCards(p.groups)
  const taskTotal = p.groups.filter((g) => g.source !== 'project').reduce((n, g) => n + g.files.length, 0)
  const recent = [...(project?.files ?? [])].sort((a, b) => b.mtime - a.mtime).slice(0, START_RECENT_CARDS)
  const projectCount = project?.files.length ?? 0
  const t = useT()

  return (
    <section className="docs-start">
      {p.notice}
      <h2>{t('config.docs.start.title', { project: p.projectName })}</h2>
      <p className="sub">
        {t('config.docs.start.files', { count: projectCount })}
        {taskTotal > 0 && t('config.docs.start.byTasksCount', { count: taskTotal })}{t('config.docs.start.pick')} <kbd>⌘P</kbd>.
      </p>
      {byTasks.length > 0 && (
        <>
          <h5>{t('config.docs.start.byTasks')}</h5>
          <div className="docs-cards">
            {byTasks.map(({ group, file }) => (
              <button key={`${group.source}:${file.path}`} className="docs-card" onClick={() => p.onOpen({ source: group.source, path: file.path })} title={file.path}>
                <span className="t"><DocIcon.file /><span className="docs-ellipsis">{nameOf(file.path)}</span><DocBadge file={file} now={p.now} /></span>
                <span className="p">{dirLabel(file.path)}</span>
                {p.excerpts.get(`${group.source}:${file.path}`) && <span className="x">{p.excerpts.get(`${group.source}:${file.path}`)}</span>}
                <span className="f"><TaskDot mark={p.marks.get(group.source)} /><span className="docs-ellipsis">{group.title}</span> · {shortTime(file.mtime, p.now)}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {recent.length > 0 && (
        <>
          <h5>{t('config.docs.start.recent')}</h5>
          <div className="docs-cards">
            {recent.map((file) => (
              <button key={file.path} className="docs-card" onClick={() => p.onOpen({ source: 'project', path: file.path })} title={file.path}>
                <span className="t"><DocIcon.file /><span className="docs-ellipsis">{nameOf(file.path)}</span><DocBadge file={file} now={p.now} /></span>
                <span className="p">{dirLabel(file.path)}</span>
                <span className="f"><DocIcon.clock />{dayTime(file.mtime, p.now)} · {formatSize(file.size)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

/** В проекте и задачах нет ни одного .md. */
export function DocsBlank({ onRefresh }: { onRefresh(): void }): React.JSX.Element {
  const t = useT()
  return (
    <section className="docs-blank">
      <div className="box">
        <div className="ill"><DocIcon.doc /></div>
        <h2>{t('config.docs.blank.title')}</h2>
        <p>
          {t('config.docs.blank.before')} <code>.md</code> {t('config.docs.blank.after')}
        </p>
        <div className="acts">
          <button className="btn-sm" onClick={onRefresh}><DocIcon.refresh />{t('config.docs.refresh')}</button>
        </div>
      </div>
    </section>
  )
}
