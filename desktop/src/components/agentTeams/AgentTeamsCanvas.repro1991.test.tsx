import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../../stores/settingsStore'
import type { TeamWorkbenchSnapshot, TeamWorkbenchTask } from '../../types/team'
import { AgentTeamsCanvas, type AgentTeamsCanvasProps } from './AgentTeamsCanvas'

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
    owner,
    status,
    blocks: [],
    blockedBy,
    taskListId: 'repro-1991-team',
  }
}

function makeCompletedTeamSnapshot(overrides: Partial<TeamWorkbenchSnapshot> = {}): TeamWorkbenchSnapshot {
  return {
    version: 'completed',
    generatedAt: '2026-11-24T00:29:00.000Z',
    team: {
      name: 'repro-1991-team',
      leadAgentId: 'team-lead@repro-1991-team',
      members: [
        { agentId: 'team-lead@repro-1991-team', name: 'team-lead', role: 'Lead', status: 'idle', activity: 'idle' },
        { agentId: 'builder@repro-1991-team', name: 'builder', role: 'Builder', status: 'idle', activity: 'idle' },
        { agentId: 'reviewer@repro-1991-team', name: 'reviewer', role: 'Reviewer', status: 'completed', activity: 'exited' },
      ],
    },
    tasks: [
      task('1', 'completed', [], 'builder'),
      task('2', 'completed', ['1'], 'builder'),
      task('3', 'completed', ['2'], 'reviewer'),
    ],
    messages: [],
    ...overrides,
  }
}

function makeProps(snapshot: TeamWorkbenchSnapshot): AgentTeamsCanvasProps {
  return {
    snapshots: [snapshot],
    selectedIndex: 0,
    snapshot,
    previousSnapshot: snapshot,
    leadIsStreaming: false,
    activeMessageId: null,
    selectedMemberId: null,
    onSelectMember: vi.fn(),
    onSelectTask: vi.fn(),
  }
}

describe('Issue #1991 Part 1 — AgentTeamsCanvas dependency edge flow animation after completion', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('stops flowing animation on dependency edges once downstream tasks are completed', () => {
    const completedSnapshot = makeCompletedTeamSnapshot()
    render(<AgentTeamsCanvas {...makeProps(completedSnapshot)} />)

    const edge12 = screen.getByTestId('agent-teams-canvas-edge-1-2')
    const edge23 = screen.getByTestId('agent-teams-canvas-edge-2-3')

    // All upstream and downstream tasks are completed; edges should be static, not flowing.
    expect(edge12.getAttribute('class') ?? '').not.toContain('agent-teams-flow')
    expect(edge23.getAttribute('class') ?? '').not.toContain('agent-teams-flow')
  })

  it('stops flowing animation on dependency edges when the team is archived/deleted', () => {
    const archivedSnapshot = makeCompletedTeamSnapshot({
      deletedAt: '2026-11-24T00:30:00.000Z',
    })
    render(<AgentTeamsCanvas {...makeProps(archivedSnapshot)} />)

    const edge12 = screen.getByTestId('agent-teams-canvas-edge-1-2')
    const edge23 = screen.getByTestId('agent-teams-canvas-edge-2-3')

    expect(edge12.getAttribute('class') ?? '').not.toContain('agent-teams-flow')
    expect(edge23.getAttribute('class') ?? '').not.toContain('agent-teams-flow')
  })

  it('keeps flowing animation on satisfied edges while the downstream task is still active', () => {
    const activeSnapshot = makeCompletedTeamSnapshot({
      version: 'active',
      tasks: [
        task('1', 'completed', [], 'builder'),
        task('2', 'in_progress', ['1'], 'builder'),
        task('3', 'pending', ['2'], 'reviewer'),
      ],
    })
    render(<AgentTeamsCanvas {...makeProps(activeSnapshot)} />)

    const edge12 = screen.getByTestId('agent-teams-canvas-edge-1-2')
    const edge23 = screen.getByTestId('agent-teams-canvas-edge-2-3')

    expect(edge12.getAttribute('data-edge-satisfied')).toBe('true')
    expect(edge12.getAttribute('class') ?? '').toContain('agent-teams-flow')
    expect(edge23.getAttribute('data-edge-satisfied')).toBe('false')
    expect(edge23.getAttribute('class') ?? '').not.toContain('agent-teams-flow')
  })

  it('stops flowing animation on satisfied edges with unfinished downstream tasks once archived', () => {
    const archivedPartialSnapshot = makeCompletedTeamSnapshot({
      version: 'archived-partial',
      deletedAt: '2026-11-24T00:30:00.000Z',
      tasks: [
        task('1', 'completed', [], 'builder'),
        task('2', 'pending', ['1'], 'builder'),
      ],
    })
    render(<AgentTeamsCanvas {...makeProps(archivedPartialSnapshot)} />)

    const edge12 = screen.getByTestId('agent-teams-canvas-edge-1-2')

    expect(edge12.getAttribute('data-edge-satisfied')).toBe('true')
    expect(edge12.getAttribute('class') ?? '').not.toContain('agent-teams-flow')
  })
})
