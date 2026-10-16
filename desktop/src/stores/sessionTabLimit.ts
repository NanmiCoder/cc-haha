import { useChatStore } from './chatStore'
import { hasForegroundWork, isCliStillWorking } from './hiddenSessionRelease'
import { closeTabsWithPolicy, getRunningSessionIds, isSessionTab } from './tabClose'
import { useTabBehaviorStore } from './tabBehaviorStore'
import { getTabLastViewed, useTabStore, type Tab } from './tabStore'
import { useTeamStore } from './teamStore'

/**
 * A chat tab the limit must not take away: the person is in the middle of
 * something there, or another open tab is a view into it.
 */
export function isProtectedSessionTab(tab: Tab, tabs: Tab[]): boolean {
  const sessionId = tab.sessionId
  const session = useChatStore.getState().sessions[sessionId]
  if (session) {
    const draft = session.composerDraft
    if (
      hasForegroundWork(session) ||
      isCliStillWorking(session) ||
      getRunningSessionIds([tab]).length > 0 ||
      (draft && (draft.input.trim() !== '' || draft.attachments.length > 0 || (draft.mentions?.length ?? 0) > 0))
    ) return true
  }
  if (useTeamStore.getState().teamNameBySession[sessionId]) return true
  return tabs.some((other) => other !== tab && (
    other.sourceSessionId === sessionId ||
    other.teamLeadSessionId === sessionId ||
    other.workbenchSessionId === sessionId
  ))
}

/**
 * Keeps at most the chosen number of chat tabs open by closing the ones looked
 * at least recently. It only acts when a chat tab is added or the limit is
 * changed, so a tab never disappears while the person is not doing anything.
 * Protected tabs may push the count over the limit for a while.
 */
export function installSessionTabLimit(): () => void {
  let installed = true
  let scheduled = false

  const enforce = () => {
    const limit = useTabBehaviorStore.getState().behavior.sessionTabLimit
    if (limit === null) return
    const { tabs, activeTabId } = useTabStore.getState()
    const sessionTabs = tabs.filter((tab) => isSessionTab(tab))
    const excess = sessionTabs.length - limit
    if (excess <= 0) return
    // Tabs not looked at in this run (restored ones) go first, leftmost first.
    const evicted = sessionTabs
      .map((tab, index) => ({ tab, index, seen: getTabLastViewed(tab.sessionId) }))
      .filter(({ tab }) => tab.sessionId !== activeTabId && !isProtectedSessionTab(tab, tabs))
      .sort((a, b) => a.seen - b.seen || a.index - b.index)
      .slice(0, excess)
      .map(({ tab }) => tab)
    if (evicted.length > 0) closeTabsWithPolicy(evicted, [], false)
  }

  const schedule = () => {
    if (scheduled) return
    scheduled = true
    // Decide after the update that triggered it has settled.
    queueMicrotask(() => {
      scheduled = false
      if (installed) enforce()
    })
  }

  const unsubscribeTabs = useTabStore.subscribe((state, previous) => {
    if (state.tabs === previous.tabs) return
    const previousIds = new Set(previous.tabs.map((tab) => tab.sessionId))
    if (state.tabs.some((tab) => isSessionTab(tab) && !previousIds.has(tab.sessionId))) schedule()
  })
  const unsubscribeBehavior = useTabBehaviorStore.subscribe((state, previous) => {
    if (state.behavior.sessionTabLimit !== previous.behavior.sessionTabLimit) schedule()
  })
  schedule()

  return () => {
    installed = false
    unsubscribeTabs()
    unsubscribeBehavior()
  }
}
