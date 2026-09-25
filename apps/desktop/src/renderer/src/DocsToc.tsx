import type React from 'react'
import type { DocFile } from '../../shared/ipc'
import { formatSize } from './docLinks'
import { longTime, readingMinutes } from './docTree'
import type { DocTocItem } from './docToc'
import { DocIcon } from './docsIcons'
import { useT } from './i18n'

export interface DocsTocProps {
  items: DocTocItem[]
  active: string | null
  /** Доля прочитанного, 0…1. */
  progress: number
  file?: DocFile
  content: string
  now: number
  /** Названия задач, где этот же файл тоже изменён. */
  alsoTasks: string[]
  onJump(id: string): void
}

/** Правая колонка «На странице»: оглавление h2/h3 с текущим разделом, прогресс чтения, метаданные. */
export function DocsToc(p: DocsTocProps): React.JSX.Element {
  const t = useT()
  return (
    <aside className="docs-toc" aria-label={t('config.docs.toc.title')}>
      <h4>{t('config.docs.toc.title')}</h4>
      {p.items.length === 0 && <div className="muted docs-toc-empty">{t('config.docs.toc.empty')}</div>}
      {p.items.map((h) => (
        <a
          key={h.id}
          href={`#${h.id}`}
          className={`${h.level === 3 ? 'l3' : ''} ${p.active === h.id ? 'on' : ''}`}
          onClick={(e) => {
            e.preventDefault()
            p.onJump(h.id)
          }}
        >
          {h.text}
        </a>
      ))}
      <div className="docs-prog" title={t('config.docs.toc.progress', { percent: Math.round(p.progress * 100) })}>
        <i style={{ width: `${Math.round(p.progress * 100)}%` }} />
      </div>
      <div className="docs-toc-meta">
        {p.file && <div><DocIcon.clock />{t('config.docs.toc.modified', { when: longTime(p.file.mtime, p.now) })}</div>}
        <div><DocIcon.file />{p.file ? `${formatSize(p.file.size)} · ` : ''}{t('config.docs.toc.reading', { n: readingMinutes(p.content) })}</div>
        {p.alsoTasks.map((task) => (
          <div key={task} title={task}><DocIcon.branch /><span className="docs-ellipsis">{t('config.docs.toc.alsoTask', { task })}</span></div>
        ))}
      </div>
    </aside>
  )
}
