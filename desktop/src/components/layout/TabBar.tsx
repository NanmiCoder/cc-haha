import { forwardRef, useMemo, useRef, useState, useEffect, useLayoutEffect, useCallback, useId } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  SCHEDULED_TAB_ID,
  SETTINGS_TAB_ID,
  MARKET_TAB_ID,
  CONNECTORS_TAB_ID,
  SUBAGENT_TAB_PREFIX,
  TEAM_MEMBER_TAB_PREFIX,
  TEAM_TAB_PREFIX,
  TERMINAL_TAB_PREFIX,
  WORKBENCH_TAB_PREFIX,
  useTabStore,
  type Tab,
  type TabType,
} from '../../stores/tabStore'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import type { UIMessage } from '../../types/chat'
import { isPlaceholderSessionTitle } from '../../lib/sessionTitle'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { releaseWorkspaceSession } from '../../lib/workspace/releaseSession'
import { useCLITaskStore } from '../../stores/cliTaskStore'
import { teamTaskWindowsForSnapshot, useTeamStore } from '../../stores/teamStore'
import { StatusDot } from '@/components/ui/Badge'
import { IconButton } from '@/components/ui/IconButton'
import { tabChipClass, tabChipLabelClass } from '@/components/ui/tabChip'
import { useDismissable } from '@/hooks/useDismissable'
import { useTranslation } from '../../i18n'
import { getDesktopHost } from '../../lib/desktopHost'
import { hasRunningBackgroundTasks, listRunningBackgroundTasks } from '../../lib/backgroundTasks'
import { collectAttentionIds, nextAttentionSessionId } from '../../lib/sessionAttention'
import { SessionAttentionMark } from './SessionAttentionMark'
import { TabAttentionJump } from './TabAttentionJump'
import { WindowControls, showWindowControls } from './WindowControls'
import { OpenProjectMenu } from './OpenProjectMenu'
import { AppWindow, Bot, CalendarClock, ChevronLeft, ChevronRight, Link, Network, PanelRight, Settings, SquareTerminal, Store, X, type LucideIcon } from 'lucide-react'
import { WorkspaceLayoutControls } from './WorkspaceLayoutControls'
import { useWorkspaceHeaderHost } from './WorkspaceHeaderContext'
import { ActionDialog } from '@/components/ui/ActionDialog'
import { getMainSessionActivityModel, hasVisibleSessionActivity } from '../activity/sessionActivityModel'
import { SessionActivityButton } from '../activity/SessionActivityButton'
import { useActivityPanelStore } from '../../stores/activityPanelStore'
import { getSessionBrowsablePath } from '../../lib/sessionWorkspace'
import { runsForSession, useWorkflowStore } from '../../stores/workflowStore'

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

type ClippedSide = 'left' | 'right'

/**
 * Which edge of the strip a tab is cut off by, or null when it is whole. This
 * is the one definition of "whole": re-revealing the active tab and hinting at
 * waiting tabs the strip has scrolled away both ask it, so the two cannot
 * disagree about what is out of view. A tab that is only partly clipped counts —
 * its glyph sits at the left edge, and a hint that sometimes stays quiet for a
 * tab the person cannot fully see is worse than one that speaks a little early.
 */
function clippedSide(
  strip: Pick<DOMRect, 'left' | 'right'>,
  tab: Pick<DOMRect, 'left' | 'right'>,
): ClippedSide | null {
  if (tab.left < strip.left - TAB_VISIBILITY_TOLERANCE) return 'left'
  if (tab.right > strip.right + TAB_VISIBILITY_TOLERANCE) return 'right'
  return null
}

// One glyph per *non-chat* tab kind: the glyph says "this tab is not a
// conversation". Chat tabs deliberately have none — a bubble on every tab in a
// strip that is mostly chats is pure noise, and the slot it occupied is worth
// more as title.
//
// The sidebar draws the same sections with the same glyphs (settings,
// scheduled, market), so a tab and the nav item that opened it read as one.
const TAB_TYPE_ICON: Partial<Record<TabType, LucideIcon>> = {
  settings: Settings,
  scheduled: CalendarClock,
  market: Store,
  connectors: Link,
  terminal: SquareTerminal,
  workbench: PanelRight,
  subagent: Bot,
  team: Network,
  'team-member': Bot,
}
const TAB_TYPE_ICON_FALLBACK: LucideIcon = AppWindow
const desktopHost = getDesktopHost()
const isDesktopRuntime = desktopHost.isDesktop
const EMPTY_DISMISSED_BACKGROUND_TASK_KEYS: readonly string[] = []
const EMPTY_ACTIVITY_MESSAGES: UIMessage[] = []

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
    tabId !== CONNECTORS_TAB_ID &&
    !tabId.startsWith(TERMINAL_TAB_PREFIX) &&
    !tabId.startsWith(WORKBENCH_TAB_PREFIX) &&
    !tabId.startsWith(SUBAGENT_TAB_PREFIX) &&
    !tabId.startsWith(TEAM_TAB_PREFIX) &&
    !tabId.startsWith(TEAM_MEMBER_TAB_PREFIX)
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
  // Tabs that are stopped on a decision only the user can make. Read from the
  // outstanding requests rather than from `chatState` (see
  // `sessionNeedsAttention`), and `useShallow` for the same reason as above: a
  // fresh array from every store update would loop the subscription.
  const attentionList = useChatStore(useShallow((s) => collectAttentionIds(s.sessions, sessionTabIds)))
  const attentionSet = useMemo(() => new Set(attentionList), [attentionList])
  // The waiting tabs other than the one on screen: the places a jump can take
  // you, and so the number on the button that offers it.
  const otherAttentionCount = attentionList.filter((sessionId) => sessionId !== activeTabId).length
  const disconnectSession = useChatStore((s) => s.disconnectSession)
  const activeTab = tabs.find((tab) => tab.sessionId === activeTabId) ?? null
  const isActiveSessionTab = isSessionTab(activeTab) || isSessionTabId(activeTabId)
  const activeSession = useSessionStore((state) =>
    activeTabId ? state.sessions.find((session) => session.id === activeTabId) : undefined,
  )
  const openProjectPath = isActiveSessionTab
    ? getSessionBrowsablePath(activeSession) ?? null
    : null
  const workspaceLayout = useWorkspaceStore((state) =>
    activeTabId && isActiveSessionTab ? state.bySession[activeTabId]?.layout ?? 'hidden' : 'hidden',
  )
  const isWorkbenchOpen = workspaceLayout !== 'hidden'
  const workspaceHeader = useWorkspaceHeaderHost(isActiveSessionTab ? activeTabId : null)
  const hasWorkspaceHeader = workspaceHeader.available && isWorkbenchOpen
  const isTerminalPanelOpen = useWorkspaceStore((state) =>
    activeTabId && isActiveSessionTab ? state.bySession[activeTabId]?.bottomOpen ?? false : false,
  )
  const cliTasks = useCLITaskStore((state) => state.tasks)
  const cliTasksSessionId = useCLITaskStore((state) => state.sessionId)
  const cliTasksCompletedAndDismissed = useCLITaskStore((state) => state.completedAndDismissed)
  const agentTeamsSnapshot = useTeamStore((state) => activeTabId
    ? state.workbenchesBySession[activeTabId]?.snapshots.at(-1)
    : undefined)
  const activeTeamStartedAt = useTeamStore((state) => activeTabId
    ? state.activeTeamStartedAtBySession[activeTabId]
    : undefined)
  const allWorkflowRuns = useWorkflowStore((state) => state.runs)
  const workflowRuns = useMemo(
    () => activeTabId && isActiveSessionTab
      ? runsForSession({ runs: allWorkflowRuns }, activeTabId)
      : [],
    [activeTabId, allWorkflowRuns, isActiveSessionTab],
  )
  const dismissedBackgroundTaskKeyList = useActivityPanelStore((state) =>
    activeTabId
      ? state.dismissedBackgroundTaskKeysBySession[activeTabId] ?? EMPTY_DISMISSED_BACKGROUND_TASK_KEYS
      : EMPTY_DISMISSED_BACKGROUND_TASK_KEYS,
  )
  const dismissedBackgroundTaskKeys = useMemo(
    () => new Set(dismissedBackgroundTaskKeyList),
    [dismissedBackgroundTaskKeyList],
  )
  // Select the on-screen session's inputs, not the model: a selector runs on
  // every store update of every session, and the model walks the whole
  // transcript. Deriving it inside one cost a full pass per streamed token of
  // any background session (#1480).
  const activitySessionId = activeTabId && isActiveSessionTab ? activeTabId : null
  const activityMessages = useChatStore((state) =>
    activitySessionId ? state.sessions[activitySessionId]?.messages ?? EMPTY_ACTIVITY_MESSAGES : EMPTY_ACTIVITY_MESSAGES)
  const activityTurnActive = useChatStore((state) => {
    const sessionState = activitySessionId ? state.sessions[activitySessionId] : undefined
    return Boolean(sessionState && sessionState.chatState !== 'idle')
  })
  const activityBackgroundTaskRecord = useChatStore((state) =>
    activitySessionId ? state.sessions[activitySessionId]?.backgroundAgentTasks : undefined)
  const activityNotificationRecord = useChatStore((state) =>
    activitySessionId ? state.sessions[activitySessionId]?.agentTaskNotifications : undefined)
  const hasVisibleActivity = useMemo(() => {
    if (!activitySessionId) return false
    const includeCliTasks = cliTasksSessionId === activitySessionId
    return hasVisibleSessionActivity(getMainSessionActivityModel({
      sessionId: activitySessionId,
      messages: activityMessages,
      tasks: includeCliTasks ? cliTasks : [],
      teamTaskWindows: teamTaskWindowsForSnapshot(agentTeamsSnapshot, activeTeamStartedAt),
      completedAndDismissed: includeCliTasks ? cliTasksCompletedAndDismissed : false,
      isForegroundTurnActive: activityTurnActive,
      backgroundTasks: Object.values(activityBackgroundTaskRecord ?? {}),
      dismissedBackgroundTaskKeys,
      agentNotifications: Object.values(activityNotificationRecord ?? {}),
      workflowRuns,
    }))
  }, [
    activeTeamStartedAt,
    activityBackgroundTaskRecord,
    activityMessages,
    activityNotificationRecord,
    activitySessionId,
    activityTurnActive,
    agentTeamsSnapshot,
    cliTasks,
    cliTasksCompletedAndDismissed,
    cliTasksSessionId,
    dismissedBackgroundTaskKeys,
    workflowRuns,
  ])
  const showActivityButton = activeTabId &&
    hasVisibleActivity &&
    !isWorkbenchOpen

  const moveTab = useTabStore((s) => s.moveTab)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Set the moment the user drives the strip themselves, cleared when they
  // switch tabs. See `realignActiveTab`.
  const userScrolledRef = useRef(false)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  // Whether a waiting tab is scrolled out of view on each side. The mark on the
  // tab itself is no use to someone who cannot see the tab, and "tab 多了" is
  // exactly when that happens.
  const [attentionOffscreen, setAttentionOffscreen] = useState({ left: false, right: false })
  // `updateScrollState` is a stable callback with no dependencies, so it reads
  // the waiting tabs through a ref that the layout effect below keeps current.
  const attentionListRef = useRef<readonly string[]>([])
  const attentionHintId = useId()
  const [tabHitWidth, setTabHitWidth] = useState(0)
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null)
  const [pendingCloseRequest, setPendingCloseRequest] = useState<PendingCloseRequest | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null)
  const [dragOffsetX, setDragOffsetX] = useState(0)
  const dragIndexRef = useRef<number | null>(null)
  const dragOverIndexRef = useRef<number | null>(null)
  const dragTabCentersRef = useRef<number[]>([])
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
    // scrollWidth is at least clientWidth even with only one tab. Measure
    // layout offsets (not transformed drag previews) to preserve empty chrome.
    const first = el.firstElementChild as HTMLElement | null
    const last = el.lastElementChild as HTMLElement | null
    const contentWidth = first && last ? last.offsetLeft + last.offsetWidth - first.offsetLeft : 0
    setTabHitWidth(Math.max(0, Math.min(el.clientWidth, contentWidth - el.scrollLeft)))

    // Only the waiting tabs are measured, so a scroll costs a few rect reads
    // rather than one per tab. State is left alone when nothing changed: this
    // runs on every scroll event, and a fresh object each time would rerender
    // the strip for nothing.
    const strip = el.getBoundingClientRect()
    let left = false
    let right = false
    for (const sessionId of attentionListRef.current) {
      const tabEl = tabRefs.current.get(sessionId)
      if (!tabEl) continue
      const side = clippedSide(strip, tabEl.getBoundingClientRect())
      if (side === 'left') left = true
      else if (side === 'right') right = true
    }
    setAttentionOffscreen((prev) => (prev.left === left && prev.right === right ? prev : { left, right }))
  }, [])

  // A request can arrive, or be answered, with the strip standing still — no
  // scroll, no resize — so nothing in the observer path would notice. Measuring
  // in a layout effect keeps the chevron from showing the previous answer for
  // a frame, and the tabs are in the DOM by then, so their rects are current.
  useLayoutEffect(() => {
    attentionListRef.current = attentionList
    updateScrollState()
  }, [attentionList, tabs, updateScrollState])

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
    if (!clippedSide(strip, tab)) return

    activeTabEl.scrollIntoView(REVEAL_ACTIVE_TAB)
  }, [])

  useEffect(() => {
    const syncStripLayout = () => {
      updateScrollState()
    }

    syncStripLayout()
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', syncStripLayout)
    const ro = new ResizeObserver(() => {
      syncStripLayout()
      realignActiveTab()
    })
    ro.observe(el)
    for (const tab of Array.from(el.children)) ro.observe(tab)
    return () => {
      el.removeEventListener('scroll', syncStripLayout)
      ro.disconnect()
    }
  }, [realignActiveTab, updateScrollState, tabs])

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

    const frame = window.requestAnimationFrame(() => {
      updateScrollState()
    })
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
      releaseWorkspaceSession(tab.sessionId)
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
          const chat = useChatStore.getState()
          const runningTasks = listRunningBackgroundTasks(chat.sessions[tab.sessionId]?.backgroundAgentTasks)
          chat.stopGeneration(tab.sessionId)
          // The dialog counts background tasks as the session running, but
          // stopGeneration only reaches the foreground turn and Agent tasks (and
          // marks the latter as stopping, which stopBackgroundTask skips). A shell
          // command would outlive "Stop & Close" and keep the reopened session
          // running. Both must go out before disconnectSession closes the socket.
          for (const task of runningTasks) {
            chat.stopBackgroundTask(tab.sessionId, task.taskId)
          }
        }
        if (!isRunning || stopRunning) {
          // Auto-delete only when both server metadata and the loaded transcript
          // confirm this is an empty placeholder. Missing state can mean a timed-out
          // recovery load, so treating it as empty risks deleting a real session.
          const sessionEntry = useSessionStore.getState().sessions.find((s) => s.id === tab.sessionId)
          const chatEntry = useChatStore.getState().sessions[tab.sessionId]
          if (
            sessionEntry?.messageCount === 0 &&
            isPlaceholderSessionTitle(sessionEntry.title) &&
            chatEntry?.historyStatus === 'ready' &&
            chatEntry.messages.length === 0
          ) {
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
    for (let index = 0; index < dragTabCentersRef.current.length; index++) {
      const center = dragTabCentersRef.current[index]
      if (center !== undefined && Number.isFinite(center) && clientX < center) return index
    }

    return tabs.length > 0 ? tabs.length - 1 : null
  }, [tabs])

  const updateDragOverIndex = useCallback((index: number | null) => {
    dragOverIndexRef.current = index
    setDragOverIndex(index)
  }, [])

  const finalizeDrag = useCallback((targetIndex: number | null) => {
    if (dragIndexRef.current !== null && targetIndex !== null && dragIndexRef.current !== targetIndex) {
      moveTab(dragIndexRef.current, targetIndex)
    }
    dragIndexRef.current = null
    dragOverIndexRef.current = null
    dragTabCentersRef.current = []
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
      updateDragOverIndex(null)
      return
    }

    updateDragOverIndex(targetIndex)
  }, [getTargetIndexFromClientX, updateDragOverIndex])

  const handlePointerUp = useCallback(() => {
    finalizeDrag(dragOverIndexRef.current)
  }, [finalizeDrag])

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
    // Arm the suppression fresh for this gesture. handleTabClick is the only reader,
    // and it is only reachable from a tab's own onClick — so a drag that releases
    // away from any tab (below the strip, or outside the window) leaves the flag set
    // with nothing to consume it, and the user's next tab click gets swallowed.
    // Clearing here rather than in finalizeDrag is deliberate: `click` fires after
    // `mouseup`, so clearing at the end of the drag would defeat the suppression it
    // exists for.
    suppressClickRef.current = false
    // Freeze hit targets before the preview starts transforming. Reading the live
    // rect of the dragged tab makes its midpoint follow the pointer and target itself.
    dragTabCentersRef.current = tabs.map((tab) => {
      const rect = tabRefs.current.get(tab.sessionId)?.getBoundingClientRect()
      return rect ? rect.left + rect.width / 2 : Number.NaN
    })
    pendingDragRef.current = { index, startX: event.clientX, startY: event.clientY }
  }

  const handleTabClick = (sessionId: string) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    setActiveTab(sessionId)
  }

  // Activation does the rest: the effect on `activeTabId` above scrolls the tab
  // into view and hands the strip's position back to it.
  const jumpToAttention = () => {
    const next = nextAttentionSessionId(sessionTabIds, attentionSet, activeTabId)
    if (next) setActiveTab(next)
  }

  // The chevron on the side a waiting tab has scrolled off gets a dot in its
  // corner. Static on purpose: the pulse belongs to the mark on the tab, and
  // several things pulsing out of phase across one strip read as noise. The
  // sr-only text is the description, not the name — `aria-label` keeps naming
  // the button by what it does.
  const attentionHint = (side: ClippedSide) => attentionOffscreen[side] ? (
    <>
      <StatusDot
        tone="warning"
        size="md"
        data-testid={`tab-strip-attention-${side}`}
        className="pointer-events-none absolute right-1 top-3"
      />
      <span id={`${attentionHintId}-${side}`} className="sr-only">{t('sidebar.sessionNeedsAttention')}</span>
    </>
  ) : null

  const rightScrollControl = canScrollRight && (
        <button type="button" onClick={() => scroll('right')} aria-label={t('tabs.scrollRight')} aria-describedby={attentionOffscreen.right ? `${attentionHintId}-right` : undefined} title={attentionOffscreen.right ? t('sidebar.sessionNeedsAttention') : undefined} className="relative flex h-[52px] w-7 flex-shrink-0 items-center justify-center text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-sidebar-item-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]">
          <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
          {attentionHint('right')}
        </button>
      )

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

      <div data-testid="workspace-session-header" className={hasWorkspaceHeader ? 'flex min-w-0 flex-1 overflow-hidden' : 'contents'}>
      {canScrollLeft && (
        <button type="button" onClick={() => scroll('left')} aria-label={t('tabs.scrollLeft')} aria-describedby={attentionOffscreen.left ? `${attentionHintId}-left` : undefined} title={attentionOffscreen.left ? t('sidebar.sessionNeedsAttention') : undefined} className="relative flex h-[52px] w-7 flex-shrink-0 items-center justify-center text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-sidebar-item-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]">
          <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
          {attentionHint('left')}
        </button>
      )}

      <div className="relative flex min-w-0 flex-1">
      <div
        ref={scrollRef}
        data-testid="tab-bar-scroll-region"
        data-desktop-drag-region={isDesktopRuntime ? true : undefined}
        /*
          The 28px chips sit centred in the 52px strip, as the workspace's
          resource tabs do. The space around them stays inside the scroll
          region, which carries the window drag region; the chips do not.
        */
        className="tab-strip-scroll flex flex-1 items-center gap-0.5 overflow-x-hidden px-1"
        onDragOver={(e) => e.preventDefault()}
      >
        {tabs.map((tab, index) => {
          const displayTitle = tab.type === 'settings'
            ? t('settings.title')
            : tab.type === 'market' || tab.type === 'connectors' ? t('sidebar.extensions') : (tab.title || t('tabs.untitled'))
          return (
            <TabItem
              key={tab.sessionId}
              ref={(node) => { tabRefs.current.set(tab.sessionId, node) }}
              tab={tab}
              displayTitle={displayTitle}
              closeLabel={t('tabs.closeTab', { title: displayTitle })}
              isRunning={runningSessionIds.has(tab.sessionId)}
              needsAttention={attentionSet.has(tab.sessionId)}
              isActive={tab.sessionId === activeTabId}
              isDragOver={dragOverIndex === index}
              isDragging={tab.sessionId === draggingSessionId}
              dragOffsetX={tab.sessionId === draggingSessionId ? dragOffsetX : 0}
              runningLabel={t('tabs.sessionRunning')}
              attentionLabel={t('sidebar.sessionNeedsAttention')}
              onClick={() => handleTabClick(tab.sessionId)}
              onClose={() => handleClose(tab.sessionId)}
              onContextMenu={(e) => handleContextMenu(e, tab.sessionId)}
              onMouseDown={(event) => handleTabMouseDown(event, index)}
            />
          )
        })}
      </div>
      {/* Electron does not clip app-region rectangles to overflow. Keep the
          no-drag rectangle outside scrolling/transformed content (#1370). */}
      {isDesktopRuntime && (
        <div
          data-testid="tab-bar-hit-region"
          aria-hidden="true"
          className="tab-strip-hit-region pointer-events-none absolute bottom-[12px] left-0 top-[12px]"
          style={{ width: tabHitWidth }}
        />
      )}
      </div>

      {hasWorkspaceHeader ? rightScrollControl : null}
      </div>

      {/*
        Same hairline as the one between two idle tabs, drawn the same way: a
        16px rule rather than a full-height `border-l`, because a 52px line
        standing next to a row of 16px ones reads as a different kind of
        divider. `--color-border` is not an option for either — calibrated
        against paper, it all but disappears on the trough (1.12:1 on 素白),
        which left the toolbar looking welded to the last tab.
      */}
      {/*
        The frame owns the ground, not the header inside it. The drag gutter —
        and, on Windows, the window controls — are the header's siblings in
        here, and they are transparent, so whichever element paints has to
        contain them. With the panel open the workspace's own tab strip sits in
        this frame, and in 「素」 that strip is a trough like the session tabs:
        the sidebar's ground, with the active resource tab as the paper sheet
        that runs into the panel below. One ground for everything above it.
      */}
      <div
        data-testid="workspace-header-frame"
        style={hasWorkspaceHeader ? { width: workspaceHeader.width, maxWidth: '100%' } : undefined}
        className={`flex min-w-0 shrink-0 items-stretch ${hasWorkspaceHeader ? 'bg-[var(--color-surface-sidebar)]' : ''}`}
      >
      <div
        data-testid="workspace-window-header"
        data-desktop-drag-region={hasWorkspaceHeader && isDesktopRuntime ? true : undefined}
        className={hasWorkspaceHeader
          ? 'flex min-w-0 flex-1 items-center gap-1 pr-2'
          : 'relative flex shrink-0 items-center gap-1 px-2 before:absolute before:left-0 before:top-1/2 before:h-4 before:w-px before:-translate-y-1/2 before:bg-[var(--color-tab-separator)]'}
      >
        {hasWorkspaceHeader ? (
          <div
            ref={workspaceHeader.ref}
            data-testid="workspace-header-slot"
            data-desktop-drag-region={isDesktopRuntime ? true : undefined}
            // The slot is titlebar chrome: empty space must drag the window.
            // `tab-bar-interactive` here would also mark every descendant as
            // no-drag, including the resource strip's leftover flex space.
            className="flex h-[52px] min-w-0 flex-1"
          />
        ) : null}
        {otherAttentionCount > 0 && (
          <TabAttentionJump
            count={otherAttentionCount}
            label={t('tabs.jumpToAttention', { count: otherAttentionCount })}
            onJump={jumpToAttention}
          />
        )}
        {showActivityButton && activeTabId && (
          <SessionActivityButton sessionId={activeTabId} />
        )}
        {isDesktopRuntime && isActiveSessionTab && !isWorkbenchOpen && (
          <OpenProjectMenu path={openProjectPath} />
        )}
        {isActiveSessionTab && activeTabId ? (
          <WorkspaceLayoutControls
            layout={workspaceLayout}
            bottomOpen={isTerminalPanelOpen}
            onToggleFullscreen={() => useWorkspaceStore.getState().toggleFullscreen(activeTabId)}
            onToggleBottom={() => useWorkspaceStore.getState().toggleBottomPanel(
              activeTabId,
              getSessionBrowsablePath(activeSession) ?? '',
            )}
            onToggleWorkspace={() => useWorkspaceStore.getState().toggleWorkspace(activeTabId)}
          />
        ) : (
          <IconButton
            icon={<SquareTerminal size={16} strokeWidth={1.75} aria-hidden="true" />}
            label={t('tabs.openTerminal')}
            onClick={() => useTabStore.getState().openTerminalTab()}
            size="sm"
            tone="muted"
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


      {!hasWorkspaceHeader ? rightScrollControl : null}
      <WindowControls />
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-[var(--z-dropdown)] min-w-[180px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-1 shadow-[var(--shadow-dropdown)]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => { handleClose(contextMenu.sessionId); setContextMenu(null) }}
            className="flex h-8 w-full items-center rounded-[var(--radius-sm)] px-2.5 text-left text-[13px] text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.close')}
          </button>
          <button
            onClick={() => handleCloseOthers(contextMenu.sessionId)}
            className="flex h-8 w-full items-center rounded-[var(--radius-sm)] px-2.5 text-left text-[13px] text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeOthers')}
          </button>
          <button
            onClick={() => handleCloseLeft(contextMenu.sessionId)}
            className="flex h-8 w-full items-center rounded-[var(--radius-sm)] px-2.5 text-left text-[13px] text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeLeft')}
          </button>
          <button
            onClick={() => handleCloseRight(contextMenu.sessionId)}
            className="flex h-8 w-full items-center rounded-[var(--radius-sm)] px-2.5 text-left text-[13px] text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeRight')}
          </button>
          <div className="mx-1 my-1 border-t border-[var(--color-border)]" />
          <button
            onClick={handleCloseAll}
            className="flex h-8 w-full items-center rounded-[var(--radius-sm)] px-2.5 text-left text-[13px] text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
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
  needsAttention: boolean
  isActive: boolean
  isDragOver: boolean
  isDragging: boolean
  dragOffsetX: number
  runningLabel: string
  attentionLabel: string
  onClick: () => void
  onClose: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onMouseDown: (event: React.MouseEvent) => void
}>(({ tab, displayTitle, closeLabel, isRunning, needsAttention, isActive, isDragOver, isDragging, dragOffsetX, runningLabel, attentionLabel, onClick, onClose, onContextMenu, onMouseDown }, ref) => {
  // Chat tabs carry no glyph at all; the dot only appears when there is
  // something to say. Everything else identifies its section with one.
  //
  // Waiting on the user outranks running. A session parked on a permission card
  // is also "running" by `chatState`, so before this the brand dot told the
  // person the one thing that was not true of it: that it was working and
  // could be left alone.
  const leadingGlyph = isSessionTab(tab)
    ? (needsAttention
      ? <SessionAttentionMark label={attentionLabel} />
      : isRunning
        // Running is `info` everywhere in the app; the brand never marks a state.
        ? <StatusDot tone="info" pulse label={runningLabel} />
        : tab.status === 'error'
          ? <StatusDot tone="danger" />
          : null)
    : <TabTypeIcon type={tab.type} />

  return (
    <div
      ref={ref}
      data-dragging={isDragging ? 'true' : 'false'}
      data-active={isActive ? 'true' : 'false'}
      data-attention={needsAttention ? 'true' : 'false'}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      // The same chip as the workspace's resource tabs (`ui/tabChip`): one tab
      // style for both strips. The tiers and why hover shares paper with the
      // active tab are documented there.
      className={`
        ${tabChipClass(isActive || isDragging)} tab-strip-item
        ${isDragging ? 'z-[var(--z-sticky)] cursor-grabbing opacity-95' : 'cursor-grab'}
        ${isDragOver ? 'before:absolute before:-left-[3px] before:top-[4px] before:bottom-[4px] before:w-[2px] before:bg-[var(--color-brand)] before:rounded-full' : ''}
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

      <span className={tabChipLabelClass(isActive)}>
        {displayTitle}
      </span>

      {/*
        The fade lives on the wrapper, not on the button: `IconButton` pins
        `transition-colors`, which does not cover opacity, and a competing
        `transition-[…]` in `className` would resolve by stylesheet order.
      */}
      {/* The active tab keeps its close button in sight, as Chrome does; the
          rest reveal it on hover so an idle row stays all title. */}
      <span className={`ml-1.5 flex-shrink-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100 ${isActive ? 'opacity-100' : 'opacity-0'}`}>
        <IconButton
          icon={<X size={12} strokeWidth={2} aria-hidden="true" />}
          label={closeLabel}
          onMouseDown={(e) => { e.stopPropagation() }}
          onClick={(e) => { e.stopPropagation(); onClose() }}
          size="2xs"
          tone="muted"
          showTooltip={false}
        />
      </span>
    </div>
  )
})
TabItem.displayName = 'TabItem'

function TabTypeIcon({ type }: { type: TabType }) {
  const Icon = TAB_TYPE_ICON[type] ?? TAB_TYPE_ICON_FALLBACK
  return (
    <Icon
      size={14}
      strokeWidth={1.75}
      aria-hidden="true"
      data-tab-type-icon={type}
      className="text-[var(--color-text-tertiary)]"
    />
  )
}
