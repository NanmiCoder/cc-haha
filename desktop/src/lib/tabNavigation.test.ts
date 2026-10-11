import { beforeEach, describe, expect, it } from 'vitest'
import { useActivityPanelStore } from '../stores/activityPanelStore'
import { TEAM_TAB_PREFIX, useTabStore } from '../stores/tabStore'
import { parentTabId, returnFromDetailTab, returnToTab } from './tabNavigation'

const ids = () => useTabStore.getState().tabs.map((tab) => tab.sessionId)

beforeEach(() => {
  useTabStore.setState({ tabs: [], activeTabId: null })
  useActivityPanelStore.setState(useActivityPanelStore.getInitialState(), true)
  localStorage.clear()
})

describe('parentTabId', () => {
  it('follows each page back to where it was opened from', () => {
    useTabStore.getState().openTab('root', 'Root')
    const run = useTabStore.getState().openSubagentTab('root', 'tool-1', 'Run')
    const nested = useTabStore.getState().openSubagentTab('root', 'tool-2', 'Nested', undefined, run)
    const team = useTabStore.getState().openTeamWorkbenchTab('root', 'Team')
    const member = useTabStore.getState().openTeamMemberTab('root', 'reviewer@team', 'Reviewer', team)
    const tab = (id: string) => useTabStore.getState().tabs.find((candidate) => candidate.sessionId === id)!

    expect(parentTabId(tab(run))).toBe('root')
    expect(parentTabId(tab(nested))).toBe(run)
    expect(parentTabId(tab(team))).toBe('root')
    expect(parentTabId(tab(member))).toBe(team)
    expect(parentTabId(tab('root'))).toBeNull()
  })

  it('sends a member with no recorded way back to its team workbench', () => {
    expect(parentTabId({
      sessionId: 'member', title: 'Member', type: 'team-member', status: 'idle', teamLeadSessionId: 'lead',
    })).toBe(`${TEAM_TAB_PREFIX}lead`)
  })
})

describe('returnFromDetailTab', () => {
  it('carries an open activity panel from a run back to its parent', () => {
    useTabStore.getState().openTab('root', 'Root')
    const run = useTabStore.getState().openSubagentTab('root', 'tool-1', 'Run')
    const nested = useTabStore.getState().openSubagentTab('root', 'tool-2', 'Nested', undefined, run)
    useActivityPanelStore.getState().open(nested)

    returnFromDetailTab(nested)

    expect(useTabStore.getState().activeTabId).toBe(run)
    expect(useActivityPanelStore.getState().openSessionId).toBe(run)
  })

  it('carries an open activity panel from a member back to its lead', () => {
    useTabStore.getState().openTab('lead', 'Lead')
    const team = useTabStore.getState().openTeamWorkbenchTab('lead', 'Team')
    const member = useTabStore.getState().openTeamMemberTab('lead', 'reviewer@team', 'Reviewer', team)
    useActivityPanelStore.getState().open(member)

    returnFromDetailTab(member)

    expect(useTabStore.getState().activeTabId).toBe(team)
    expect(useActivityPanelStore.getState().openSessionId).toBe('lead')
  })

  it('leaves the activity panel alone when it was not open on the page', () => {
    useTabStore.getState().openTab('root', 'Root')
    const run = useTabStore.getState().openSubagentTab('root', 'tool-1', 'Run')

    returnFromDetailTab(run)

    expect(useTabStore.getState().activeTabId).toBe('root')
    expect(useActivityPanelStore.getState().openSessionId).toBeNull()
  })
})

describe('returnToTab', () => {
  it('unwinds every page above the target, one Back at a time', () => {
    useTabStore.getState().openTab('root', 'Root')
    const run = useTabStore.getState().openSubagentTab('root', 'tool-1', 'Run')
    const nested = useTabStore.getState().openSubagentTab('root', 'tool-2', 'Nested', undefined, run)
    useTabStore.getState().openSubagentTab('root', 'tool-3', 'Deepest', undefined, nested)

    returnToTab(run)

    expect(useTabStore.getState().activeTabId).toBe(run)
    expect(ids()).toEqual(['root', run])
  })

  it('shows the target directly when the trail no longer leads there', () => {
    useTabStore.getState().openTab('elsewhere', 'Elsewhere')
    // A run whose chat has already left the stack.
    useTabStore.getState().openSubagentTab('gone', 'tool-1', 'Orphan run')

    returnToTab('gone')

    expect(useTabStore.getState().activeTabId).toBe('gone')
    expect(useTabStore.getState().tabs.find((tab) => tab.sessionId === 'gone')?.type).toBe('session')
  })
})
