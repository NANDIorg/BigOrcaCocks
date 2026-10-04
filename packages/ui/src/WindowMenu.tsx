import { getUiApi } from './host'
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { AppMenuItem } from '../shared/ipc'
import appLogo from '../assets/icon.svg'
import { PopupMenu, type PopupItem } from './PopupMenu'
import { Icon } from './icons'
import { useT } from './i18n'
import { ipcErrorMessage } from './ipcError'
import { popupMenuShortcut } from './popupMenuNavigation'

const EMPTY_ITEMS: PopupItem[] = []
const GROUP_ICONS = [Icon.folder, Icon.edit, Icon.palette, Icon.desktop, Icon.info]

function menuItems(items: AppMenuItem[], root = true): PopupItem[] {
  return items.map((item, index) => {
    const GroupIcon = root ? GROUP_ICONS[index] : undefined
    return { ...item, children: item.children ? menuItems(item.children, false) : undefined,
      icon: GroupIcon ? <GroupIcon /> : undefined }
  })
}

/** Темы и popup принадлежат renderer; команды и сочетания — каноническому меню main. */
export function WindowMenu(): React.JSX.Element | null {
  const t = useT()
  const trigger = useRef<HTMLButtonElement>(null)
  const origin = useRef<HTMLElement | null>(null)
  const selection = useRef<Range | null>(null)
  const caret = useRef<{ start: number; end: number; direction: 'forward' | 'backward' | 'none' } | null>(null)
  const request = useRef(0)
  const [menu, setMenu] = useState<{ x: number; y: number; items: PopupItem[] | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => () => {
    request.current++
    if (getUiApi()?.app?.windowChrome === 'windows') void getUiApi().app.dismissMenu?.().catch(() => {})
  }, [])
  if (getUiApi()?.app?.windowChrome !== 'windows') return null

  const rememberFocus = (focused: EventTarget | null = document.activeElement): void => {
    origin.current = focused instanceof HTMLElement ? focused : null
    const selected = window.getSelection()
    selection.current = selected?.rangeCount ? selected.getRangeAt(0).cloneRange() : null
    const el = origin.current
    caret.current = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.selectionStart !== null && el.selectionEnd !== null
      ? { start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection ?? 'none' } : null
  }

  const restoreFocus = (): void => {
    const el = origin.current?.isConnected ? origin.current : trigger.current
    el?.focus({ preventScroll: true })
    if (caret.current && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      el.setSelectionRange(caret.current.start, caret.current.end, caret.current.direction)
    } else if (selection.current?.startContainer.isConnected && selection.current.endContainer.isConnected) {
      const selected = window.getSelection()
      selected?.removeAllRanges()
      selected?.addRange(selection.current)
    }
  }

  const close = (restore: boolean): void => {
    request.current++
    setMenu(null)
    void getUiApi()?.app?.dismissMenu?.().catch((e) => setError(ipcErrorMessage(e)))
    if (restore) restoreFocus()
  }

  const openMenu = async (): Promise<void> => {
    if (menu) { close(true); return }
    setError(null)
    const { getMenu, invokeMenu, dismissMenu } = getUiApi().app
    if (!getMenu || !invokeMenu || !dismissMenu) { setError(t('common.staleApp')); return }
    if (!origin.current?.isConnected) rememberFocus()
    const rect = trigger.current?.getBoundingClientRect()
    if (!rect) return
    const version = ++request.current
    setMenu({ x: rect.right + 8, y: rect.top, items: null })
    try {
      const items = menuItems(await getMenu())
      if (request.current === version) setMenu({ x: rect.right + 8, y: rect.top, items })
    } catch (e) {
      if (request.current !== version) return
      close(true)
      setError(ipcErrorMessage(e))
    }
  }

  const pick = async (id: string): Promise<void> => {
    // Electron редактирует сфокусированный input: сначала возвращаем выделение, затем вызываем команду.
    close(true)
    const invoke = getUiApi()?.app?.invokeMenu
    if (!invoke) { setError(t('common.staleApp')); return }
    try { await invoke(id) } catch (e) { setError(ipcErrorMessage(e)) }
  }

  return <>
    <button
      ref={trigger}
      className={`icon${menu ? ' active' : ''}`}
      type="button"
      title={t('shell.rail.menu')}
      aria-label={t('shell.rail.menu')}
      aria-haspopup="menu"
      aria-expanded={!!menu}
      aria-busy={menu?.items === null || undefined}
      onFocus={(e) => {
        if (!menu && e.relatedTarget instanceof HTMLElement && !e.relatedTarget.closest('.popup-menu')) rememberFocus(e.relatedTarget)
      }}
      onPointerDown={(e) => { if (!menu) rememberFocus(); e.preventDefault() }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => { void openMenu() }}
    ><Icon.menu /></button>
    {menu && <PopupMenu
      x={menu.x} y={menu.y} ariaLabel={t('shell.rail.menu')}
      variant="application" items={menu.items ?? EMPTY_ITEMS} loading={menu.items === null}
      header={<><img src={appLogo} width={28} height={28} alt="" /><span>orca-board</span></>}
      onShortcut={(event) => {
        const id = popupMenuShortcut(menu.items ?? EMPTY_ITEMS, event)
        if (!id) return false
        void pick(id)
        return true
      }}
      onPick={(id) => { void pick(id) }} onClose={close}
    />}
    {error && <div className="window-menu-error" role="alert">
      <span>{error}</span>
      <button type="button" aria-label={t('common.close')} onClick={() => setError(null)}><Icon.close /></button>
    </div>}
  </>
}
