import { forwardRef, useMemo, useRef, useState, useEffect, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  SCHEDULED_TAB_ID,
  SETTINGS_TAB_ID,
  MARKET_TAB_ID,
  SUBAGENT_TAB_PREFIX,
  TERMINAL_TAB_PREFIX,
  TRACE_LIST_TAB_ID,
  TRACE_TAB_PREFIX,
  WORKBENCH_TAB_PREFIX,
  useTabStore,
  type Tab,
  type TabType,
} from '../../stores/tabStore'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { isPlaceholderSessionTitle } from '../../lib/sessionTitle'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { useTerminalPanelStore } from '../../stores/terminalPanelStore'
import { useCLITaskStore } from '../../stores/cliTaskStore'
import { useTeamStore } from '../../stores/teamStore'
import { StatusDot } from '@/components/ui/Badge'
import { IconButton } from '@/components/ui/IconButton'
import { useDismissable } from '@/hooks/useDismissable'
import { useTranslation } from '../../i18n'
import { getDesktopHost } from '../../lib/desktopHost'
import { hasRunningBackgroundTasks } from '../../lib/backgroundTasks'
import { WindowControls, showWindowControls } from './WindowControls'
import { OpenProjectMenu } from './OpenProjectMenu'
import { Folder, FolderOpen, SquareTerminal } from 'lucide-react'
import { ActionDialog } from '@/components/ui/ActionDialog'
import { buildSessionActivityModel, hasVisibleSessionActivity } from '../activity/sessionActivityModel'
import { SessionActivityButton } from '../activity/SessionActivityButton'
import { useActivityPanelStore } from '../../stores/activityPanelStore'
import { getSessionBrowsablePath } from '../../lib/sessionWorkspace'

const DRAG_START_THRESHOLD = 4
// Fraction of the visible strip a chevron press travels. Tabs size to their
// titles, so a fixed pixel step would overshoot a row of short ones and
// undershoot a row of long ones; leaving a quarter behind keeps the tab you
// were looking at on screen as an anchor.
const SCROLL_STEP_RATIO = 0.75
// `nearest` on both axes: bring the tab fully on screen with the smallest
// possible move, and leave a tab that is already whole exactly where it is.
const REVEAL_ACTIVE_TAB: ScrollIntoViewOptions = {
  block: 'nearest',
  inline: 'nearest',
  behavior: 'smooth',
}
// Subpixel slack for the "is the active tab whole?" test. Without it a strip
// whose edges land on fractional pixels reports the tab as clipped on every
// single resize and re-scrolls forever.
const TAB_VISIBILITY_TOLERANCE = 1
// One glyph per *non-chat* tab kind: the glyph says "this tab is not a
// conversation". Chat tabs deliberately have none — a bubble on every tab in a
// strip that is mostly chats is pure noise, and the slot it occupied is worth
// more as title. `trace` and `traces` share the Settings rail's glyph on
// purpose — a trace tab should read as that section, not as another chat.
const TAB_TYPE_ICON: Partial<Record<TabType, string>> = {
  settings: 'settings',
  scheduled: 'schedule',
  market: 'storefront',
  terminal: 'terminal',
  trace: 'account_tree',
  traces: 'account_tree',
  workbench: 'view_sidebar',
  subagent: 'smart_toy',
}
const TAB_TYPE_ICON_FALLBACK = 'tab'
const desktopHost = getDesktopHost()
const isDesktopRuntime = desktopHost.isDesktop
const EMPTY_DISMISSED_BACKGROUND_TASK_KEYS: readonly string[] = []

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
    tabId !== MARKET_TAB_ID &&
    tabId !== TRACE_LIST_TAB_ID &&
    !tabId.startsWith(TERMINAL_TAB_PREFIX) &&
    !tabId.startsWith(TRACE_TAB_PREFIX) &&
    !tabId.startsWith(WORKBENCH_TAB_PREFIX) &&
    !tabId.startsWith(SUBAGENT_TAB_PREFIX)
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
    sessionTabIds.filter((sessionId) => {
      const sessionState = s.sessions[sessionId]
      return !!sessionState &&
        (sessionState.chatState !== 'idle' || hasRunningBackgroundTasks(sessionState.backgroundAgentTasks))
    })
  ))
  const disconnectSession = useChatStore((s) => s.disconnectSession)
  const activeTab = tabs.find((tab) => tab.sessionId === activeTabId) ?? null
  const isActiveSessionTab = isSessionTab(activeTab) || isSessionTabId(activeTabId)
  const activeSession = useSessionStore((state) =>
    activeTabId ? state.sessions.find((session) => session.id === activeTabId) : undefined,
  )
  const openProjectPath = isActiveSessionTab
    ? getSessionBrowsablePath(activeSession) ?? null
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
  const cliTasks = useCLITaskStore((state) => state.tasks)
  const cliTasksSessionId = useCLITaskStore((state) => state.sessionId)
  const cliTasksCompletedAndDismissed = useCLITaskStore((state) => state.completedAndDismissed)
  const dismissedBackgroundTaskKeyList = useActivityPanelStore((state) =>
    activeTabId
      ? state.dismissedBackgroundTaskKeysBySession[activeTabId] ?? EMPTY_DISMISSED_BACKGROUND_TASK_KEYS
      : EMPTY_DISMISSED_BACKGROUND_TASK_KEYS,
  )
  const dismissedBackgroundTaskKeys = useMemo(
    () => new Set(dismissedBackgroundTaskKeyList),
    [dismissedBackgroundTaskKeyList],
  )
  const activityTeamMembers = useTeamStore(useShallow((state) => {
    const activeTeam = state.activeTeam
    if (!activeTabId || !activeTeam || activeTeam.leadSessionId !== activeTabId) {
      return []
    }
    return activeTeam.members.filter((member) =>
      !activeTeam.leadAgentId || member.agentId !== activeTeam.leadAgentId
    )
  }))
  const activityState = useChatStore(useShallow((state) => {
    if (!activeTabId || !isActiveSessionTab) {
      return { hasVisibleActivity: false }
    }
    const sessionState = state.sessions[activeTabId]
    const includeCliTasks = cliTasksSessionId === activeTabId

    const model = buildSessionActivityModel({
      sessionId: activeTabId,
      messages: sessionState?.messages ?? [],
      tasks: includeCliTasks ? cliTasks : [],
      completedAndDismissed: includeCliTasks ? cliTasksCompletedAndDismissed : false,
      isForegroundTurnActive: Boolean(sessionState && sessionState.chatState !== 'idle'),
      backgroundTasks: Object.values(sessionState?.backgroundAgentTasks ?? {}),
      dismissedBackgroundTaskKeys,
      agentNotifications: Object.values(sessionState?.agentTaskNotifications ?? {}),
      teamMembers: activityTeamMembers,
    })
    return {
      hasVisibleActivity: hasVisibleSessionActivity(model),
    }
  }))
  const showActivityButton = activeTabId && activityState.hasVisibleActivity && !isWorkbenchOpen

  const moveTab = useTabStore((s) => s.moveTab)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Set the moment the user drives the strip themselves, cleared when they
  // switch tabs. See `realignActiveTab`.
  const userScrolledRef = useRef(false)
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
  const contextMenuRef = useRef<HTMLDivElement>(null)
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

  // Keeping the active tab whole is an invariant the strip has to re-establish
  // after its own width changes, not something a single scroll on activation
  // can settle. The chevrons are why: they are `w-7` siblings of this region,
  // so the moment `updateScrollState` decides the strip overflows they take
  // 28px each out of it — *after* the activation scroll has already landed on
  // a scrollLeft computed without them. Measured on a 1280px window with seven
  // tabs: the scroll stopped at 108 when the reachable end had moved to 164,
  // and the last tab lost exactly those 56px off its right edge, taking the
  // close button with it. Not merely hidden — the button's centre sat past the
  // strip, so `elementFromPoint` there returned the toolbar's terminal button
  // and the tab could not be closed at all. Window resizes, sidebar drags and
  // the toolbar's own conditional buttons narrow the region the same way.
  const realignActiveTab = useCallback(() => {
    // Once the user has driven the strip with a chevron, where it sits is what
    // they asked for, and the active tab being half off the edge is an
    // ordinary consequence of scrolling a row. Only reinstate the invariant
    // when the position is still ours to choose. Width alone cannot stand in
    // for this: a chevron retires when its end is reached and rejoins when it
    // is left, so a plain user scroll narrows the strip mid-flight and looks
    // exactly like the layout event this guards against — measured, the view
    // snapped straight back and the left end became unreachable.
    if (userScrolledRef.current) return

    const el = scrollRef.current
    if (!el) return
    const currentActiveTabId = useTabStore.getState().activeTabId
    if (!currentActiveTabId) return
    const activeTabEl = tabRefs.current.get(currentActiveTabId)
    if (!activeTabEl) return

    const strip = el.getBoundingClientRect()
    const tab = activeTabEl.getBoundingClientRect()

    // Already whole. The tolerance is for subpixel layout, which would
    // otherwise report a clip on every resize and scroll forever.
    if (
      tab.left >= strip.left - TAB_VISIBILITY_TOLERANCE &&
      tab.right <= strip.right + TAB_VISIBILITY_TOLERANCE
    ) return

    activeTabEl.scrollIntoView(REVEAL_ACTIVE_TAB)
  }, [])

  useEffect(() => {
    updateScrollState()
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', updateScrollState)
    const ro = new ResizeObserver(() => {
      updateScrollState()
      realignActiveTab()
    })
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', updateScrollState)
      ro.disconnect()
    }
  }, [realignActiveTab, updateScrollState, tabs.length])

  useEffect(() => {
    if (!activeTabId) return
    const activeTabEl = tabRefs.current.get(activeTabId)
    if (!activeTabEl) return

    // Switching tabs hands the position back to the strip: wherever the user
    // had scrolled to, they have now named a tab they want to see.
    userScrolledRef.current = false
    // Unconditional, unlike the resize path: a tab that has just been activated
    // has to come on screen even from completely outside the strip.
    activeTabEl.scrollIntoView(REVEAL_ACTIVE_TAB)

    const frame = window.requestAnimationFrame(updateScrollState)
    return () => window.cancelAnimationFrame(frame)
  }, [activeTabId, tabs.length, updateScrollState])

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  // Every item in the menu clears `contextMenu` itself, so excluding the menu
  // from "outside" keeps the previous behavior while dropping the hand-rolled
  // document listener.
  useDismissable({
    open: contextMenu !== null,
    refs: [contextMenuRef],
    onDismiss: closeContextMenu,
  })

  const scroll = (direction: 'left' | 'right') => {
    const el = scrollRef.current
    if (!el) return
    const step = el.clientWidth * SCROLL_STEP_RATIO
    // The chevrons are the only way to drive the strip by hand — it is
    // `overflow-x-hidden`, so wheel and trackpad do not reach it — which makes
    // this the one place that has to hand the position over to the user.
    userScrolledRef.current = true
    el.scrollBy({ left: direction === 'left' ? -step : step, behavior: 'smooth' })
  }

  const closeTabWithCleanup = useCallback((tab: Tab) => {
    if (isSessionTab(tab)) {
      useWorkspacePanelStore.getState().clearSession(tab.sessionId)
      useTerminalPanelStore.getState().clearSession(tab.sessionId)
      useActivityPanelStore.getState().close(tab.sessionId)
    }
    closeTab(tab.sessionId)
  }, [closeTab])

  const getRunningSessionIds = useCallback((targetTabs: Tab[]) => {
    const chatSessions = useChatStore.getState().sessions
    return targetTabs
      .filter((tab) => isSessionTab(tab))
      .filter((tab) => {
        const sessionState = chatSessions[tab.sessionId]
        return !!sessionState &&
          (sessionState.chatState !== 'idle' || hasRunningBackgroundTasks(sessionState.backgroundAgentTasks))
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
          // Auto-delete empty sessions (placeholder title, no messages sent)
          const sessionEntry = useSessionStore.getState().sessions.find((s) => s.id === tab.sessionId)
          const chatEntry = useChatStore.getState().sessions[tab.sessionId]
          if (isPlaceholderSessionTitle(sessionEntry?.title) && (!chatEntry || chatEntry.messages.length === 0)) {
            void useSessionStore.getState().deleteSession(tab.sessionId)
          }
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
      /*
        The strip is frame, not paper: it sits on the sidebar's ground so the
        active tab can be filled with `--color-surface` and read as a sheet
        lifted off the desk, continuous with the content below it. Painting the
        strip `--color-surface` instead collapses strip, active tab and content
        into one flat plane, which is what #1123 reported as "粗犷".

        Deliberately *not* darkened into a Chrome-style trough: keeping it on
        the sidebar's exact ground is what stops the titlebar reading as a
        separate band across the top of the window. The cost is that the
        selected tab's fill is only 1.05–1.10:1 against it, so the shape has to
        be carried by `--color-tab-edge` on the tab itself (see TabItem).

        No `border-b`: the selected tab's bottom edge has to run straight into
        the content below it, and a rule across the whole strip cuts through it.
      */
      className="flex min-h-[52px] items-stretch bg-[var(--color-surface-sidebar)] select-none"
    >

      {canScrollLeft && (
        <button type="button" onClick={() => scroll('left')} aria-label={t('tabs.scrollLeft')} className="flex h-[52px] w-7 flex-shrink-0 items-center justify-center text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]">
          <span className="material-symbols-outlined text-[16px]">chevron_left</span>
        </button>
      )}

      <div
        ref={scrollRef}
        data-testid="tab-bar-scroll-region"
        data-desktop-drag-region={isDesktopRuntime ? true : undefined}
        /*
          `pt-[6px]` is the shoulder: 52px strip minus 6px leaves the 46px tab,
          and those 6px are what makes the rounded top read as rounded rather
          than as a corner clipped by the window frame. The strip, not the tab,
          owns the giveback, so it stays inside the window drag region.
        */
        className="flex-1 flex items-stretch gap-[2px] overflow-x-hidden pt-[6px]"
        onDragOver={(e) => e.preventDefault()}
      >
        {tabs.map((tab, index) => {
          const displayTitle = tab.type === 'settings'
            ? t('settings.title')
            : (tab.title || t('tabs.untitled'))
          return (
            <TabItem
              key={tab.sessionId}
              ref={(node) => { tabRefs.current.set(tab.sessionId, node) }}
              tab={tab}
              displayTitle={displayTitle}
              closeLabel={t('tabs.closeTab', { title: displayTitle })}
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
          )
        })}
      </div>

      {/*
        Same hairline as the one between two idle tabs, drawn the same way: a
        16px rule rather than a full-height `border-l`, because a 52px line
        standing next to a row of 16px ones reads as a different kind of
        divider. `--color-border` is not an option for either — calibrated
        against paper, it all but disappears on the trough (1.12:1 on 素白),
        which left the toolbar looking welded to the last tab.
      */}
      <div className="relative flex shrink-0 items-center gap-1 px-2 before:absolute before:left-0 before:top-1/2 before:h-4 before:w-px before:-translate-y-1/2 before:bg-[var(--color-tab-separator)]">
        {showActivityButton && activeTabId && (
          <SessionActivityButton sessionId={activeTabId} />
        )}
        {isDesktopRuntime && isActiveSessionTab && (
          <OpenProjectMenu path={openProjectPath} />
        )}
        <IconButton
          icon={<SquareTerminal size={17} strokeWidth={1.9} />}
          label={t('tabs.openTerminal')}
          onClick={() => {
            if (activeTabId && isActiveSessionTab) {
              useTerminalPanelStore.getState().togglePanel(activeTabId)
              return
            }
            useTabStore.getState().openTerminalTab()
          }}
          size="md"
          tone={isTerminalPanelOpen ? 'default' : 'muted'}
          pressed={isTerminalPanelOpen}
          data-active={isTerminalPanelOpen ? 'true' : 'false'}
        />
        {isActiveSessionTab && activeTabId && (
          <IconButton
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
            size="md"
            tone={isWorkspacePanelOpen ? 'default' : 'muted'}
            pressed={isWorkspacePanelOpen}
            data-active={isWorkspacePanelOpen ? 'true' : 'false'}
          />
        )}
      </div>

      {isDesktopRuntime && (
        <div
          data-testid="tab-bar-drag-gutter"
          data-desktop-drag-region
          aria-hidden="true"
          className={`min-h-[52px] flex-shrink-0 ${showWindowControls ? 'w-3' : 'w-4'}`}
        />
      )}

      {canScrollRight && (
        <button type="button" onClick={() => scroll('right')} aria-label={t('tabs.scrollRight')} className="flex h-[52px] w-7 flex-shrink-0 items-center justify-center text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]">
          <span className="material-symbols-outlined text-[16px]">chevron_right</span>
        </button>
      )}

      <WindowControls />

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-[var(--z-dropdown)] min-w-[180px] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-2 shadow-[var(--shadow-dropdown)]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => { handleClose(contextMenu.sessionId); setContextMenu(null) }}
            className="w-full px-4 py-2 text-left text-[13px] text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.close')}
          </button>
          <button
            onClick={() => handleCloseOthers(contextMenu.sessionId)}
            className="w-full px-4 py-2 text-left text-[13px] text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeOthers')}
          </button>
          <button
            onClick={() => handleCloseLeft(contextMenu.sessionId)}
            className="w-full px-4 py-2 text-left text-[13px] text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeLeft')}
          </button>
          <button
            onClick={() => handleCloseRight(contextMenu.sessionId)}
            className="w-full px-4 py-2 text-left text-[13px] text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeRight')}
          </button>
          <div className="my-1.5 border-t border-[var(--color-border)]" />
          <button
            onClick={handleCloseAll}
            className="w-full px-4 py-2 text-left text-[13px] text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
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
  displayTitle: string
  closeLabel: string
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
}>(({ tab, displayTitle, closeLabel, isRunning, isActive, isDragOver, isDragging, dragOffsetX, runningLabel, onClick, onClose, onContextMenu, onMouseDown }, ref) => {
  // Chat tabs carry no glyph at all; the dot only appears when there is
  // something to say. Everything else identifies its section with one.
  const leadingGlyph = isSessionTab(tab)
    ? (isRunning
      ? <StatusDot tone="brand" pulse label={runningLabel} />
      : tab.status === 'error'
        ? <StatusDot tone="danger" />
        : null)
    : (
      <span className="material-symbols-outlined text-[14px] leading-none text-[var(--color-text-tertiary)]">
        {TAB_TYPE_ICON[tab.type] ?? TAB_TYPE_ICON_FALLBACK}
      </span>
    )

  return (
    <div
      ref={ref}
      data-dragging={isDragging ? 'true' : 'false'}
      data-active={isActive ? 'true' : 'false'}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      className={`
        tab-bar-interactive tab-strip-item group relative flex min-h-[46px] min-w-[140px] max-w-[200px] flex-shrink-0 items-center rounded-t-[8px] border border-b-0 px-3
        ${isDragging ? 'z-[var(--z-sticky)] cursor-grabbing' : 'cursor-grab'}
        transition-[background-color,border-color,box-shadow,opacity,transform] duration-150 ease-out
        ${isActive || isDragging
          // A document tab, still not a pill: the bottom edge stays square and
          // borderless so paper runs unbroken from the tab into the view below.
          // What a pill would add — a full radius, a drop shadow, and clearance
          // from the content — stays banned; only the top two corners round.
          //
          // The border is load-bearing, not decoration. The strip is the
          // sidebar's own ground, which puts this fill at 1.05–1.10:1 against
          // it in all six themes: without an outline the corners are invisible
          // and there is nothing to see. `--color-border` cannot stand in — it
          // is calibrated against paper and lands at 1.12:1 on the trough.
          ? 'border-[var(--color-tab-edge)] bg-[var(--color-surface)]'
          // Hover rises toward paper, it does not fall away from it. The
          // obvious `--color-surface-hover` is wrong here: it is tuned for
          // hovering *on* paper, so on the two ink themes it lands brighter
          // than paper itself (dark #2B271F vs #201D17) and a hovered tab
          // outshines the selected one. Sharing paper with the active tab and
          // letting the outline plus the label weight carry selection makes
          // the active state strictly stronger in all six themes.
          //
          // It gets the weaker of the two outlines rather than none: the same
          // 1.05–1.10:1 that hides the selected tab's corners hides a hovered
          // tab's too, so without it hover is a fill with no discernible
          // shape. Three legible tiers — no outline, hairline, full edge.
          : 'border-transparent bg-transparent hover:border-[var(--color-tab-separator)] hover:bg-[var(--color-surface)]'
        }
        ${isDragging ? 'opacity-95 shadow-[var(--shadow-overlay)]' : ''}
        ${isDragOver ? 'before:absolute before:left-0 before:top-[4px] before:bottom-[4px] before:w-[3px] before:bg-[var(--color-brand)] before:rounded-full' : ''}
      `}
      style={{
        transform: isDragging ? `translateX(${dragOffsetX}px) scale(1.02)` : undefined,
      }}
    >
      {/*
        One slot, not a run of conditional siblings, and it animates its own
        width rather than appearing. The status dot used to be *inserted* ahead
        of the label, so a session shoved its own title sideways the moment it
        started running and pulled it back when it finished. Now that idle chat
        tabs have no glyph the slot has to collapse, so the jump is spread over
        150ms instead. That is also why the gap is per-child margin: flex `gap`
        is charged between children whatever their width, so a zero-width slot
        would still cost 6px.
      */}
      <span
        className={`flex h-[14px] flex-shrink-0 items-center justify-center overflow-hidden transition-[width,margin-right] duration-150 ease-out ${leadingGlyph ? 'mr-1.5 w-[14px]' : 'mr-0 w-0'}`}
      >
        {leadingGlyph}
      </span>

      <span className={`min-w-0 flex-1 truncate text-xs ${isActive ? 'text-[var(--color-text-primary)] font-medium' : 'text-[var(--color-text-secondary)]'}`}>
        {displayTitle}
      </span>

      {/*
        The fade lives on the wrapper, not on the button: `IconButton` pins
        `transition-colors`, which does not cover opacity, and a competing
        `transition-[…]` in `className` would resolve by stylesheet order.
      */}
      <span className="-mr-1 ml-1.5 flex-shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
        <IconButton
          icon="close"
          label={closeLabel}
          onMouseDown={(e) => { e.stopPropagation() }}
          onClick={(e) => { e.stopPropagation(); onClose() }}
          size="xs"
          tone="muted"
          showTooltip={false}
        />
      </span>
    </div>
  )
})
TabItem.displayName = 'TabItem'
