import type React from 'react'
import type { DocFile } from '../../shared/ipc'
import { formatSize } from './docLinks'
import { longTime, readingMinutes } from './docTree'
import { DocIcon } from './docsIcons'

export interface TocItem {
  id: string
  text: string
  level: 2 | 3
}

export interface DocsTocProps {
  items: TocItem[]
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
  return (
    <aside className="docs-toc" aria-label="На странице">
      <h4>На странице</h4>
      {p.items.length === 0 && <div className="muted docs-toc-empty">Нет разделов</div>}
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
      <div className="docs-prog" title={`Прочитано ${Math.round(p.progress * 100)}%`}>
        <i style={{ width: `${Math.round(p.progress * 100)}%` }} />
      </div>
      <div className="docs-toc-meta">
        {p.file && <div><DocIcon.clock />изменён {longTime(p.file.mtime, p.now)}</div>}
        <div><DocIcon.file />{p.file ? `${formatSize(p.file.size)} · ` : ''}≈ {readingMinutes(p.content)} мин</div>
        {p.alsoTasks.map((t) => (
          <div key={t} title={t}><DocIcon.branch /><span className="docs-ellipsis">также правит задача «{t}»</span></div>
        ))}
      </div>
    </aside>
  )
}
