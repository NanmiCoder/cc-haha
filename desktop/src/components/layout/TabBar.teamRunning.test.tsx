import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import type { PerSessionState } from '../../stores/chatStore'
import type { TeamMember, TeamWorkbenchTimeline } from '../../types/team'
import { browserHost } from '../../lib/desktopHost/browserHost'

// #1524: the lead has finished its own turn (chatState idle) but a teammate is
// still mid-turn. The tab's running dot must keep showing, otherwise switching
// to another tab hides that the team is still working.

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string) => (key === 'tabs.sessionRunning' ? 'Session running' : key),
}))

vi.mock('../../api/sessions', () => ({
  sessionsApi: { batchDelete: vi.fn(), branch: vi.fn(), create: vi.fn(), delete: vi.fn(), list: vi.fn(), rename: vi.fn() },
}))

vi.mock('../../api/teams', () => ({
  teamsApi: { getWorkbenchForSession: vi.fn() },
}))

vi.mock('./OpenProjectMenu', () => ({ OpenProjectMenu: () => null }))
vi.mock('./WindowControls', () => ({ WindowControls: () => null, showWindowControls: false }))

function makeChatSession(): PerSessionState {
  return {
    messages: [],
    chatState: 'idle',
    connectionState: 'connected',
    streamingText: '',
    streamingToolInput: '',
    activeToolUseId: null,
    activeToolName: null,
    activeThinkingId: null,
    pendingPermission: null,
    pendingComputerUsePermission: null,
    tokenUsage: { input_tokens: 0, output_tokens: 0 },
    streamingResponseChars: 0,
    elapsedSeconds: 0,
    statusVerb: '',
    slashCommands: [],
    agentTaskNotifications: {},
    backgroundAgentTasks: {},
    activeGoal: null,
    elapsedTimer: null,
    composerPrefill: null,
    composerDraft: null,
  }
}

function timeline(leadSessionId: string, members: TeamMember[]): TeamWorkbenchTimeline {
  return {
    teamName: 'review-team',
    loading: false,
    error: null,
    snapshots: [{
      version: 'v1',
      generatedAt: '2026-10-18T00:00:00.000Z',
      team: {
        name: 'review-team',
        leadAgentId: 'lead',
        leadSessionId,
        createdAt: '2026-10-18T00:00:00.000Z',
        members: [{ agentId: 'lead', role: 'Lead', status: 'idle', activity: 'idle' }, ...members],
      },
      tasks: [],
      messages: [],
    }],
  }
}

describe('TabBar running dot for Agent Teams (#1524)', () => {
  beforeEach(() => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: ResizeObserverMock })
    Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: { ...browserHost.capabilities, windowControls: false },
    }
    vi.resetModules()
  })

  afterEach(async () => {
    cleanup()
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useTeamStore } = await import('../../stores/teamStore')
    const { useTeamPlanStore } = await import('../../stores/teamPlanStore')
    useTeamPlanStore.setState({ bySession: {} })
    useTabStore.setState({ tabs: [], activeTabId: null })
    useChatStore.setState({ sessions: {} } as Partial<ReturnType<typeof useChatStore.getState>>)
    useTeamStore.setState(useTeamStore.getInitialState(), true)
  })

  async function renderWithTeam(members: TeamMember[]) {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    const { useChatStore } = await import('../../stores/chatStore')
    const { useTeamStore } = await import('../../stores/teamStore')
    const { useTeamPlanStore } = await import('../../stores/teamPlanStore')
    const leadId = 'lead-session'
    const otherId = 'other-session'
    useTabStore.setState({
      tabs: [
        { sessionId: leadId, title: 'Team Lead', type: 'session', status: 'idle' },
        { sessionId: otherId, title: 'Other', type: 'session', status: 'idle' },
      ],
      activeTabId: otherId,
    })
    useChatStore.setState({
      sessions: { [leadId]: makeChatSession(), [otherId]: makeChatSession() },
      disconnectSession: vi.fn(),
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useTeamStore.setState({
      workbenchesBySession: { [leadId]: timeline(leadId, members) },
    } as Partial<ReturnType<typeof useTeamStore.getState>>)
    // The same two signals useSessionStopOffer reads: an approved plan that is
    // running, plus the roster showing which members are mid-turn.
    // Stop pauses the team without ending the plan, so a plan can read
    // 'running' while every member is stopped.
    const planRunning = members.some((member) => member.activity === 'active' || member.activity === 'stopped')
    useTeamPlanStore.setState({
      bySession: {
        [leadId]: {
          plan: { state: planRunning ? 'running' : 'completed' } as never,
          loading: false, busy: false, error: null, conflict: false,
        },
      },
    })
    await act(async () => {
      render(<TabBar />)
    })
    return { leadId }
  }

  it('shows the running dot on the lead tab while a teammate is mid-turn', async () => {
    await renderWithTeam([{ agentId: 'worker', role: 'Worker', status: 'running', activity: 'active' }])
    expect(screen.getByRole('status', { name: 'Session running' })).toBeInTheDocument()
  })

  it('shows no dot when every teammate is idle (control)', async () => {
    await renderWithTeam([{ agentId: 'worker', role: 'Worker', status: 'idle', activity: 'idle' }])
    expect(screen.queryByRole('status', { name: 'Session running' })).not.toBeInTheDocument()
  })

  it('shows no dot and no close guard once Stop paused the team (plan still running, members stopped)', async () => {
    const { leadId } = await renderWithTeam([{ agentId: 'worker', role: 'Worker', status: 'idle', activity: 'stopped' }])
    expect(screen.queryByRole('status', { name: 'Session running' })).not.toBeInTheDocument()
    const { getRunningSessionIds } = await import('../../stores/tabClose')
    const { useTabStore } = await import('../../stores/tabStore')
    const leadTab = useTabStore.getState().tabs.find((tab) => tab.sessionId === leadId)!
    expect(getRunningSessionIds([leadTab])).toEqual([])
  })

  it('finds the dot by this query when a tab is running (query sanity)', async () => {
    const { TabBar } = await import('./TabBar')
    const { useTabStore } = await import('../../stores/tabStore')
    useTabStore.setState({
      tabs: [{ sessionId: 'lead-session', title: 'Team Lead', type: 'session', status: 'running' }],
      activeTabId: 'lead-session',
    })
    await act(async () => {
      render(<TabBar />)
    })
    expect(screen.getByRole('status', { name: 'Session running' })).toBeInTheDocument()
  })

  it('treats the lead session as running for the close-confirm guard too', async () => {
    const { leadId } = await renderWithTeam([{ agentId: 'worker', role: 'Worker', status: 'running', activity: 'active' }])
    const { getRunningSessionIds } = await import('../../stores/tabClose')
    const { useTabStore } = await import('../../stores/tabStore')
    const leadTab = useTabStore.getState().tabs.find((tab) => tab.sessionId === leadId)!
    expect(getRunningSessionIds([leadTab])).toEqual([leadId])
  })
})
