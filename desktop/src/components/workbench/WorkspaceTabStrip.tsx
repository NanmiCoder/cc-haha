import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FolderClosed, Globe, MoreHorizontal, Plus, SquareTerminal, SquareSplitVertical } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { useDismissable } from '@/hooks/useDismissable'
import { useAnchoredPosition } from '@/hooks/useAnchoredPosition'
import { getTerminalRuntime, subscribeTerminalRuntime } from '@/lib/terminalRuntime'
import { useTranslation } from '../../i18n'
import { workspaceTabTitle } from '../../stores/workspaceStore'
import { useMenuKeyboard } from './menuKeyboard'
import { WorkspaceFileIcon } from './WorkspaceFileIcon'
import type { WorkspaceDock, WorkspaceTab } from '../../lib/workspace/types'

const DRAG_START_THRESHOLD = 4

const KIND_ICON = {
  file: FolderClosed,
  browser: Globe,
  review: SquareSplitVertical,
  terminal: SquareTerminal,
} as const

export type WorkspaceTabStripProps = {
  dock: WorkspaceDock
  placement?: 'window' | 'dock'
  tabs: WorkspaceTab[]
  activeTabId: string | null
  onActivate: (tabId: string) => void
  /** Double click pins a preview tab, matching the file tree's own gesture. */
  onPin: (tabId: string) => void
  onClose: (tabId: string) => void
  onCloseScope: (tabId: string, scope: 'others' | 'right' | 'all') => void
  onReorder: (tabId: string, targetIndex: number) => void
  onMoveDock?: (tabId: string, dock: WorkspaceDock) => void
  onReopenClosed: () => void
  canReopenClosed: boolean
  addMenuId?: string
  addMenuOpen?: boolean
  onAdd: (trigger: HTMLButtonElement, initialFocus?: 'first' | 'last') => void
}

export function WorkspaceTabStrip({
  dock,
  placement = 'dock',
  tabs,
  activeTabId,
  onActivate,
  onPin,
  onClose,
  onCloseScope,
  onReorder,
  onMoveDock,
  onReopenClosed,
  canReopenClosed,
  addMenuId,
  addMenuOpen = false,
  onAdd,
}: WorkspaceTabStripProps) {
  const t = useTranslation()
  const [, refreshTerminalState] = useState(0)
  useEffect(() => {
    const unsubscribers = tabs.filter((tab) => tab.kind === 'terminal').map((tab) =>
      subscribeTerminalRuntime(getTerminalRuntime(tab.runtimeId, 'idle'), () => refreshTerminalState((value) => value + 1)),
    )
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [tabs])
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuTriggerRef = useRef<HTMLElement | null>(null)
  const menuPosition = useAnchoredPosition({
    open: menu !== null,
    anchorRect: { top: menu?.y ?? 0, bottom: menu?.y ?? 0, left: menu?.x ?? 0, right: menu?.x ?? 0 },
    floatingRef: menuRef,
    offset: 0,
    clampHeight: true,
  })
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [focusedTabId, setFocusedTabId] = useState<string | null>(null)
  const dragRef = useRef<{ tabId: string; index: number; startX: number } | null>(null)
  const centersRef = useRef<number[]>([])
  const tabRefs = useRef(new Map<string, HTMLElement | null>())
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement | null>())
  const tabListRef = useRef<HTMLDivElement>(null)
  const suppressClickRef = useRef(false)

  useLayoutEffect(() => {
    const strip = tabListRef.current
    const active = activeTabId ? tabRefs.current.get(activeTabId) : null
    if (!strip || !active) return
    const viewport = strip.getBoundingClientRect()
    const tab = active.getBoundingClientRect()
    if (viewport.width <= 0 || tab.width <= 0) return
    // Change only this strip's horizontal offset. scrollIntoView can move the
    // entire conversation, and focusing the tab would steal the content focus
    // requested by file/browser/terminal openers.
    if (tab.left < viewport.left) strip.scrollLeft += tab.left - viewport.left
    else if (tab.right > viewport.right) {
      strip.scrollLeft += Math.min(tab.right - viewport.right, tab.left - viewport.left)
    }
  }, [activeTabId, tabs])

  useEffect(() => {
    if (menu && !tabs.some((tab) => tab.id === menu.tabId && tab.dock === dock)) setMenu(null)
  }, [dock, menu, tabs])

  const closeMenu = useCallback(() => setMenu(null), [])
  useDismissable({ open: menu !== null, refs: [menuRef], onDismiss: closeMenu })
  const handleMenuKeyDown = useMenuKeyboard({
    open: menu !== null,
    menuRef,
    triggerRef: menuTriggerRef,
    onClose: closeMenu,
  })

  /**
   * Roving tabindex: one tab is in the page's tab order, and the arrow keys
   * move which one. `tabIndex={isActive ? 0 : -1}` alone was half the pattern —
   * it made every tab but the active one unreachable by any means, since
   * nothing moved the tab stop.
   */
  const rovingTabId = focusedTabId && tabs.some((tab) => tab.id === focusedTabId)
    ? focusedTabId
    : activeTabId ?? tabs[0]?.id ?? null

  const focusTabAt = (index: number) => {
    const target = tabs[Math.max(0, Math.min(tabs.length - 1, index))]
    if (!target) return
    setFocusedTabId(target.id)
    tabButtonRefs.current.get(target.id)?.focus()
  }

  // Focus moves without switching content. Automatic activation would open a
  // page or attach a PTY for every tab the arrow keys pass over.
  const handleTabKeyDown = (event: React.KeyboardEvent, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault()
        focusTabAt(index + 1)
        break
      case 'ArrowLeft':
        event.preventDefault()
        focusTabAt(index - 1)
        break
      case 'Home':
        event.preventDefault()
        focusTabAt(0)
        break
      case 'End':
        event.preventDefault()
        focusTabAt(tabs.length - 1)
        break
      default:
        break
    }
  }

  const openMenuAt = (event: React.MouseEvent, tabId: string) => {
    event.preventDefault()
    menuTriggerRef.current = tabButtonRefs.current.get(tabId) ?? null
    setMenu({ tabId, x: event.clientX, y: event.clientY })
  }

  const handlePointerDown = (event: React.PointerEvent, tab: WorkspaceTab, index: number) => {
    if (event.button !== 0) return
    suppressClickRef.current = false
    // Freeze midpoints before anything transforms: reading the dragged tab's
    // live rect makes its own centre follow the pointer and it targets itself.
    centersRef.current = tabs.map((candidate) => {
      const rect = tabRefs.current.get(candidate.id)?.getBoundingClientRect()
      return rect ? rect.left + rect.width / 2 : Number.NaN
    })
    dragRef.current = { tabId: tab.id, index, startX: event.clientX }
  }

  const handlePointerMove = (event: React.PointerEvent) => {
    const pending = dragRef.current
    if (!pending) return
    if (!draggingId) {
      if (Math.abs(event.clientX - pending.startX) < DRAG_START_THRESHOLD) return
      setDraggingId(pending.tabId)
      suppressClickRef.current = true
    }
    const target = centersRef.current.findIndex(
      (centre) => Number.isFinite(centre) && event.clientX < centre,
    )
    const index = target < 0 ? tabs.length - 1 : target
    if (index !== pending.index) {
      onReorder(pending.tabId, index)
      pending.index = index
      centersRef.current = tabs.map((candidate) => {
        const rect = tabRefs.current.get(candidate.id)?.getBoundingClientRect()
        return rect ? rect.left + rect.width / 2 : Number.NaN
      })
    }
  }

  const endDrag = () => {
    dragRef.current = null
    setDraggingId(null)
  }

  const menuDockTabs = tabs.filter((tab) => tab.dock === dock)
  const menuTabIndex = menuDockTabs.findIndex((tab) => tab.id === menu?.tabId)
  const menuTab = menuDockTabs[menuTabIndex]
  const menuRuntime = menuTab?.kind === 'terminal' ? getTerminalRuntime(menuTab.runtimeId, 'idle') : null
  const activeTerminalTab = tabs.find((tab) => tab.id === activeTabId && tab.kind === 'terminal')
  const canCloseOthers = menuTabIndex >= 0 && menuDockTabs.length > 1
  const canCloseRight = menuTabIndex >= 0 && menuTabIndex < menuDockTabs.length - 1

  return (
    <div
      data-testid={`workspace-tab-strip-${dock}`}
      data-desktop-drag-region={placement === 'window' ? true : undefined}
      className={`flex min-w-0 shrink-0 items-stretch gap-1 bg-[var(--color-surface)] pl-2 pr-1 ${placement === 'window' ? 'h-[52px] flex-1' : 'h-10 border-b border-[var(--color-border)]'}`}
    >
      <div className="flex min-w-0 flex-1 items-stretch gap-1">
        <div
          ref={tabListRef}
          role="tablist"
          aria-label={t('workspace.tabStrip')}
          aria-orientation="horizontal"
          className="flex min-w-0 items-stretch gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
        >
          {tabs.map((tab, index) => {
            const Icon = KIND_ICON[tab.kind]
            const runtime = tab.kind === 'terminal' ? getTerminalRuntime(tab.runtimeId, 'idle') : null
            const title = runtime?.title?.trim() || workspaceTabTitle(tab, {
              newTab: t('workspace.newTabTitle'),
              review: t('workspace.reviewTabTitle'),
              files: t('workspace.files.openTitle'),
              terminal: (ordinal) => t('workspace.terminalTabTitle', { n: ordinal }),
            })
            const isActive = tab.id === activeTabId
            const isRoving = tab.id === rovingTabId
            return (
              /*
                The tab and its close control are siblings inside a presentational
                wrapper. Nesting the close button *inside* `role="tab"` was
                invalid — a tab may not contain an interactive descendant — and
                left the close affordance unreachable by keyboard.
              */
              <div
                key={tab.id}
                ref={(node) => { tabRefs.current.set(tab.id, node) }}
                role="presentation"
                data-testid={`workspace-tab-wrap-${tab.id}`}
                data-preview={tab.preview ? 'true' : 'false'}
                data-dragging={draggingId === tab.id ? 'true' : 'false'}
                onPointerDown={(event) => handlePointerDown(event, tab, index)}
                onDoubleClick={() => onPin(tab.id)}
                onContextMenu={(event) => openMenuAt(event, tab.id)}
                className={[
                  `tab-bar-interactive group ${placement === 'window' ? 'my-2.5' : 'my-1'} flex min-w-[112px] max-w-[200px] cursor-default items-center gap-0.5 rounded-[var(--radius-md)] pl-2 pr-1 transition-colors`,
                  isActive
                    ? 'bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]',
                ].join(' ')}
              >
                <button
                  ref={(node) => { tabButtonRefs.current.set(tab.id, node) }}
                  type="button"
                  role="tab"
                  id={`workspace-tab-${dock}-${tab.id}`}
                  tabIndex={isRoving ? 0 : -1}
                  aria-selected={isActive}
                  title={tab.kind === 'terminal' ? [runtime?.shellInfo?.cwd || tab.cwd, runtime?.shellInfo?.shell].filter(Boolean).join(' · ') : title}
                  /*
                    The tab does carry a popup (right-click), so this is true.
                    `aria-expanded` deliberately stays off: on `role="tab"` it
                    describes the tab *panel*, so using it for the context menu
                    would announce the content as collapsed.
                  */
                  aria-haspopup="menu"
                  data-testid={`workspace-tab-${tab.id}`}
                  data-preview={tab.preview ? 'true' : 'false'}
                  onFocus={() => setFocusedTabId(tab.id)}
                  onClick={() => {
                    if (suppressClickRef.current) {
                      suppressClickRef.current = false
                      return
                    }
                    onActivate(tab.id)
                  }}
                  onMouseDown={(event) => {
                    if (event.button === 1) {
                      event.preventDefault()
                      event.stopPropagation()
                    }
                  }}
                  onMouseUp={(event) => {
                    if (event.button === 1) {
                      event.preventDefault()
                      event.stopPropagation()
                    }
                  }}
                  onAuxClick={(event) => {
                    if (event.button !== 1) return
                    event.preventDefault()
                    event.stopPropagation()
                    onClose(tab.id)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                      event.preventDefault()
                      const rect = event.currentTarget.getBoundingClientRect()
                      menuTriggerRef.current = event.currentTarget
                      setMenu({ tabId: tab.id, x: rect.left, y: rect.bottom })
                    } else handleTabKeyDown(event, index)
                  }}
                  className="flex h-7 min-w-0 flex-1 cursor-default items-center gap-1.5 rounded-[var(--radius-sm)] text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
                >
                  {tab.kind === 'file' && tab.path ? <WorkspaceFileIcon path={tab.path} /> : (
                    <Icon size={14} strokeWidth={1.9} aria-hidden="true" className="shrink-0" />
                  )}
                  {/*
                    A preview tab is italic and nothing else. A dedicated badge or a
                    dotted border would make the replaceable state louder than the
                    file name, and the state only matters at the moment the next
                    single click replaces it.
                  */}
                  <span className={`min-w-0 flex-1 truncate text-[13px] ${tab.preview ? 'italic' : ''}`}>
                    {title}
                  </span>
                </button>
                <span className={`shrink-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 ${isActive ? 'opacity-100' : 'opacity-0'}`}>
                  <IconButton
                    icon="close"
                    label={t('workspace.tabClose', { title })}
                    size="2xs"
                    tone="muted"
                    showTooltip={false}
                    // Shares the tab's stop in the roving order: Tab reaches the
                    // active tab, then its close control, then the next control.
                    tabIndex={isRoving ? 0 : -1}
                    data-testid={`workspace-tab-close-${tab.id}`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation()
                      onClose(tab.id)
                    }}
                  />
                </span>
              </div>
            )
          })}
        </div>

        <span className="tab-bar-interactive flex shrink-0 items-center">
          <IconButton
            icon={<Plus size={15} strokeWidth={2} />}
            label={t('workspace.tabAdd')}
            size="sm"
            tone="muted"
            data-testid={`workspace-add-tab-${dock}`}
            aria-haspopup="menu"
            aria-expanded={addMenuOpen}
            aria-controls={addMenuOpen ? addMenuId : undefined}
            pressed={addMenuOpen}
            onClick={(event) => onAdd(event.currentTarget)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
              event.preventDefault()
              event.stopPropagation()
              onAdd(event.currentTarget, event.key === 'ArrowDown' ? 'first' : 'last')
            }}
          />
        </span>
      </div>

      {activeTerminalTab ? (
        <span className="tab-bar-interactive flex shrink-0 items-center">
          <IconButton
            icon={<MoreHorizontal size={16} />}
            label={t('workspace.tabMenu')}
            size="sm"
            tone="muted"
            aria-haspopup="menu"
            aria-expanded={menu?.tabId === activeTerminalTab.id}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              menuTriggerRef.current = event.currentTarget
              setMenu({ tabId: activeTerminalTab.id, x: Math.max(8, rect.right - 210), y: rect.bottom })
            }}
          />
        </span>
      ) : null}

      {menu ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t('workspace.tabMenu')}
          data-testid="workspace-tab-menu"
          onKeyDown={handleMenuKeyDown}
          className="fixed z-[var(--z-dropdown)] min-w-[190px] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-1.5 shadow-[var(--shadow-dropdown)]"
          style={menuPosition.style}
        >
          {menuRuntime ? <>
            <WorkspaceTabMenuItem
              label={t('settings.terminal.clear')}
              disabled={!menuRuntime.terminal}
              onSelect={() => { menuRuntime.terminal?.clear(); closeMenu(); menuRuntime.terminal?.focus() }}
            />
            <WorkspaceTabMenuItem
              label={t('settings.terminal.restart')}
              disabled={!menuRuntime.restart || menuRuntime.status === 'starting' || menuRuntime.status === 'unavailable'}
              onSelect={() => { menuRuntime.restart?.(); closeMenu() }}
            />
            <div className="my-1 border-t border-[var(--color-border)]" />
          </> : null}
          <WorkspaceTabMenuItem label={t('workspace.tabCloseCurrent')} onSelect={() => { onClose(menu.tabId); closeMenu() }} />
          <WorkspaceTabMenuItem label={t('workspace.tabCloseOthers')} disabled={!canCloseOthers} onSelect={() => { onCloseScope(menu.tabId, 'others'); closeMenu() }} />
          <WorkspaceTabMenuItem label={t('workspace.tabCloseRight')} disabled={!canCloseRight} onSelect={() => { onCloseScope(menu.tabId, 'right'); closeMenu() }} />
          <WorkspaceTabMenuItem label={t('workspace.tabCloseAll')} onSelect={() => { onCloseScope(menu.tabId, 'all'); closeMenu() }} />
          <div className="my-1 border-t border-[var(--color-border)]" />
          <WorkspaceTabMenuItem
            label={t('workspace.tabReopenClosed')}
            disabled={!canReopenClosed}
            onSelect={() => { onReopenClosed(); closeMenu() }}
          />
          {onMoveDock && tabs.find((tab) => tab.id === menu.tabId)?.kind === 'terminal' ? (
            <WorkspaceTabMenuItem
              label={dock === 'side' ? t('workspace.tabMoveToBottom') : t('workspace.tabMoveToSide')}
              onSelect={() => {
                onMoveDock(menu.tabId, dock === 'side' ? 'bottom' : 'side')
                closeMenu()
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function WorkspaceTabMenuItem({
  label,
  onSelect,
  disabled = false,
}: {
  label: string
  onSelect: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className="w-full px-3.5 py-1.5 text-left text-[12px] text-[var(--color-text-primary)] outline-none transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:text-[var(--color-text-tertiary)] disabled:hover:bg-transparent"
    >
      {label}
    </button>
  )
}
