import type React from 'react'
import { useMemo, useRef, useState } from 'react'
import type { Project, ProjectGroup } from '../../shared/ipc'
import { ConfirmModal, GroupNameModal } from './GroupDialogs'
import { useT } from './i18n'
import { ipcErrorMessage } from './ipcError'
import { Icon } from './icons'
import { POPUP_MENU_WIDTH, PopupMenu, type PopupItem } from './PopupMenu'
import { buildSidebar, groupsApi, groupTargets, isStaleGroupsError, staleGroupsMessage, type SidebarGroup } from './projectGroups'

interface Props {
  projects: Project[]
  groups: ProjectGroup[]
  inProgress: Record<string, number>
  activeId: string | undefined
  onSwitch(p: Project): void
  /** «Добавить репозиторий» — кнопка в шапке рядом с «Новая группа». */
  onAdd(): void
  /** Перечитать проекты и группы из main после изменения. */
  onReload(): Promise<void>
  /** Оптимистичное обновление групп (сворачивание не ждёт main). */
  onGroupsChange(groups: ProjectGroup[]): void
}

type MenuTarget = { kind: 'project'; project: Project } | { kind: 'group'; group: ProjectGroup }

/** `opener` — элемент, которому вернуть фокус после Esc. */
interface MenuState {
  target: MenuTarget
  x: number
  y: number
  opener: HTMLElement
}

type DialogState =
  | { kind: 'create'; forProject?: Project }
  | { kind: 'rename'; group: ProjectGroup }
  | { kind: 'remove'; group: ProjectGroup }

/** Ошибка действия с группами: «старый main» — понятным текстом, остальное — сообщение main без обёртки IPC. */
function friendlyError(e: unknown): Error {
  const message = ipcErrorMessage(e)
  return new Error(isStaleGroupsError(message) ? staleGroupsMessage() : message)
}

/**
 * Шапка и список проектов в левом меню: сворачиваемые группы и проекты без группы. Без групп выглядит как прежний
 * плоский список. Действия с группами идут через `groupsApi`: со старым main/preload они показывают
 * «перезапустите приложение», а меню продолжает работать.
 */
export function ProjectList({ projects, groups, inProgress, activeId, onSwitch, onAdd, onReload, onGroupsChange }: Props): React.JSX.Element {
  const t = useT()
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const model = useMemo(() => buildSidebar(projects, groups, inProgress, activeId), [projects, groups, inProgress, activeId])
  const groupsRef = useRef(groups)
  groupsRef.current = groups

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await action()
      await onReload()
    } catch (e) {
      setError(friendlyError(e).message)
      // Оптимистичное состояние могло разойтись с main — сверяемся с ним.
      void onReload().catch(() => {})
    }
  }

  const toggle = (g: SidebarGroup): void => {
    const collapsed = !g.collapsed
    setError(null)
    onGroupsChange(groupsRef.current.map((x) => (x.id === g.group.id ? { ...x, collapsed } : x)))
    void run(() => groupsApi(window.orca).setGroupCollapsed(g.group.id, collapsed))
  }

  /** Меню по правой кнопке (или клавише меню) на элементе; `preventDefault` гасит системное меню. */
  const onContext = (e: React.MouseEvent<HTMLElement>, target: MenuTarget): void => {
    e.preventDefault()
    setMenu({ target, x: e.clientX, y: e.clientY, opener: e.currentTarget })
  }

  /** Меню по кнопке «…»: под кнопкой, выровнено по её правому краю. */
  const onMore = (e: React.MouseEvent<HTMLElement>, target: MenuTarget): void => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    setMenu({ target, x: r.right - POPUP_MENU_WIDTH, y: r.bottom + 4, opener: e.currentTarget })
  }

  const closeMenu = (restoreFocus: boolean): void => {
    if (restoreFocus) menu?.opener.focus()
    setMenu(null)
  }

  const projectItems = (project: Project): PopupItem[] => {
    const items: PopupItem[] = []
    let first = true
    for (const target of groupTargets(project, groups)) {
      const label = target.groupId === null ? t('shell.projects.menu.ungroup') : t('shell.projects.menu.moveTo', { name: target.name })
      items.push({
        id: target.groupId === null ? 'ungroup' : `group:${target.groupId}`,
        label,
        hint: target.current ? t('shell.projects.menu.here') : undefined,
        disabled: target.current,
        heading: first ? t('shell.projects.menu.group') : undefined
      })
      first = false
    }
    items.push({ id: 'new', label: t('shell.projects.menu.newGroup'), heading: first ? t('shell.projects.menu.group') : undefined, separatorBefore: !first })
    return items
  }

  const groupItems = (): PopupItem[] => [
    { id: 'rename', label: t('shell.projects.menu.rename') },
    { id: 'remove', label: t('shell.projects.menu.removeGroup'), danger: true, separatorBefore: true }
  ]

  const pickMenu = (id: string): void => {
    const current = menu
    setMenu(null)
    if (!current) return
    const target = current.target
    if (target.kind === 'project') {
      const p = target.project
      if (id === 'new') return setDialog({ kind: 'create', forProject: p })
      const groupId = id === 'ungroup' ? null : id.replace(/^group:/, '')
      void run(() => groupsApi(window.orca).setProjectGroup(p.id, groupId))
    } else {
      setDialog({ kind: id === 'rename' ? 'rename' : 'remove', group: target.group })
    }
  }

  const renderProject = (p: Project, grouped: boolean): React.JSX.Element => (
    <div key={p.id} className={`item${grouped ? ' grouped' : ''}${p.id === activeId ? ' active' : ''}`}>
      <button
        type="button"
        className="item-main"
        aria-current={p.id === activeId ? 'true' : undefined}
        onClick={() => onSwitch(p)}
        onContextMenu={(e) => onContext(e, { kind: 'project', project: p })}
      >
        <span className="name-row">
          <span className="name" title={p.name}>{p.name}</span>
          {(inProgress[p.id] ?? 0) > 0 && (
            <span className="tab-badge" title={t('shell.projects.inProgress', { count: inProgress[p.id] })}>{inProgress[p.id]}</span>
          )}
        </span>
        <span className="sub" title={p.root}>{p.root.replace(/^\/Users\/[^/]+/, '~')}</span>
      </button>
      <button
        type="button"
        className="item-more"
        aria-haspopup="menu"
        aria-expanded={menu?.target.kind === 'project' && menu.target.project.id === p.id}
        aria-label={t('shell.projects.projectMenu', { name: p.name })}
        title={t('shell.projects.projectMenu', { name: p.name })}
        onClick={(e) => onMore(e, { kind: 'project', project: p })}
      >
        <Icon.more />
      </button>
    </div>
  )

  const renderGroup = (g: SidebarGroup): React.JSX.Element => {
    const bodyId = `project-group-${g.group.id}`
    const countText = t('shell.projects.groupCount', { count: g.projects.length })
    const marked = g.collapsed && g.hasActive
    return (
      <div key={g.group.id} className="project-group">
        <div className={`group-head${marked ? ' has-active' : ''}${g.collapsed ? ' collapsed' : ''}`} onContextMenu={(e) => onContext(e, { kind: 'group', group: g.group })}>
          <button
            type="button"
            className="group-toggle"
            aria-expanded={!g.collapsed}
            aria-controls={bodyId}
            title={marked ? t('shell.projects.groupHasActive') : t('shell.projects.groupToggle')}
            onClick={() => toggle(g)}
          >
            <span className="group-chevron" aria-hidden><Icon.chevron /></span>
            <span className="group-name">{g.group.name}</span>
            <span className="group-count" title={countText}>
              <span aria-hidden>{g.projects.length}</span>
              <span className="sr-only">{countText}</span>
            </span>
            {g.collapsed && g.inProgress > 0 && (
              <span className="tab-badge" title={t('shell.projects.inProgress', { count: g.inProgress })}>{g.inProgress}</span>
            )}
            {marked && <span className="sr-only">{t('shell.projects.groupHasActive')}</span>}
          </button>
          <button
            type="button"
            className="item-more"
            aria-haspopup="menu"
            aria-expanded={menu?.target.kind === 'group' && menu.target.group.id === g.group.id}
            aria-label={t('shell.projects.groupMenu', { name: g.group.name })}
            title={t('shell.projects.groupMenu', { name: g.group.name })}
            onClick={(e) => onMore(e, { kind: 'group', group: g.group })}
          >
            <Icon.more />
          </button>
        </div>
        <div id={bodyId} role="group" aria-label={g.group.name} hidden={g.collapsed}>
          {g.projects.length === 0 ? <div className="group-empty">{t('shell.projects.groupEmpty')}</div> : g.projects.map((p) => renderProject(p, true))}
        </div>
      </div>
    )
  }

  const menuItems = menu?.target.kind === 'project' ? projectItems(menu.target.project) : menu ? groupItems() : []

  return (
    <>
      <div className="head">
        <h2>{t('shell.projects.title')}</h2>
        <button type="button" className="icon-btn" title={t('shell.projects.newGroup')} aria-label={t('shell.projects.newGroup')} onClick={() => setDialog({ kind: 'create' })}><Icon.folderPlus /></button>
        <button type="button" className="icon-btn fill" title={t('shell.projects.add')} aria-label={t('shell.projects.add')} onClick={onAdd}><Icon.plus /></button>
      </div>
      {error && (
        <div className="sidebar-error" role="alert">
          <span>{error}</span>
          <button type="button" aria-label={t('shell.projects.errorClose')} title={t('shell.projects.errorClose')} onClick={() => setError(null)}><Icon.close /></button>
        </div>
      )}
      <div className="list">
        {projects.length === 0 && <div className="empty">{t('shell.projects.empty')}</div>}
        {model.groups.map(renderGroup)}
        {model.ungrouped.map((p) => renderProject(p, false))}
      </div>
      {menu && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          ariaLabel={menu.target.kind === 'project' ? t('shell.projects.projectMenu', { name: menu.target.project.name }) : t('shell.projects.groupMenu', { name: menu.target.group.name })}
          items={menuItems}
          onPick={pickMenu}
          onClose={closeMenu}
        />
      )}
      {dialog?.kind === 'create' && (
        <GroupNameModal
          forProject={dialog.forProject?.name}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const api = groupsApi(window.orca)
            try {
              const created = await api.createGroup(name)
              if (dialog.forProject) await api.setProjectGroup(dialog.forProject.id, created.id)
            } catch (e) {
              throw friendlyError(e)
            }
            setDialog(null)
            await onReload()
          }}
        />
      )}
      {dialog?.kind === 'rename' && (
        <GroupNameModal
          initialName={dialog.group.name}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            try {
              await groupsApi(window.orca).renameGroup(dialog.group.id, name)
            } catch (e) {
              throw friendlyError(e)
            }
            setDialog(null)
            await onReload()
          }}
        />
      )}
      {dialog?.kind === 'remove' && (
        <ConfirmModal
          title={t('shell.projects.removeGroup.title', { name: dialog.group.name })}
          text={t('shell.projects.removeGroup.text')}
          confirmLabel={t('shell.projects.removeGroup.confirm')}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            try {
              await groupsApi(window.orca).removeGroup(dialog.group.id)
            } catch (e) {
              throw friendlyError(e)
            }
            setDialog(null)
            await onReload()
          }}
        />
      )}
    </>
  )
}
