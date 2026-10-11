import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useChatStore } from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useTeamStore } from '@/stores/teamStore'
import { useTabStore } from '@/stores/tabStore'
import type { TeamWorkbenchSnapshot, TeamWorkbenchTask } from '@/types/team'

import { AgentTeamsWorkbench } from './AgentTeamsWorkbench'

const { getWorkbenchForSessionMock, getWorkbenchMock } = vi.hoisted(() => ({
  getWorkbenchForSessionMock: vi.fn(),
  getWorkbenchMock: vi.fn(),
}))

vi.mock('@/api/teams', () => ({
  teamsApi: {
    list: vi.fn(),
    get: vi.fn(),
    getWorkbenchForSession: getWorkbenchForSessionMock,
    getWorkbench: getWorkbenchMock,
    getMemberTranscript: vi.fn(),
    sendMemberMessage: vi.fn(),
    delete: vi.fn(),
  },
}))

function task(
  id: string,
  status: TeamWorkbenchTask['status'],
  blockedBy: string[] = [],
  owner?: string,
): TeamWorkbenchTask {
  return {
    id,
    subject: `Task ${id}`,
    description: `Task ${id} detail`,
    activeForm: status === 'in_progress' ? `Working on task ${id}` : undefined,
    owner,
    status,
    blocks: [],
    blockedBy,
    taskListId: 'visual-team',
  }
}

function workbench(
  version: string,
  statuses: [TeamWorkbenchTask['status'], TeamWorkbenchTask['status'], TeamWorkbenchTask['status']],
): TeamWorkbenchSnapshot {
  return {
    version,
    generatedAt: `2026-08-08T00:00:0${version.slice(-1)}.000Z`,
    team: {
      name: 'visual-team',
      leadAgentId: 'team-lead@visual-team',
      leadSessionId: 'lead-session',
      members: [
        { agentId: 'team-lead@visual-team', name: 'team-lead', role: 'lead', status: 'running' },
        { agentId: 'builder@visual-team', name: 'builder', role: 'frontend', status: 'running' },
        { agentId: 'reviewer@visual-team', name: 'reviewer', role: 'reviewer', status: 'idle' },
      ],
    },
    tasks: [
      task('1', statuses[0], [], 'builder'),
      task('2', statuses[1], ['1'], 'reviewer'),
      task('3', statuses[2], ['1', '2']),
    ],
    messages: [{
      id: `message-${version}`,
      from: 'builder',
      to: 'reviewer',
      recipients: ['reviewer'],
      kind: 'direct',
      text: `Snapshot ${version} ready`,
      timestamp: `2026-08-08T00:00:0${version.slice(-1)}.000Z`,
    }],
  }
}

function unownedWorkbench(
  version: string,
  builderStatus: 'running' | 'idle',
): TeamWorkbenchSnapshot {
  const snapshot = workbench(version, ['pending', 'pending', 'pending'])
  snapshot.tasks = snapshot.tasks.map((entry) => ({ ...entry, owner: undefined }))
  snapshot.team.members = snapshot.team.members.map((member) => (
    member.name === 'builder'
      ? { ...member, status: builderStatus }
      : member
  ))
  return snapshot
}

describe('AgentTeamsWorkbench', () => {
  beforeEach(() => {
    getWorkbenchMock.mockReset()
    getWorkbenchForSessionMock.mockReset()
    useTeamStore.getState().clearTeam()
    useTabStore.setState({ tabs: [], activeTabId: null })
    useSettingsStore.setState({ locale: 'en' })
  })

  it('keeps live controls simple, then supports seeking, speed, playback, and returning live', async () => {
    getWorkbenchMock
      .mockResolvedValueOnce(workbench('v1', ['completed', 'in_progress', 'pending']))
      .mockResolvedValueOnce(workbench('v2', ['completed', 'completed', 'in_progress']))
      .mockResolvedValueOnce(workbench('v3', ['completed', 'completed', 'completed']))

    await act(async () => {
      await useTeamStore.getState().fetchWorkbench('visual-team')
      await useTeamStore.getState().fetchWorkbench('visual-team')
    })
    render(<AgentTeamsWorkbench sessionId="lead-session" />)

    expect(screen.getByTestId('agent-teams-live-controls')).toBeTruthy()
    expect(screen.queryByTestId('agent-teams-replay-controls')).toBeNull()
    expect(screen.queryByRole('slider', { name: 'Replay timeline · click to seek' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^(Play|Pause|Replay)$/ })).toBeNull()
    expect(screen.getByTestId('agent-teams-communication-rail').className).toContain('w-14')
    expect(screen.getByTestId('agent-teams-canvas-task-2').getAttribute('data-state')).toBe('completed')
    expect(screen.getByTestId('agent-teams-canvas-task-3').getAttribute('data-state')).toBe('running')

    // A narrow pane wraps the controls onto their own row rather than forcing
    // a fixed-width header that scrolls sideways and squeezes button labels.
    const headerRow = screen.getByTestId('agent-teams-live-controls').parentElement!
    expect(headerRow.className).toContain('flex-wrap')
    expect(headerRow.className).not.toMatch(/\bmin-w-\[\d+px\]/)
    expect(headerRow.parentElement!.className).not.toContain('overflow-x-auto')

    fireEvent.click(screen.getByRole('button', { name: 'Review history' }))
    expect(screen.queryByTestId('agent-teams-live-controls')).toBeNull()
    expect(screen.getByTestId('agent-teams-replay-controls')).toBeTruthy()
    for (const name of [/^(Play|Pause|Replay)$/, 'Back to live']) {
      expect(screen.getByRole('button', { name }).className).toMatch(/(?=.*\bshrink-0\b)(?=.*\bwhitespace-nowrap\b)/)
    }

    const timeline = screen.getByRole('slider', { name: 'Replay timeline · click to seek' }) as HTMLInputElement
    expect(timeline.value).toBe('1000')
    fireEvent.change(timeline, { target: { value: '0' } })
    expect(screen.getByTestId('agent-teams-canvas-task-2').getAttribute('data-state')).toBe('running')
    expect(screen.getByTestId('agent-teams-canvas-task-3').getAttribute('data-state')).toBe('blocked')

    const quadrupleSpeed = screen.getByRole('button', { name: '4×' })
    fireEvent.click(quadrupleSpeed)
    expect(quadrupleSpeed.getAttribute('aria-pressed')).toBe('true')

    await act(async () => {
      await useTeamStore.getState().fetchWorkbench('visual-team')
    })
    expect(timeline.max).toBe('2000')
    expect(timeline.value).toBe('0')
    expect(screen.getByTestId('agent-teams-canvas-task-2').getAttribute('data-state')).toBe('running')

    vi.useFakeTimers()
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Play' }))
      expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy()
      act(() => {
        vi.advanceTimersByTime(251)
      })
      expect(screen.getByTestId('agent-teams-canvas-task-2').getAttribute('data-state')).toBe('completed')
      expect(screen.getByTestId('agent-teams-canvas-task-3').getAttribute('data-state')).toBe('running')
      fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    } finally {
      vi.useRealTimers()
    }

    fireEvent.click(screen.getByRole('button', { name: 'Back to live' }))
    expect(screen.getByTestId('agent-teams-live-controls')).toBeTruthy()
    expect(screen.getByTestId('agent-teams-canvas-task-3').getAttribute('data-state')).toBe('completed')
  })

  it('positions and plays replay snapshots by their real timestamps', async () => {
    vi.useFakeTimers()
    try {
      const first = workbench('v1', ['in_progress', 'pending', 'pending'])
      const middle = workbench('v2', ['completed', 'in_progress', 'pending'])
      const last = workbench('v3', ['completed', 'completed', 'completed'])
      first.generatedAt = '2026-08-08T00:00:00.000Z'
      middle.generatedAt = '2026-08-08T00:00:01.000Z'
      last.generatedAt = '2026-08-08T00:01:40.000Z'
      middle.messages = [...first.messages, ...middle.messages]
      last.messages = [...middle.messages, ...last.messages]
      getWorkbenchMock
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(middle)
        .mockResolvedValueOnce(last)

      await act(async () => {
        await useTeamStore.getState().fetchWorkbench('visual-team')
        await useTeamStore.getState().fetchWorkbench('visual-team')
        await useTeamStore.getState().fetchWorkbench('visual-team')
      })
      render(<AgentTeamsWorkbench sessionId="lead-session" />)
      fireEvent.click(screen.getByRole('button', { name: 'Review history' }))

      const timeline = screen.getByRole('slider', { name: 'Replay timeline · click to seek' }) as HTMLInputElement
      expect(timeline.max).toBe('100000')
      fireEvent.change(timeline, { target: { value: '1000' } })
      expect(screen.getByTestId('agent-teams-replay-progress').getAttribute('style')).toContain('width: 1%')
      expect(screen.getByTestId('agent-teams-replay-thumb').getAttribute('style')).toContain('left: 1%')

      fireEvent.change(timeline, { target: { value: '0' } })
      fireEvent.click(screen.getByRole('button', { name: 'Play' }))
      act(() => vi.advanceTimersByTime(1001))
      expect(screen.getByTestId('agent-teams-canvas-task-2').getAttribute('data-state')).toBe('running')
      act(() => vi.advanceTimersByTime(98_000))
      expect(screen.getByTestId('agent-teams-canvas-task-3').getAttribute('data-state')).toBe('blocked')
      act(() => vi.advanceTimersByTime(1001))
      expect(screen.getByTestId('agent-teams-canvas-task-3').getAttribute('data-state')).toBe('completed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('follows server-driven idle to running to idle member lifecycle without an owned task', async () => {
    getWorkbenchMock
      .mockResolvedValueOnce(unownedWorkbench('lifecycle-1', 'idle'))
      .mockResolvedValueOnce(unownedWorkbench('lifecycle-2', 'running'))
      .mockResolvedValueOnce(unownedWorkbench('lifecycle-3', 'idle'))

    await act(async () => {
      await useTeamStore.getState().fetchWorkbench('visual-team')
    })
    render(<AgentTeamsWorkbench sessionId="lead-session" />)

    const builder = () => screen.getByTestId('agent-teams-canvas-member-builder@visual-team')
    expect(builder().getAttribute('data-member-state')).toBe('idle')

    act(() => {
      useChatStore.getState().handleServerMessage('lead-session', {
        type: 'team_workbench_updated',
        teamName: 'visual-team',
      })
    })
    await waitFor(() => {
      expect(builder().getAttribute('data-member-state')).toBe('working')
    })

    act(() => {
      useChatStore.getState().handleServerMessage('lead-session', {
        type: 'team_workbench_updated',
        teamName: 'visual-team',
      })
    })
    await waitFor(() => {
      expect(builder().getAttribute('data-member-state')).toBe('idle')
    })
  })

  it('keeps a member idle while it still owns an in-progress task', async () => {
    const snapshot = workbench('v1', ['in_progress', 'pending', 'pending'])
    snapshot.team.members = snapshot.team.members.map((member) => (
      member.name === 'builder'
        ? { ...member, status: 'running' as const, activity: 'idle' as const }
        : member
    ))
    getWorkbenchMock.mockResolvedValueOnce(snapshot)

    await act(async () => {
      await useTeamStore.getState().fetchWorkbench('visual-team')
    })
    render(<AgentTeamsWorkbench sessionId="lead-session" />)

    expect(
      screen.getByTestId('agent-teams-canvas-member-builder@visual-team').getAttribute('data-member-state'),
    ).toBe('idle')
    expect(screen.getByTestId('agent-teams-canvas-task-1').getAttribute('data-state')).toBe('running')
  })

  it('shows a member working while it owns no task at all', async () => {
    const snapshot = unownedWorkbench('v1', 'idle')
    snapshot.team.members = snapshot.team.members.map((member) => (
      member.name === 'builder'
        ? { ...member, activity: 'active' as const }
        : member
    ))
    getWorkbenchMock.mockResolvedValueOnce(snapshot)

    await act(async () => {
      await useTeamStore.getState().fetchWorkbench('visual-team')
    })
    render(<AgentTeamsWorkbench sessionId="lead-session" />)

    expect(
      screen.getByTestId('agent-teams-canvas-member-builder@visual-team').getAttribute('data-member-state'),
    ).toBe('working')
  })

  it('opens a 400px member inspector before the explicit execution handoff', async () => {
    getWorkbenchMock.mockResolvedValueOnce(workbench('v1', ['completed', 'in_progress', 'pending']))
    await act(async () => {
      await useTeamStore.getState().fetchWorkbench('visual-team')
    })
    render(<AgentTeamsWorkbench sessionId="lead-session" />)

    const reviewer = screen.getByTestId('agent-teams-canvas-member-reviewer@visual-team')
    fireEvent.click(reviewer)

    expect(useTabStore.getState().activeTabId).toBeNull()
    expect(reviewer.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('agent-teams-member-inspector')).toBeTruthy()
    expect(screen.getByTestId('agent-teams-communication-pane').className).toContain('w-[400px]')

    fireEvent.click(screen.getByRole('button', { name: 'View reviewer execution' }))
    expect(useTabStore.getState().activeTabId).toBe('team-member:reviewer@visual-team')
    expect(useTabStore.getState().tabs.find((tab) => tab.sessionId === 'team-member:reviewer@visual-team')).toMatchObject({
      type: 'team-member',
      teamLeadSessionId: 'lead-session',
    })
  })

  it('closes an open member inspector when the selected member is clicked again', async () => {
    getWorkbenchMock.mockResolvedValueOnce(workbench('v1', ['completed', 'in_progress', 'pending']))
    await act(async () => {
      await useTeamStore.getState().fetchWorkbench('visual-team')
    })
    render(<AgentTeamsWorkbench sessionId="lead-session" />)

    const reviewer = screen.getByTestId('agent-teams-canvas-member-reviewer@visual-team')
    fireEvent.click(reviewer)
    expect(screen.getByTestId('agent-teams-member-inspector')).toBeTruthy()
    fireEvent.click(reviewer)
    expect(screen.queryByTestId('agent-teams-member-inspector')).toBeNull()
    expect(screen.getByTestId('agent-teams-communication-rail')).toBeTruthy()
  })

  it('returns to the real lead session instead of creating a synthetic lead member run', async () => {
    getWorkbenchMock.mockResolvedValueOnce(workbench('v1', ['completed', 'in_progress', 'pending']))
    await act(async () => {
      await useTeamStore.getState().fetchWorkbench('visual-team')
    })
    render(<AgentTeamsWorkbench sessionId="lead-session" />)

    fireEvent.click(screen.getByTestId('agent-teams-canvas-member-team-lead@visual-team'))
    fireEvent.click(screen.getByRole('button', { name: 'View team-lead execution' }))

    expect(useTabStore.getState().activeTabId).toBe('lead-session')
    expect(useTabStore.getState().tabs).toContainEqual(expect.objectContaining({
      sessionId: 'lead-session',
      type: 'session',
    }))
    expect(useTabStore.getState().tabs.some(tab => tab.type === 'team-member')).toBe(false)
  })

  it('opens task details without navigating to a member execution', async () => {
    getWorkbenchMock.mockResolvedValueOnce(workbench('v1', ['completed', 'in_progress', 'pending']))
    await act(async () => {
      await useTeamStore.getState().fetchWorkbench('visual-team')
    })
    render(<AgentTeamsWorkbench sessionId="lead-session" />)

    fireEvent.click(screen.getByTestId('agent-teams-canvas-task-1'))
    expect(useTabStore.getState().activeTabId).toBeNull()
    expect(screen.getByTestId('agent-teams-task-detail').getAttribute('data-task-id')).toBe('1')
    expect(screen.getByTestId('agent-teams-task-detail').textContent).toContain('Task 1 detail')

    fireEvent.click(screen.getByTestId('agent-teams-canvas-task-2'))
    expect(useTabStore.getState().activeTabId).toBeNull()
    expect(screen.getByTestId('agent-teams-task-detail').getAttribute('data-task-id')).toBe('2')
  })

  it('does not leak a selected task into replay frames before that task existed', async () => {
    const beforeCreation = workbench('v1', ['completed', 'pending', 'pending'])
    beforeCreation.tasks = beforeCreation.tasks.filter(entry => entry.id !== '3')
    const afterCreation = workbench('v2', ['completed', 'completed', 'in_progress'])
    getWorkbenchMock.mockResolvedValueOnce(beforeCreation).mockResolvedValueOnce(afterCreation)
    await act(async () => {
      await useTeamStore.getState().fetchWorkbench('visual-team')
      await useTeamStore.getState().fetchWorkbench('visual-team')
    })
    render(<AgentTeamsWorkbench sessionId="lead-session" />)

    fireEvent.click(screen.getByTestId('agent-teams-canvas-task-3'))
    expect(screen.getByTestId('agent-teams-task-detail')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Review history' }))
    fireEvent.change(screen.getByRole('slider', { name: 'Replay timeline · click to seek' }), {
      target: { value: '0' },
    })
    expect(screen.queryByTestId('agent-teams-task-detail')).toBeNull()
  })

  it('draws a teammate once while retaining its owner labels across several tasks', async () => {
    const snapshot = workbench('v1', ['in_progress', 'in_progress', 'pending'])
    snapshot.tasks = snapshot.tasks.map((entry) => ({ ...entry, owner: 'builder' }))
    getWorkbenchMock.mockResolvedValueOnce(snapshot)
    await act(async () => {
      await useTeamStore.getState().fetchWorkbench('visual-team')
    })
    const { container } = render(<AgentTeamsWorkbench sessionId="lead-session" />)

    expect(
      container.querySelectorAll('[data-testid="agent-teams-canvas-member-builder@visual-team"]'),
    ).toHaveLength(1)
    expect(within(screen.getByTestId('agent-teams-canvas-task-2')).getByText('builder')).toBeTruthy()
  })

  it('restores archived roster members and task owners across replay snapshots', async () => {
    const beforeRemoval = workbench('roster-1', ['in_progress', 'in_progress', 'pending'])
    beforeRemoval.team.members.push({
      agentId: 'observer@visual-team',
      name: 'observer',
      role: 'researcher',
      status: 'idle',
    })
    const afterRemoval: TeamWorkbenchSnapshot = {
      ...workbench('roster-2', ['completed', 'completed', 'completed']),
      deletedAt: '2026-08-08T00:10:00.000Z',
      team: {
        ...beforeRemoval.team,
        members: beforeRemoval.team.members
          .filter((member) => member.name !== 'builder')
          .map((member) => ({ ...member, status: 'completed' as const })),
      },
      tasks: workbench('roster-2', ['completed', 'completed', 'completed']).tasks.map((entry) => (
        entry.id === '3' ? { ...entry, owner: 'legacy-owner' } : entry
      )),
    }
    getWorkbenchForSessionMock.mockResolvedValueOnce({
      sessionId: 'lead-session',
      teamName: 'visual-team',
      source: 'archive',
      snapshots: [beforeRemoval, afterRemoval],
    })

    await act(async () => {
      await useTeamStore.getState().fetchTeamForSession('lead-session', { force: true })
    })
    render(<AgentTeamsWorkbench sessionId="lead-session" />)

    expect(within(screen.getByTestId('agent-teams-canvas-task-1')).getByText('builder')).toBeTruthy()
    expect(within(screen.getByTestId('agent-teams-canvas-task-3')).getByText('legacy-owner')).toBeTruthy()

    const restoredBuilder = screen.getByTestId('agent-teams-canvas-member-builder@visual-team')
    const observer = screen.getByTestId('agent-teams-canvas-member-observer@visual-team')
    expect(restoredBuilder.getAttribute('data-member-state')).toBe('exited')
    expect(observer.getAttribute('data-member-state')).toBe('exited')
    expect(restoredBuilder.querySelector('img')).toBeTruthy()

    fireEvent.click(restoredBuilder)
    expect(useTabStore.getState().activeTabId).toBeNull()
    expect(screen.getByTestId('agent-teams-member-inspector').getAttribute('data-member-id')).toBe('builder@visual-team')
    fireEvent.click(screen.getByRole('button', { name: 'View builder execution' }))
    expect(useTabStore.getState().activeTabId).toBe('team-member:builder@visual-team')
  })

  it('expands the 56px communication rail to a fixed panel and closes it again', async () => {
    getWorkbenchMock.mockResolvedValueOnce(workbench('v1', ['completed', 'in_progress', 'pending']))
    await act(async () => {
      await useTeamStore.getState().fetchWorkbench('visual-team')
    })
    render(<AgentTeamsWorkbench sessionId="lead-session" />)

    const rail = screen.getByTestId('agent-teams-communication-rail')
    expect(rail.className).toContain('w-14')
    expect(screen.queryByTestId('agent-teams-communication-pane')).toBeNull()

    fireEvent.click(rail)
    const pane = screen.getByTestId('agent-teams-communication-pane')
    expect(pane.className).toContain('w-[400px]')
    expect(screen.getByTestId('agent-teams-communication').className).toContain('h-full')
    expect(screen.queryByTestId('agent-teams-communication-rail')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Close communication panel' }))
    expect(screen.queryByTestId('agent-teams-communication-pane')).toBeNull()
    expect(screen.getByTestId('agent-teams-communication-rail')).toBeTruthy()
  })

  it('lights the dependency chain while a task-linked communication row is hovered', async () => {
    const snapshot = workbench('v1', ['completed', 'in_progress', 'pending'])
    snapshot.messages[0] = { ...snapshot.messages[0]!, taskId: '2' }
    getWorkbenchMock.mockResolvedValueOnce(snapshot)
    await act(async () => {
      await useTeamStore.getState().fetchWorkbench('visual-team')
    })
    render(<AgentTeamsWorkbench sessionId="lead-session" />)

    fireEvent.click(screen.getByTestId('agent-teams-communication-rail'))
    const row = screen.getByTestId('agent-teams-message-message-v1')
    fireEvent.mouseEnter(row)
    expect(screen.getByTestId('agent-teams-canvas-task-1').getAttribute('data-chain-active')).toBe('true')
    expect(screen.getByTestId('agent-teams-canvas-task-2').getAttribute('data-chain-active')).toBe('true')
    fireEvent.mouseLeave(row)
    expect(screen.getByTestId('agent-teams-canvas-task-2').getAttribute('data-chain-active')).toBe('false')
    fireEvent.mouseEnter(row)
    fireEvent.click(screen.getByRole('button', { name: 'Close communication panel' }))
    expect(screen.getByTestId('agent-teams-canvas-task-2').getAttribute('data-chain-active')).toBe('false')
  })

  it('animates every message in a CLI polling batch in arrival order', async () => {
    const first = workbench('v1', ['completed', 'in_progress', 'pending'])
    const second = workbench('v2', ['completed', 'in_progress', 'pending'])
    const peerMessage = {
      ...first.messages[0]!,
      id: 'batch-peer',
      from: 'reviewer',
      to: 'builder',
      recipients: ['builder'],
      taskId: '2',
    }
    const reportMessage = {
      ...first.messages[0]!,
      id: 'batch-report',
      from: 'builder',
      to: 'team-lead',
      recipients: ['team-lead'],
      taskId: '1',
    }
    second.messages = [...first.messages, peerMessage, reportMessage]
    getWorkbenchMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    await act(async () => {
      await useTeamStore.getState().fetchWorkbench('visual-team')
    })
    render(<AgentTeamsWorkbench sessionId="lead-session" />)

    vi.useFakeTimers()
    try {
      await act(async () => {
        await useTeamStore.getState().fetchWorkbench('visual-team')
      })
      expect(screen.getByTestId('agent-teams-active-flight-path').getAttribute('data-flight-channel')).toBe('peer')
      act(() => vi.advanceTimersByTime(1501))
      expect(screen.getByTestId('agent-teams-active-flight-path').getAttribute('data-flight-channel')).toBe('lead')
      act(() => vi.advanceTimersByTime(1501))
      expect(screen.queryByTestId('agent-teams-active-flight-path')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never describes an ownerless completed task as waiting to be claimed', async () => {
    const snapshot = workbench('v1', ['completed', 'pending', 'completed'])
    snapshot.tasks = snapshot.tasks.map((entry) => (
      entry.id === '1' || entry.id === '2'
        ? { ...entry, owner: undefined }
        : entry
    ))
    getWorkbenchMock.mockResolvedValueOnce(snapshot)
    await act(async () => {
      await useTeamStore.getState().fetchWorkbench('visual-team')
    })

    render(<AgentTeamsWorkbench sessionId="lead-session" />)

    const completed = screen.getByTestId('agent-teams-canvas-task-1')
    expect(within(completed).getByText('Completed · owner not recorded')).toBeTruthy()
    expect(within(completed).queryByText('Waiting for a teammate')).toBeNull()

    const available = screen.getByTestId('agent-teams-canvas-task-2')
    expect(within(available).getByText('Waiting for a teammate')).toBeTruthy()
    expect(within(available).queryByText('Completed · owner not recorded')).toBeNull()
  })
})
