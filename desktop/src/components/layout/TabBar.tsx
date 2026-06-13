import { forwardRef, useMemo, useRef, useState, useEffect, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  SCHEDULED_TAB_ID,
  SETTINGS_TAB_ID,
  TERMINAL_TAB_PREFIX,
  TRACE_LIST_TAB_ID,
  TRACE_TAB_PREFIX,
  useTabStore,
  type Tab,
} from '../../stores/tabStore'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { useTerminalPanelStore } from '../../stores/terminalPanelStore'
import { useTranslation } from '../../i18n'
import { getDesktopHost } from '../../lib/desktopHost'
import { WindowControls, showWindowControls } from './WindowControls'
import { OpenProjectMenu } from './OpenProjectMenu'
import { Folder, FolderOpen, SquareTerminal } from 'lucide-react'
import { ActionDialog } from '../shared/ActionDialog'

const TAB_WIDTH = 180
const DRAG_START_THRESHOLD = 4
const desktopHost = getDesktopHost()
const isDesktopRuntime = desktopHost.isDesktop

type PendingCloseRequest = {
  tabs: Tab[]
  runningSessionIds: string[]
}

function isSessionTab(tab: Tab | null) {
  if (!tab) return false
  const tabType = (tab as Partial<Tab>).type
  if (tabType === 'session') return true
  if (tabType) return false
  return isSessionTabId(tab.sessionId)
}

function isSessionTabId(tabId: string | null) {
  if (!tabId) return false
  return tabId !== SETTINGS_TAB_ID &&
    tabId !== SCHEDULED_TAB_ID &&
    tabId !== TRACE_LIST_TAB_ID &&
    !tabId.startsWith(TERMINAL_TAB_PREFIX) &&
    !tabId.startsWith(TRACE_TAB_PREFIX)
}

export function TabBar() {
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const setActiveTab = useTabStore((s) => s.setActiveTab)
  const closeTab = useTabStore((s) => s.closeTab)
  const sessionTabIds = useMemo(
    () => tabs.filter((tab) => isSessionTab(tab)).map((tab) => tab.sessionId),
    [tabs],
  )
  const activeChatSessionIds = useChatStore(useShallow((s) =>
    sessionTabIds.filter((sessionId) => s.sessions[sessionId]?.chatState !== 'idle')
  ))
  const disconnectSession = useChatStore((s) => s.disconnectSession)
  const activeTab = tabs.find((tab) => tab.sessionId === activeTabId) ?? null
  const isActiveSessionTab = isSessionTab(activeTab) || isSessionTabId(activeTabId)
  const activeSession = useSessionStore((state) =>
    activeTabId ? state.sessions.find((session) => session.id === activeTabId) : undefined,
  )
  const openProjectPath = isActiveSessionTab && activeSession?.workDirExists !== false
    ? activeSession?.workDir ?? null
    : null
  // The right-side panel is now a single unified "workbench" with a per-session
  // mode (file ↔ browser). The folder/browser toolbar buttons reflect whether
  // the panel is open in their respective mode.
  const isWorkbenchOpen = useWorkspacePanelStore((state) =>
    activeTabId && isActiveSessionTab ? state.isPanelOpen(activeTabId) : false,
  )
  const workbenchMode = useWorkspacePanelStore((state) =>
    activeTabId && isActiveSessionTab ? state.getMode(activeTabId) : 'workspace',
  )
  const isWorkspacePanelOpen = isWorkbenchOpen && workbenchMode === 'workspace'
  const isTerminalPanelOpen = useTerminalPanelStore((state) =>
    activeTabId && isActiveSessionTab ? state.isPanelOpen(activeTabId) : false,
  )

  const moveTab = useTabStore((s) => s.moveTab)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null)
  const [pendingCloseRequest, setPendingCloseRequest] = useState<PendingCloseRequest | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null)
  const [dragOffsetX, setDragOffsetX] = useState(0)
  const dragIndexRef = useRef<number | null>(null)
  const pendingDragRef = useRef<{ index: number; startX: number; startY: number } | null>(null)
  const suppressClickRef = useRef(false)
  const tabRefs = useRef(new Map<string, HTMLDivElement | null>())
  const t = useTranslation()
  const runningSessionIds = useMemo(() => {
    const ids = new Set<string>()
    for (const tab of tabs) {
      if (isSessionTab(tab) && tab.status === 'running') ids.add(tab.sessionId)
    }
    for (const sessionId of activeChatSessionIds) {
      ids.add(sessionId)
    }
    return ids
  }, [activeChatSessionIds, tabs])

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 0)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    updateScrollState()
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', updateScrollState)
    const ro = new ResizeObserver(updateScrollState)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', updateScrollState)
      ro.disconnect()
    }
  }, [updateScrollState, tabs.length])

  useEffect(() => {
    if (!activeTabId) return
    const activeTabEl = tabRefs.current.get(activeTabId)
    if (!activeTabEl) return

    activeTabEl.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'smooth',
    })

    const frame = window.requestAnimationFrame(updateScrollState)
    return () => window.cancelAnimationFrame(frame)
  }, [activeTabId, tabs.length, updateScrollState])

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [contextMenu])

  const scroll = (direction: 'left' | 'right') => {
    const el = scrollRef.current
    if (!el) return
    el.scrollBy({ left: direction === 'left' ? -TAB_WIDTH : TAB_WIDTH, behavior: 'smooth' })
  }

  /**
   * Translate vertical mouse-wheel input into horizontal tab-bar scroll
   * so users on a plain mouse (no trackpad) can wheel-scroll the tab
   * strip just by hovering it. Trackpad users get this for free —
   * `deltaX` from a two-finger sideways swipe already scrolls the
   * container natively, and we deliberately do NOT touch deltaX-
   * dominated wheel events so that input keeps its native feel and
   * momentum.
   *
   * Why preventDefault: when the cursor is over the tab bar AND we
   * successfully consumed the wheel into horizontal scroll, the user
   * doesn't want the page below the tab bar to also scroll vertically
   * (jumping back to the same scroll experience as native browser
   * tab strips). preventDefault here is safe because we attach the
   * handler via a non-passive native listener (React's onWheel maps
   * to addEventListener with passive:true on some platforms; using
   * the imperative form below avoids that pitfall).
   */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      // Trackpad horizontal swipe already scrolls horizontally —
      // pass through so momentum / direction feel native.
      if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return
      // Nothing to scroll → bubble normally so the page can scroll.
      if (el.scrollWidth <= el.clientWidth) return
      // Map vertical wheel into horizontal scroll.
      // Use deltaY directly; it's already a "lines or pixels"
      // delta the browser tuned for one notch of wheel travel.
      el.scrollLeft += e.deltaY
      e.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const closeTabWithCleanup = useCallback((tab: Tab) => {
    if (isSessionTab(tab)) {
      useWorkspacePanelStore.getState().clearSession(tab.sessionId)
      useTerminalPanelStore.getState().clearSession(tab.sessionId)
    }
    closeTab(tab.sessionId)
  }, [closeTab])

  const getRunningSessionIds = useCallback((targetTabs: Tab[]) => {
    const chatSessions = useChatStore.getState().sessions
    return targetTabs
      .filter((tab) => isSessionTab(tab))
      .filter((tab) => {
        const sessionState = chatSessions[tab.sessionId]
        return !!sessionState && sessionState.chatState !== 'idle'
      })
      .map((tab) => tab.sessionId)
  }, [])

  const closeTabsWithPolicy = useCallback((targetTabs: Tab[], runningSessionIds: string[], stopRunning: boolean) => {
    const runningSessionSet = new Set(runningSessionIds)

    for (const tab of targetTabs) {
      if (isSessionTab(tab)) {
        const isRunning = runningSessionSet.has(tab.sessionId)
        if (isRunning && stopRunning) {
          useChatStore.getState().stopGeneration(tab.sessionId)
        }
        if (!isRunning || stopRunning) {
          disconnectSession(tab.sessionId)
        }
      }
      closeTabWithCleanup(tab)
    }
  }, [closeTabWithCleanup, disconnectSession])

  const requestCloseTabs = useCallback((targetTabs: Tab[]) => {
    if (targetTabs.length === 0) return
    const runningSessionIds = getRunningSessionIds(targetTabs)

    if (runningSessionIds.length > 0) {
      setPendingCloseRequest({ tabs: targetTabs, runningSessionIds })
      return
    }

    closeTabsWithPolicy(targetTabs, [], false)
  }, [closeTabsWithPolicy, getRunningSessionIds])

  const handleClose = (sessionId: string) => {
    const tab = tabs.find((t) => t.sessionId === sessionId)
    if (!tab) return
    requestCloseTabs([tab])
  }

  const handleContextMenu = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault()
    setContextMenu({ sessionId, x: e.clientX, y: e.clientY })
  }

  const handleCloseOthers = (sessionId: string) => {
    setContextMenu(null)
    const otherTabs = tabs.filter((t) => t.sessionId !== sessionId)
    requestCloseTabs(otherTabs)
  }

  const handleCloseLeft = (sessionId: string) => {
    setContextMenu(null)
    const idx = tabs.findIndex((t) => t.sessionId === sessionId)
    const leftTabs = tabs.slice(0, idx)
    requestCloseTabs(leftTabs)
  }

  const handleCloseRight = (sessionId: string) => {
    setContextMenu(null)
    const idx = tabs.findIndex((t) => t.sessionId === sessionId)
    const rightTabs = tabs.slice(idx + 1)
    requestCloseTabs(rightTabs)
  }

  const handleCloseAll = () => {
    setContextMenu(null)
    requestCloseTabs(tabs)
  }

  const getTargetIndexFromClientX = useCallback((clientX: number) => {
    for (let index = 0; index < tabs.length; index++) {
      const tab = tabs[index]
      if (!tab) continue
      const el = tabRefs.current.get(tab.sessionId)
      if (!el) continue
      const rect = el.getBoundingClientRect()
      if (clientX < rect.left + rect.width / 2) return index
    }

    return tabs.length > 0 ? tabs.length - 1 : null
  }, [tabs])

  const finalizeDrag = useCallback((targetIndex: number | null) => {
    if (dragIndexRef.current !== null && targetIndex !== null && dragIndexRef.current !== targetIndex) {
      moveTab(dragIndexRef.current, targetIndex)
    }
    dragIndexRef.current = null
    pendingDragRef.current = null
    setDraggingSessionId(null)
    setDragOffsetX(0)
    setDragOverIndex(null)
  }, [moveTab])

  const handlePointerMove = useCallback((event: MouseEvent) => {
    const pending = pendingDragRef.current
    if (!pending) return

    const deltaX = Math.abs(event.clientX - pending.startX)
    const deltaY = Math.abs(event.clientY - pending.startY)

    if (dragIndexRef.current === null) {
      if (Math.max(deltaX, deltaY) < DRAG_START_THRESHOLD) return
      dragIndexRef.current = pending.index
      suppressClickRef.current = true
      setDraggingSessionId(tabs[pending.index]?.sessionId ?? null)
    }

    setDragOffsetX(event.clientX - pending.startX)

    const targetIndex = getTargetIndexFromClientX(event.clientX)
    if (targetIndex === null || targetIndex === dragIndexRef.current) {
      setDragOverIndex(null)
      return
    }

    setDragOverIndex(targetIndex)
  }, [getTargetIndexFromClientX])

  const handlePointerUp = useCallback(() => {
    finalizeDrag(dragOverIndex)
  }, [dragOverIndex, finalizeDrag])

  useEffect(() => {
    window.addEventListener('mousemove', handlePointerMove)
    window.addEventListener('mouseup', handlePointerUp)
    return () => {
      window.removeEventListener('mousemove', handlePointerMove)
      window.removeEventListener('mouseup', handlePointerUp)
    }
  }, [handlePointerMove, handlePointerUp])

  useEffect(() => {
    if (!draggingSessionId) return
    const previousCursor = document.body.style.cursor
    document.body.style.cursor = 'grabbing'
    return () => {
      document.body.style.cursor = previousCursor
    }
  }, [draggingSessionId])

  const handleTabMouseDown = (event: React.MouseEvent, index: number) => {
    if (event.button !== 0) return
    pendingDragRef.current = { index, startX: event.clientX, startY: event.clientY }
  }

  const handleTabClick = (sessionId: string) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    setActiveTab(sessionId)
  }

  return (
    <div
      data-testid="tab-bar"
      data-desktop-drag-region={isDesktopRuntime ? true : undefined}
      className="flex min-h-11 items-stretch bg-[var(--color-surface-container)] select-none border-b border-[var(--color-border)]"
    >

      {canScrollLeft && (
        <button
          onClick={() => scroll('left')}
          aria-label={t('tabs.scrollLeft')}
          className="flex h-11 w-7 flex-shrink-0 items-center justify-center text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
        >
          <span className="material-symbols-outlined text-[16px]">chevron_left</span>
        </button>
      )}

      <div
        ref={scrollRef}
        data-testid="tab-bar-scroll-region"
        data-desktop-drag-region={isDesktopRuntime ? true : undefined}
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onDragOver={(e) => e.preventDefault()}
      >
        {tabs.map((tab, index) => (
          <TabItem
            key={tab.sessionId}
            ref={(node) => { tabRefs.current.set(tab.sessionId, node) }}
            tab={tab}
            isRunning={runningSessionIds.has(tab.sessionId)}
            isActive={tab.sessionId === activeTabId}
            isDragOver={dragOverIndex === index}
            isDragging={tab.sessionId === draggingSessionId}
            dragOffsetX={tab.sessionId === draggingSessionId ? dragOffsetX : 0}
            runningLabel={t('tabs.sessionRunning')}
            onClick={() => handleTabClick(tab.sessionId)}
            onClose={() => handleClose(tab.sessionId)}
            onContextMenu={(e) => handleContextMenu(e, tab.sessionId)}
            onMouseDown={(event) => handleTabMouseDown(event, index)}
          />
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-1 border-l border-[var(--color-border)]/70 px-2">
        {isDesktopRuntime && isActiveSessionTab && (
          <OpenProjectMenu path={openProjectPath} />
        )}
        <ToolbarIconButton
          icon={<SquareTerminal size={17} strokeWidth={1.9} />}
          label={t('tabs.openTerminal')}
          onClick={() => {
            if (activeTabId && isActiveSessionTab) {
              useTerminalPanelStore.getState().togglePanel(activeTabId)
              return
            }
            useTabStore.getState().openTerminalTab()
          }}
          active={isTerminalPanelOpen}
        />
        {isActiveSessionTab && activeTabId && (
          <ToolbarIconButton
            icon={isWorkspacePanelOpen ? <FolderOpen size={18} strokeWidth={1.9} /> : <Folder size={18} strokeWidth={1.9} />}
            label={t(isWorkspacePanelOpen ? 'tabs.hideWorkspace' : 'tabs.showWorkspace')}
            onClick={() => {
              const workbench = useWorkspacePanelStore.getState()
              if (workbench.isPanelOpen(activeTabId) && workbench.getMode(activeTabId) === 'workspace') {
                workbench.closePanel(activeTabId)
              } else {
                workbench.setMode(activeTabId, 'workspace')
                workbench.openPanel(activeTabId)
              }
            }}
            active={isWorkspacePanelOpen}
          />
        )}
      </div>

      {isDesktopRuntime && (
        <div
          data-testid="tab-bar-drag-gutter"
          data-desktop-drag-region
          aria-hidden="true"
          className={`min-h-11 flex-shrink-0 ${showWindowControls ? 'w-3' : 'w-4'}`}
        />
      )}

      {canScrollRight && (
        <button
          onClick={() => scroll('right')}
          aria-label={t('tabs.scrollRight')}
          className="flex h-11 w-7 flex-shrink-0 items-center justify-center text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
        >
          <span className="material-symbols-outlined text-[16px]">chevron_right</span>
        </button>
      )}

      <WindowControls />

      {contextMenu && (
        <div
          className="fixed z-50 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-md)] py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y, boxShadow: 'var(--shadow-dropdown)' }}
        >
          <button
            onClick={() => { handleClose(contextMenu.sessionId); setContextMenu(null) }}
            className="w-full px-3 py-1.5 text-xs text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.close')}
          </button>
          <button
            onClick={() => handleCloseOthers(contextMenu.sessionId)}
            className="w-full px-3 py-1.5 text-xs text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeOthers')}
          </button>
          <button
            onClick={() => handleCloseLeft(contextMenu.sessionId)}
            className="w-full px-3 py-1.5 text-xs text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeLeft')}
          </button>
          <button
            onClick={() => handleCloseRight(contextMenu.sessionId)}
            className="w-full px-3 py-1.5 text-xs text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeRight')}
          </button>
          <div className="my-1 border-t border-[var(--color-border)]" />
          <button
            onClick={handleCloseAll}
            className="w-full px-3 py-1.5 text-xs text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeAll')}
          </button>
        </div>
      )}

      <ActionDialog
        open={pendingCloseRequest !== null}
        onClose={() => setPendingCloseRequest(null)}
        title={pendingCloseRequest && pendingCloseRequest.runningSessionIds.length > 1
          ? t('tabs.closeAllConfirmTitle')
          : t('tabs.closeConfirmTitle')}
        body={pendingCloseRequest && pendingCloseRequest.runningSessionIds.length > 1
          ? t('tabs.closeAllConfirmMessage', { count: pendingCloseRequest.runningSessionIds.length })
          : t('tabs.closeConfirmMessage')}
        actions={[
          {
            label: t('common.cancel'),
            onClick: () => setPendingCloseRequest(null),
            variant: 'secondary',
          },
          {
            label: t('tabs.closeConfirmKeep'),
            onClick: () => {
              if (!pendingCloseRequest) return
              closeTabsWithPolicy(pendingCloseRequest.tabs, pendingCloseRequest.runningSessionIds, false)
              setPendingCloseRequest(null)
            },
            variant: 'secondary',
          },
          {
            label: pendingCloseRequest && pendingCloseRequest.runningSessionIds.length > 1
              ? t('tabs.closeAllConfirmStop')
              : t('tabs.closeConfirmStop'),
            onClick: () => {
              if (!pendingCloseRequest) return
              closeTabsWithPolicy(pendingCloseRequest.tabs, pendingCloseRequest.runningSessionIds, true)
              setPendingCloseRequest(null)
            },
            variant: 'danger',
          },
        ]}
      />
    </div>
  )
}

const TabItem = forwardRef<HTMLDivElement, {
  tab: Tab
  isRunning: boolean
  isActive: boolean
  isDragOver: boolean
  isDragging: boolean
  dragOffsetX: number
  runningLabel: string
  onClick: () => void
  onClose: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onMouseDown: (event: React.MouseEvent) => void
}>(({ tab, isRunning, isActive, isDragOver, isDragging, dragOffsetX, runningLabel, onClick, onClose, onContextMenu, onMouseDown }, ref) => {
  return (
    <div
      ref={ref}
      data-dragging={isDragging ? 'true' : 'false'}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      className={`
        tab-bar-interactive group relative flex min-h-11 flex-shrink-0 items-center gap-1.5 px-3
        ${isDragging ? 'z-20 cursor-grabbing' : 'cursor-grab'}
        transition-[background-color,box-shadow,opacity,transform] duration-150 ease-out
        ${isActive
          ? 'bg-[var(--color-surface)] shadow-[inset_0_-2px_0_var(--color-brand)]'
          : 'bg-transparent hover:bg-[var(--color-surface-hover)]'
        }
        ${isDragging ? 'opacity-95 shadow-[0_10px_24px_rgba(0,0,0,0.18)] ring-1 ring-[var(--color-border)]' : ''}
        ${isDragOver ? 'before:absolute before:left-0 before:top-[4px] before:bottom-[4px] before:w-[3px] before:bg-[var(--color-brand)] before:rounded-full before:shadow-[0_0_0_1px_rgba(255,255,255,0.25)]' : ''}
      `}
      style={{
        width: TAB_WIDTH,
        maxWidth: TAB_WIDTH,
        transform: isDragging ? `translateX(${dragOffsetX}px) scale(1.02)` : undefined,
      }}
    >
      {tab.type === 'session' && isRunning && (
        <span
          className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--color-success)] animate-pulse"
          aria-label={runningLabel}
          title={runningLabel}
        />
      )}
      {tab.type === 'session' && tab.status === 'error' && (
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-error)] flex-shrink-0" />
      )}
      {tab.type === 'settings' && (
        <span className="material-symbols-outlined text-[14px] flex-shrink-0 text-[var(--color-text-tertiary)]">settings</span>
      )}
      {tab.type === 'scheduled' && (
        <span className="material-symbols-outlined text-[14px] flex-shrink-0 text-[var(--color-text-tertiary)]">schedule</span>
      )}
      {tab.type === 'terminal' && (
        <span className="material-symbols-outlined text-[14px] flex-shrink-0 text-[var(--color-text-tertiary)]">terminal</span>
      )}

      <span className={`flex-1 truncate text-xs ${isActive ? 'text-[var(--color-text-primary)] font-medium' : 'text-[var(--color-text-secondary)]'}`}>
        {tab.title || 'Untitled'}
      </span>

      <button
        type="button"
        aria-label={`Close ${tab.title || 'Untitled'}`}
        onMouseDown={(e) => { e.stopPropagation() }}
        onClick={(e) => { e.stopPropagation(); onClose() }}
        className="flex-shrink-0 -mr-0.5 inline-flex h-3 w-3 items-center justify-center bg-transparent p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-[opacity,color] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] focus-visible:outline-none"
      >
        <span className="material-symbols-outlined text-[11px] leading-none">close</span>
      </button>
    </div>
  )
})
TabItem.displayName = 'TabItem'

function ToolbarIconButton({
  icon,
  label,
  onClick,
  active = false,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  active?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      data-active={active ? 'true' : 'false'}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
        active
          ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)]'
          : 'text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
      }`}
    >
      {icon}
    </button>
  )
}
