import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DocFile, DocGroup } from '../../shared/ipc'
import { isRecent } from './docLinks'
import { buildTree, chainLabel, highlight, matchPath, sameDoc, shortTime, type DocRef, type PathMatch, type TaskMark, type TreeNode } from './docTree'
import type { TextMatch } from './docFind'
import { DocIcon } from './docsIcons'
import { useT } from './i18n'

export type TreeMode = 'tree' | 'recent'

/** «новый» (не в git) — бирюзовый, «изменён» (за сутки) — жёлтый. */
export function DocBadge({ file, now }: { file: DocFile; now: number }): React.JSX.Element | null {
  const t = useT()
  if (file.untracked) return <span className="chip docs-chip new">{t('config.docs.badge.new')}</span>
  if (isRecent(file, now)) return <span className="chip docs-chip mod">{t('config.docs.badge.modified')}</span>
  return null
}

export function TaskDot({ mark }: { mark?: TaskMark }): React.JSX.Element {
  return <span className="docs-dot" style={{ background: mark?.color ?? 'var(--col-progress)' }} />
}

const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/') + 1)
export const dirKey = (source: string, path: string): string => `${source}:${path}`

interface FileHit {
  source: string
  file: DocFile
  match: PathMatch
}

function searchGroup(g: DocGroup | undefined, query: string): FileHit[] {
  if (!g) return []
  return g.files
    .flatMap((file) => {
      const match = matchPath(file.path, query)
      return match ? [{ source: g.source, file, match }] : []
    })
    .sort((a, b) => b.match.score - a.match.score || b.file.mtime - a.file.mtime)
}

function Marked({ text, hit, offset = 0 }: { text: string; hit: PathMatch; offset?: number }): React.JSX.Element {
  return <>{highlight(text, hit.ranges, offset).map((s, i) => (s.hit ? <b key={i}>{s.text}</b> : <span key={i}>{s.text}</span>))}</>
}

export interface DocsTreeProps {
  groups: DocGroup[] | null
  listError: string | null
  now: number
  current: DocRef | null
  marks: Map<string, TaskMark>
  mode: TreeMode
  onMode(mode: TreeMode): void
  openDirs: Set<string>
  onToggleDir(key: string): void
  onCollapseAll(): void
  query: string
  onQuery(q: string): void
  searchRef: React.RefObject<HTMLInputElement | null>
  /** Совпадения в тексте открытого документа (группа «В тексте открытого документа»). */
  textHits: TextMatch[]
  onTextHit(index: number): void
  onOpen(doc: DocRef): void
}

/** Левая колонка «Документов»: поиск, «Папки / Недавние», дерево проекта и файлы задач в работе. */
export function DocsTree(p: DocsTreeProps): React.JSX.Element {
  const t = useT()
  const { groups, now, current, marks, query } = p
  const [focus, setFocus] = useState(false)
  const [kb, setKb] = useState(0)
  const kbRef = useRef<HTMLButtonElement>(null)

  const project = groups?.find((g) => g.source === 'project')
  const tasks = useMemo(() => (groups ?? []).filter((g) => g.source !== 'project'), [groups])
  const taskFiles = tasks.reduce((n, g) => n + g.files.length, 0)
  const total = (project?.files.length ?? 0) + taskFiles
  const searching = query.trim() !== ''

  const tree = useMemo(() => buildTree(project?.files ?? []), [project])
  const recent = useMemo(() => [...(project?.files ?? [])].sort((a, b) => b.mtime - a.mtime), [project])

  const projectHits = useMemo(() => (searching ? searchGroup(project, query) : []), [searching, project, query])
  const taskHits = useMemo(() => (searching ? tasks.flatMap((g) => searchGroup(g, query)) : []), [searching, tasks, query])
  const textHits = searching ? p.textHits.slice(0, 8) : []
  const hitCount = projectHits.length + taskHits.length + textHits.length

  useEffect(() => {
    setKb(0)
  }, [query])
  useEffect(() => {
    kbRef.current?.scrollIntoView({ block: 'nearest' })
  }, [kb])

  function activate(i: number): void {
    const file = [...projectHits, ...taskHits][i]
    if (file) p.onOpen({ source: file.source, path: file.file.path })
    else if (textHits[i - projectHits.length - taskHits.length]) p.onTextHit(i - projectHits.length - taskHits.length)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!searching || hitCount === 0) return
      e.preventDefault()
      setKb((i) => (i + (e.key === 'ArrowDown' ? 1 : hitCount - 1)) % hitCount)
    } else if (e.key === 'Enter') {
      if (searching && hitCount > 0) {
        e.preventDefault()
        activate(kb)
      }
    } else if (e.key === 'Escape' && query) {
      e.preventDefault()
      p.onQuery('')
    }
  }

  const fileRow = (source: string, f: DocFile, depth: number, label?: React.ReactNode, spacer = true): React.JSX.Element => {
    const doc = { source, path: f.path }
    const active = sameDoc(current, doc)
    return (
      <button key={`${source}:${f.path}`} className={`docs-row file ${active ? 'active' : ''}`} style={{ paddingLeft: 8 + depth * 16 }} title={f.path} onClick={() => p.onOpen(doc)}>
        {spacer && <span className="docs-spacer" />}
        <DocIcon.file />
        <span className="docs-nm">{label ?? f.path.slice(f.path.lastIndexOf('/') + 1)}</span>
        <DocBadge file={f} now={now} />
        <span className="docs-tm">{shortTime(f.mtime, now)}</span>
      </button>
    )
  }

  const nodes = (list: TreeNode[], depth: number): React.JSX.Element[] =>
    list.flatMap((n) => {
      if (n.kind === 'file') return [fileRow('project', n.file, depth)]
      const key = dirKey('project', n.path)
      const open = p.openDirs.has(key)
      return [
        <button key={key} data-dir-key={key} className={`docs-row dir ${open ? 'open' : ''}`} style={{ paddingLeft: 8 + depth * 16 }} title={n.path} onClick={() => p.onToggleDir(key)}>
          <DocIcon.chev />
          <DocIcon.folder />
          <span className="docs-nm">{chainLabel(n.name)}</span>
          <span className="docs-cnt">{n.count}</span>
        </button>,
        ...(open ? nodes(n.children, depth + 1) : [])
      ]
    })

  let hitIndex = 0
  const hitRow = (h: FileHit, sub?: React.ReactNode): React.JSX.Element => {
    const i = hitIndex++
    const nameStart = h.file.path.lastIndexOf('/') + 1
    const dir = dirOf(h.file.path)
    return (
      <button
        key={`${h.source}:${h.file.path}`}
        ref={i === kb ? kbRef : undefined}
        className={`docs-hit ${i === kb ? 'kb' : ''}`}
        onMouseEnter={() => setKb(i)}
        onClick={() => activate(i)}
        title={h.file.path}
      >
        <span className="docs-hit-l1">
          <DocIcon.file />
          <span className="docs-nm"><Marked text={h.file.path.slice(nameStart)} hit={h.match} offset={nameStart} /></span>
          <DocBadge file={h.file} now={now} />
          <span className="docs-tm">{shortTime(h.file.mtime, now)}</span>
        </span>
        <span className="docs-hit-l2">
          {sub}
          {dir ? <Marked text={dir} hit={h.match} /> : t('config.docs.rootDir')}
        </span>
      </button>
    )
  }

  const empty = groups !== null && total === 0

  return (
    <nav className="docs-tree" aria-label={t('config.docs.tree.aria')}>
      <div className={`docs-tree-search ${focus ? 'focus' : ''} ${empty ? 'off' : ''}`}>
        <DocIcon.search />
        <input
          ref={p.searchRef}
          value={query}
          disabled={empty}
          onChange={(e) => p.onQuery(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          placeholder={t('config.docs.tree.search')}
          aria-label={t('config.docs.tree.searchAria')}
        />
        {query && (
          <button className="icon-btn docs-clear" title={t('config.docs.tree.clear')} aria-label={t('config.docs.tree.clearAria')} onClick={() => p.onQuery('')}>
            <DocIcon.close />
          </button>
        )}
      </div>
      {!searching && !empty && (
        <div className="docs-tree-tools">
          <span className="docs-seg" role="tablist">
            <button className={p.mode === 'tree' ? 'on' : ''} onClick={() => p.onMode('tree')}>{t('config.docs.tree.folders')}</button>
            <button className={p.mode === 'recent' ? 'on' : ''} onClick={() => p.onMode('recent')}>{t('config.docs.tree.recent')}</button>
          </span>
          <span className="docs-grow" />
          {p.mode === 'tree' && (
            <button className="icon-btn docs-tool" title={t('config.docs.tree.collapseAll')} aria-label={t('config.docs.tree.collapseAll')} onClick={p.onCollapseAll}>
              <DocIcon.toc />
            </button>
          )}
        </div>
      )}
      <div className="docs-tree-body">
        {p.listError && <div className="editor-error docs-hint">{p.listError}</div>}
        {groups === null && !p.listError && <div className="muted docs-hint">{t('common.loading')}</div>}
        {groups !== null && searching && (
          <>
            <div className="docs-grp">{t('config.docs.tree.project')}<span className="n">{t('config.docs.tree.ofTotal', { n: projectHits.length, total: project?.files.length ?? 0 })}</span></div>
            {projectHits.length ? projectHits.map((h) => hitRow(h)) : <div className="muted docs-hint">{t('config.docs.tree.noMatches')}</div>}
            <div className="docs-grp">{t('config.docs.tree.tasks')}<span className="n">{taskHits.length}</span></div>
            {taskHits.length ? (
              taskHits.map((h) => hitRow(h, <><TaskDot mark={marks.get(h.source)} />{tasks.find((g) => g.source === h.source)?.title} · </>))
            ) : (
              <div className="muted docs-hint">{t('config.docs.tree.noMatches')}</div>
            )}
            {current && (
              <>
                <div className="docs-grp">{t('config.docs.tree.inText')}{p.textHits.length > 0 && <span className="n">{p.textHits.length}</span>}</div>
                {textHits.length === 0 && <div className="muted docs-hint">{t('config.docs.tree.noMatches')}</div>}
                {textHits.map((hit, j) => {
                  const i = hitIndex++
                  return (
                    <button key={`text:${j}`} ref={i === kb ? kbRef : undefined} className={`docs-hit ${i === kb ? 'kb' : ''}`} onMouseEnter={() => setKb(i)} onClick={() => activate(i)}>
                      <span className="docs-hit-l1 text">{hit.before}<b>{hit.match}</b>{hit.after}</span>
                      <span className="docs-hit-l2">{current.path.slice(current.path.lastIndexOf('/') + 1)}{hit.section && ` · «${hit.section}»`}</span>
                    </button>
                  )
                })}
              </>
            )}
          </>
        )}
        {groups !== null && !searching && (
          <>
            <div className="docs-grp">{t('config.docs.tree.project')}<span className="n">{project?.files.length ?? 0}</span></div>
            {p.mode === 'tree' ? nodes(tree, 0) : recent.map((f) => fileRow('project', f, 0, <>{f.path.slice(f.path.lastIndexOf('/') + 1)}{f.path.includes('/') && <span className="docs-row-dir">{dirOf(f.path)}</span>}</>))}
            <div className="docs-grp">{t('config.docs.tree.tasks')}<span className="n">{taskFiles}</span></div>
            {!empty && taskFiles === 0 && <div className="muted docs-hint">{t('config.docs.tree.noTaskFiles')}</div>}
            {tasks
              .filter((g) => g.files.length > 0)
              .map((g) => (
                <div key={g.source} className="docs-task">
                  <div className="docs-task-row" title={g.branch}>
                    <TaskDot mark={marks.get(g.source)} />
                    <span className="t">{g.title}</span>
                    {marks.get(g.source) && <span className="st">{marks.get(g.source)?.status}</span>}
                  </div>
                  {g.files.map((f) => fileRow(g.source, f, 1, f.path, false))}
                </div>
              ))}
          </>
        )}
      </div>
      {searching && (
        <div className="docs-tree-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> {t('config.docs.tree.keySelect')}</span>
          <span><kbd>↵</kbd> {t('config.docs.tree.keyOpen')}</span>
          <span><kbd>Esc</kbd> {t('config.docs.tree.keyReset')}</span>
        </div>
      )}
    </nav>
  )
}
