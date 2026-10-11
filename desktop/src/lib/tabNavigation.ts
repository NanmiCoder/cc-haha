import { useActivityPanelStore } from '../stores/activityPanelStore'
import { TEAM_TAB_PREFIX, useTabStore, type Tab } from '../stores/tabStore'
import { openSessionSource } from './sessionNavigation'

const MAX_BACK_STEPS = 16

/**
 * Where Back goes from a subagent, team or member page: the page or chat it
 * was opened from. Null for every other tab.
 */
export function parentTabId(tab: Tab): string | null {
  switch (tab.type) {
    case 'subagent':
      return tab.returnTabId ?? tab.sourceSessionId ?? null
    case 'team':
      return tab.sourceSessionId ?? null
    case 'team-member':
      return tab.returnTabId ?? (tab.teamLeadSessionId ? `${TEAM_TAB_PREFIX}${tab.teamLeadSessionId}` : null)
    default:
      return null
  }
}

/**
 * One step back from a detail page. An activity panel open on the page moves
 * to where Back lands, so closing the run does not also close what the person
 * was reading beside it.
 */
export function returnFromDetailTab(tabId: string): void {
  const store = useTabStore.getState()
  const tab = store.tabs.find((candidate) => candidate.sessionId === tabId)
  if (!tab) return
  const activity = useActivityPanelStore.getState()
  if (tab.type === 'subagent') {
    const target = tab.returnTabId ?? tab.sourceSessionId
    if (target && activity.isOpen(tabId)) activity.open(target)
    store.returnFromSubagent(tabId)
  } else if (tab.type === 'team-member') {
    if (tab.teamLeadSessionId && activity.isOpen(tabId)) activity.open(tab.teamLeadSessionId)
    store.returnFromTeamMember(tabId)
  } else if (tab.type === 'team') {
    store.returnFromTeamWorkbench(tabId)
  }
}

/**
 * Go back until `targetId` is on screen — what a breadcrumb does. Each step is
 * an ordinary Back, so the pages in between close the same way they would one
 * at a time. If the trail no longer leads there (the page it went through was
 * closed), the target is shown directly.
 */
export function returnToTab(targetId: string): void {
  for (let step = 0; step < MAX_BACK_STEPS; step += 1) {
    const { activeTabId } = useTabStore.getState()
    if (!activeTabId || activeTabId === targetId) return
    returnFromDetailTab(activeTabId)
    if (useTabStore.getState().activeTabId === activeTabId) break
  }
  const store = useTabStore.getState()
  if (store.activeTabId === targetId) return
  if (store.tabs.some((tab) => tab.sessionId === targetId)) store.setActiveTab(targetId)
  else openSessionSource(targetId)
}
