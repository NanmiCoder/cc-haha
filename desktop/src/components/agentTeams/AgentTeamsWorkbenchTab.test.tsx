import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore } from '../../stores/tabStore'
import { useTeamStore } from '../../stores/teamStore'
import type { TeamMember, TeamWorkbenchSnapshot } from '../../types/team'
import { AgentTeamsWorkbenchTab } from './AgentTeamsWorkbenchTab'

vi.mock('../../api/teams', () => ({
  teamsApi: {
    list: vi.fn(), get: vi.fn(),
    getWorkbenchForSession: vi.fn().mockRejectedValue(new Error('no')),
    getWorkbench: vi.fn(), getMemberTranscript: vi.fn(), sendMemberMessage: vi.fn(), delete: vi.fn(),
  },
}))

const lead: TeamMember = {
  agentId: 'lead@t',
  name: 'lead',
  role: 'orchestrator',
  status: 'running',
}

const reviewer: TeamMember = {
  agentId: 'reviewer@t',
  name: 'reviewer',
  role: 'reviewer',
  status: 'running',
}

function workbenchSnapshot(overrides: Partial<TeamWorkbenchSnapshot> = {}): TeamWorkbenchSnapshot {
  return {
    version: 'v1',
    generatedAt: '2026-08-08T00:00:00.000Z',
    team: {
      name: 't',
      leadAgentId: lead.agentId,
      leadSessionId: 'lead-session',
      members: [lead, reviewer],
    },
    tasks: [{
      id: '1',
      subject: 'Review the implementation',
      description: '',
      status: 'in_progress',
      owner: reviewer.name,
      blocks: [],
      blockedBy: [],
      taskListId: 't',
    }],
    messages: [{
      id: 'm1',
      from: reviewer.name!,
      to: lead.name!,
      recipients: [lead.name!],
      kind: 'direct',
      text: 'Review is in progress.',
      timestamp: '2026-08-08T00:00:00.000Z',
    }],
    ...overrides,
  }
}

function installTimeline(snapshot = workbenchSnapshot()) {
  useTeamStore.setState({
    workbenchesBySession: {
      'lead-session': {
        teamName: 't',
        loading: false,
        error: null,
        snapshots: [snapshot],
      },
    },
  })
}

describe('AgentTeamsWorkbenchTab', () => {
  beforeEach(() => {
    useTeamStore.getState().clearTeam()
    useTabStore.setState({ tabs: [], activeTabId: null })
    useSettingsStore.setState({ locale: 'en' })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('opens the 400px communication feed from a collapsed 56px rail', () => {
    installTimeline()

    render(<AgentTeamsWorkbenchTab tabId="__team__lead-session" leadSessionId="lead-session" />)
    expect(screen.getByRole('button', { name: /Back to session/ }).parentElement!.parentElement!.className).toContain('min-w-0')

    expect(screen.getByTestId('agent-teams-canvas')).toBeTruthy()
    expect(screen.queryByTestId('agent-teams-communication')).toBeNull()
    expect(screen.queryByTestId('agent-teams-communication-pane')).toBeNull()

    const rail = screen.getByTestId('agent-teams-communication-rail')
    expect(rail.className).toContain('w-14')
    fireEvent.click(rail)

    const pane = screen.getByTestId('agent-teams-communication-pane')
    expect(pane.className).toContain('w-[400px]')
    expect(screen.queryByTestId('agent-teams-communication-rail')).toBeNull()
    expect(screen.getByTestId('agent-teams-communication').className).toContain('h-full')
    expect(screen.getByText('Review is in progress.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Open the workbench full screen/i })).toBeNull()
    expect(screen.getByRole('button', { name: 'Back to session' })).toBeTruthy()
  })

  it('opens a member inspector before routing to execution and restores the Canvas on return', async () => {
    installTimeline()
    useTabStore.getState().openTab('lead-session', 'Lead session')
    const teamTabId = useTabStore.getState().openTeamWorkbenchTab('lead-session', 't')

    function RoutedWorkbench() {
      const activeTab = useTabStore((state) => (
        state.tabs.find((tab) => tab.sessionId === state.activeTabId)
      ))
      if (activeTab?.type === 'team-member') {
        return (
          <button
            type="button"
            onClick={() => useTabStore.getState().returnFromTeamMember(activeTab.sessionId)}
          >
            Return to workbench
          </button>
        )
      }
      return <AgentTeamsWorkbenchTab tabId={teamTabId} leadSessionId="lead-session" />
    }

    render(<RoutedWorkbench />)
    const member = await screen.findByTestId('agent-teams-canvas-member-reviewer@t')

    fireEvent.click(member)

    const inspector = screen.getByTestId('agent-teams-member-inspector')
    expect(inspector.getAttribute('data-member-id')).toBe('reviewer@t')
    expect(screen.getByTestId('agent-teams-communication-pane').className).toContain('w-[400px]')
    expect(useTabStore.getState().activeTabId).toBe(teamTabId)
    expect(screen.queryByRole('button', { name: 'Return to workbench' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'View reviewer execution' }))

    await waitFor(() => {
      expect(useTabStore.getState().activeTabId).toBe('team-member:reviewer@t')
    })
    expect(screen.getByRole('button', { name: 'Return to workbench' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Return to workbench' }))

    await waitFor(() => {
      expect(useTabStore.getState().activeTabId).toBe(teamTabId)
      expect(screen.getByTestId('agent-teams-canvas')).toBeTruthy()
    })
    expect(screen.getByTestId('agent-teams-canvas-member-reviewer@t')).toBeTruthy()
    expect(screen.getByTestId('agent-teams-communication-rail').className).toContain('w-14')
  })
})
