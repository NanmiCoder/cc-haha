import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen } from '@testing-library/react'
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
    activeForm: status === 'in_progress' ? `Working on task ${id}` : undefined,
    owner,
    status,
    blocks: [],
    blockedBy,
    taskListId: 'canvas-team',
  }
}

function snapshot(version: 'previous' | 'current'): TeamWorkbenchSnapshot {
  const current = version === 'current'
  return {
    version,
    generatedAt: current ? '2026-08-12T02:30:00.000Z' : '2026-08-12T02:29:00.000Z',
    team: {
      name: 'canvas-team',
      leadAgentId: 'team-lead@canvas-team',
      members: [
        { agentId: 'team-lead@canvas-team', name: 'team-lead', role: 'Lead', status: 'running' },
        { agentId: 'builder@canvas-team', name: 'builder', role: 'Frontend', status: 'running', activity: 'active' },
        { agentId: 'reviewer@canvas-team', name: 'reviewer', role: 'Review', status: 'idle', activity: 'idle' },
        { agentId: 'qa@canvas-team', name: 'qa', role: 'QA', status: current ? 'completed' : 'running', activity: current ? 'exited' : 'idle' },
      ],
    },
    tasks: current
      ? [
          task('1', 'completed', [], 'builder'),
          task('2', 'in_progress', ['1'], 'builder'),
          task('3', 'pending', ['2'], 'reviewer'),
          task('4', 'completed', ['1'], 'qa'),
        ]
      : [
          task('1', 'in_progress', [], 'builder'),
          task('2', 'pending', ['1'], 'builder'),
          task('3', 'pending', ['2'], 'reviewer'),
          task('4', 'pending', ['1'], 'qa'),
        ],
    messages: [
      {
        id: 'peer-message',
        from: 'builder',
        to: 'reviewer',
        recipients: ['reviewer'],
        kind: 'direct',
        text: 'The first task is ready for review.',
        timestamp: '2026-08-12T02:29:30.000Z',
      },
      {
        id: 'lead-message',
        from: 'team-lead',
        to: 'builder',
        recipients: ['builder'],
        kind: 'system',
        text: '{"type":"task_assignment","taskId":"2","subject":"Task 2"}',
        protocolType: 'task_assignment',
        taskId: '2',
        timestamp: '2026-08-12T02:29:40.000Z',
      },
      {
        id: 'claim-message',
        from: 'builder',
        to: 'builder',
        recipients: ['builder'],
        kind: 'system',
        text: '{"type":"task_assignment","taskId":"2","subject":"Task 2"}',
        protocolType: 'task_assignment',
        taskId: '2',
        timestamp: '2026-08-12T02:29:50.000Z',
      },
    ],
  }
}

function props(overrides: Partial<AgentTeamsCanvasProps> = {}): AgentTeamsCanvasProps {
  const previousSnapshot = snapshot('previous')
  const currentSnapshot = snapshot('current')
  return {
    snapshots: [previousSnapshot, currentSnapshot],
    selectedIndex: 1,
    snapshot: currentSnapshot,
    previousSnapshot,
    leadIsStreaming: true,
    activeMessageId: 'peer-message',
    selectedMemberId: null,
    onSelectMember: vi.fn(),
    onSelectTask: vi.fn(),
    ...overrides,
  }
}

describe('AgentTeamsCanvas', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('renders the fixed formation over horizontal dependency lanes with one node per member', () => {
    const { container } = render(<AgentTeamsCanvas {...props()} />)

    expect(screen.getByTestId('agent-teams-formation-layer')).toBeTruthy()
    expect(screen.getByTestId('agent-teams-task-layer')).toBeTruthy()
    expect(screen.getByText('1 · Formation — lead centered, teammates below')).toBeTruthy()
    expect(screen.getByText('2 · Shared task list — dependency layers, left → right')).toBeTruthy()

    const lead = screen.getByTestId('agent-teams-canvas-member-team-lead@canvas-team')
    const builder = screen.getByTestId('agent-teams-canvas-member-builder@canvas-team')
    expect(lead.style.top).toBe('20px')
    expect(builder.style.top).toBe('222px')
    expect(lead.textContent).toContain('Coordinating · awaiting reports')
    expect(builder.textContent).toContain('Executing #2')
    expect(container.querySelectorAll('[data-testid="agent-teams-canvas-member-builder@canvas-team"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-testid^="agent-teams-canvas-member-"]')).toHaveLength(4)

    expect(container.querySelectorAll('[data-testid^="agent-teams-canvas-lane-"]')).toHaveLength(3)
    expect(screen.getByTestId('agent-teams-canvas-task-1').style.top).toBe('442px')
    expect(screen.getByTestId('agent-teams-canvas-task-1').className).toContain('h-[92px]')
    expect(screen.getByTestId('agent-teams-canvas-task-1').className).toContain('w-[200px]')
    expect(screen.getByTestId('agent-teams-legend').style.top).toBe('684px')
  })

  it('draws dependency state, a maximum-one-per-active-member tether, and indeterminate real work', () => {
    const { container } = render(<AgentTeamsCanvas {...props()} />)

    expect(container.querySelectorAll('[data-testid^="agent-teams-canvas-edge-"]')).toHaveLength(3)
    const unlocked = screen.getByTestId('agent-teams-canvas-edge-1-2')
    expect(unlocked.getAttribute('data-edge-satisfied')).toBe('true')
    expect(unlocked.getAttribute('data-edge-fresh')).toBe('true')
    expect(unlocked.getAttribute('stroke')).toBe('var(--color-success)')
    expect(screen.getByTestId('agent-teams-canvas-edge-2-3').getAttribute('data-edge-satisfied')).toBe('false')

    expect(screen.getByTestId('agent-teams-canvas-tether-builder@canvas-team').getAttribute('data-task-id')).toBe('2')
    expect(screen.queryByTestId('agent-teams-canvas-tether-reviewer@canvas-team')).toBeNull()
    expect(
      screen.getByTestId('agent-teams-canvas-task-2').querySelector('[data-progress="indeterminate"]')?.className,
    ).toContain('agent-teams-task-running-fill')

    fireEvent.mouseEnter(screen.getByTestId('agent-teams-canvas-task-3'))
    expect(container.querySelectorAll('[data-edge-active="true"]').length).toBeGreaterThan(0)
    fireEvent.mouseLeave(screen.getByTestId('agent-teams-canvas-task-3'))
    expect(container.querySelectorAll('[data-edge-active="true"]')).toHaveLength(0)
  })

  it('uses the transient unlocked label only while the task is actually open', () => {
    const previousSnapshot = snapshot('previous')
    const openSnapshot = snapshot('current')
    openSnapshot.tasks = openSnapshot.tasks.map(entry => (
      entry.id === '2' ? { ...entry, status: 'pending' as const } : entry
    ))
    const { rerender } = render(<AgentTeamsCanvas {...props({
      snapshots: [previousSnapshot, openSnapshot],
      snapshot: openSnapshot,
      previousSnapshot,
      activeMessageId: null,
    })} />)

    const unlockedTask = screen.getByTestId('agent-teams-canvas-task-2')
    expect(unlockedTask.textContent).toContain('Just unlocked')
    const unlockedPill = Array.from(unlockedTask.querySelectorAll('span'))
      .find(element => element.textContent === 'Just unlocked') as HTMLElement
    expect(unlockedPill.style.color).toBe('var(--color-on-success-container)')

    const completedTask = screen.getByTestId('agent-teams-canvas-task-1')
    const completedPill = Array.from(completedTask.querySelectorAll('span'))
      .find(element => element.textContent === 'Completed') as HTMLElement
    expect(completedPill.style.color).toBe('var(--color-on-success-container)')

    const runningSnapshot = snapshot('current')
    rerender(<AgentTeamsCanvas {...props({
      snapshots: [previousSnapshot, runningSnapshot],
      snapshot: runningSnapshot,
      previousSnapshot,
      activeMessageId: null,
    })} />)

    expect(screen.getByTestId('agent-teams-canvas-task-2').textContent).toContain('In progress')
    expect(screen.getByTestId('agent-teams-canvas-task-2').textContent).not.toContain('Just unlocked')
  })

  it('uses accessible controls and calls the task and member selection contracts', () => {
    const onSelectMember = vi.fn()
    const onSelectTask = vi.fn()
    render(<AgentTeamsCanvas {...props({ onSelectMember, onSelectTask, selectedMemberId: 'builder' })} />)

    const builder = screen.getByRole('button', { name: 'builder' })
    expect(builder.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(builder)
    expect(onSelectMember).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'builder@canvas-team' }),
      false,
    )

    fireEvent.click(screen.getByRole('button', { name: 'team-lead' }))
    expect(onSelectMember).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'team-lead@canvas-team' }),
      true,
    )

    const runningTask = screen.getByRole('button', { name: 'Task 2, In progress' })
    fireEvent.focus(runningTask)
    fireEvent.click(runningTask)
    expect(onSelectTask).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }))
  })

  it('routes the active capsule through peer, lead, and self-claim channels', () => {
    const base = props()
    const { rerender } = render(<AgentTeamsCanvas {...base} />)

    expect(screen.getByTestId('agent-teams-active-flight').getAttribute('data-flight-channel')).toBe('peer')
    expect(screen.getByTestId('agent-teams-active-flight').textContent).toContain('DIRECT')
    expect(screen.getByTestId('agent-teams-active-flight').className).toContain('agent-teams-flight')
    expect(screen.getByTestId('agent-teams-canvas-member-builder@canvas-team').querySelector('.agent-teams-member-ring')).toBeTruthy()
    expect(screen.getByTestId('agent-teams-canvas-member-reviewer@canvas-team').querySelector('.agent-teams-member-ring')).toBeTruthy()

    rerender(<AgentTeamsCanvas {...base} activeMessageId="lead-message" />)
    expect(screen.getByTestId('agent-teams-active-flight').getAttribute('data-flight-channel')).toBe('lead')
    expect(screen.getByTestId('agent-teams-active-flight').textContent).toContain('Assignments')

    rerender(<AgentTeamsCanvas {...base} activeMessageId="claim-message" />)
    expect(screen.getByTestId('agent-teams-active-flight').getAttribute('data-flight-channel')).toBe('claim')
    expect(screen.getByTestId('agent-teams-active-flight-path').getAttribute('data-flight-channel')).toBe('claim')
  })

  it('routes a broadcast to every recipient on the matching lead or peer channel', () => {
    const current = snapshot('current')
    current.messages = [
      ...current.messages,
      {
        id: 'lead-broadcast',
        from: 'team-lead',
        to: '*',
        recipients: ['builder', 'reviewer', 'qa'],
        kind: 'broadcast',
        text: 'Check in now.',
        timestamp: '2026-08-12T02:29:55.000Z',
      },
      {
        id: 'worker-broadcast',
        from: 'builder',
        to: '*',
        recipients: ['team-lead', 'reviewer', 'qa'],
        kind: 'broadcast',
        text: 'The implementation is ready.',
        timestamp: '2026-08-12T02:29:56.000Z',
      },
    ]
    const base = props({
      snapshots: [current],
      selectedIndex: 0,
      snapshot: current,
      previousSnapshot: undefined,
    })
    const { rerender } = render(<AgentTeamsCanvas {...base} activeMessageId="lead-broadcast" />)

    expect(screen.getAllByTestId('agent-teams-active-flight')).toHaveLength(3)
    expect(screen.getAllByTestId('agent-teams-active-flight').map(element => (
      element.getAttribute('data-flight-channel')
    ))).toEqual(['lead', 'lead', 'lead'])
    expect(screen.getAllByTestId('agent-teams-active-flight').every(element => (
      element.textContent?.includes('Assignments')
    ))).toBe(true)

    rerender(<AgentTeamsCanvas {...base} activeMessageId="worker-broadcast" />)
    expect(screen.getAllByTestId('agent-teams-active-flight')).toHaveLength(3)
    expect(screen.getAllByTestId('agent-teams-active-flight').map(element => (
      element.getAttribute('data-flight-channel')
    )).sort()).toEqual(['lead', 'peer', 'peer'])
    expect(screen.getAllByTestId('agent-teams-active-flight').every(element => (
      element.textContent?.includes('Reports')
    ))).toBe(true)
  })

  it('keeps external task focus until an internal card hover temporarily takes over', () => {
    const current = snapshot('current')
    current.tasks = [...current.tasks, task('5', 'pending', [], 'qa')]
    const base = props({
      snapshots: [current],
      selectedIndex: 0,
      snapshot: current,
      previousSnapshot: undefined,
      activeMessageId: null,
      focusedTaskId: '3',
    })
    render(<AgentTeamsCanvas {...base} />)

    const externalFocus = screen.getByTestId('agent-teams-canvas-task-3')
    const independentTask = screen.getByTestId('agent-teams-canvas-task-5')
    expect(externalFocus.getAttribute('data-chain-active')).toBe('true')
    expect(independentTask.style.opacity).toBe('0.34')

    fireEvent.mouseEnter(independentTask)
    expect(independentTask.getAttribute('data-chain-active')).toBe('true')
    expect(externalFocus.style.opacity).toBe('0.34')

    fireEvent.focus(independentTask)
    fireEvent.mouseLeave(independentTask)
    expect(independentTask.getAttribute('data-chain-active')).toBe('true')
    expect(externalFocus.style.opacity).toBe('0.34')

    fireEvent.blur(independentTask)
    expect(externalFocus.getAttribute('data-chain-active')).toBe('true')
    expect(independentTask.style.opacity).toBe('0.34')
  })

  it('draws every active member tether even when more than five workers are running', () => {
    const current = snapshot('current')
    const workers = Array.from({ length: 6 }, (_, index) => ({
      agentId: `worker-${index + 1}@canvas-team`,
      name: `worker-${index + 1}`,
      role: 'Reviewer',
      status: 'running' as const,
      activity: 'active' as const,
    }))
    current.team.members = [current.team.members[0]!, ...workers]
    current.tasks = workers.map((member, index) => task(
      String(index + 1),
      'in_progress',
      [],
      member.name,
    ))
    current.messages = []

    const { container } = render(<AgentTeamsCanvas {...props({
      snapshots: [current],
      selectedIndex: 0,
      snapshot: current,
      previousSnapshot: undefined,
      activeMessageId: null,
    })} />)

    expect(container.querySelectorAll('[data-testid^="agent-teams-canvas-member-worker-"]')).toHaveLength(6)
    expect(container.querySelectorAll('[data-testid^="agent-teams-canvas-tether-worker-"]')).toHaveLength(6)
  })

  it('hides indeterminate fill under reduced motion instead of implying a fixed percentage', () => {
    const css = readFileSync(join(__dirname, '../../theme/globals.css'), 'utf8')
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.agent-teams-task-running-fill\s*\{[^}]*opacity:\s*0;/,
    )
  })

  it('chips each member card with its model family and keeps the full id on hover', () => {
    const current = snapshot('current')
    const withModels: TeamWorkbenchSnapshot = {
      ...current,
      team: {
        ...current.team,
        members: current.team.members.map(member => (
          member.agentId === 'team-lead@canvas-team'
            ? { ...member, model: 'claude-opus-4-8' }
            : member.agentId === 'builder@canvas-team'
              ? { ...member, model: 'claude-sonnet-5' }
              : member
        )),
      },
    }

    render(<AgentTeamsCanvas {...props({
      snapshots: [withModels],
      selectedIndex: 0,
      snapshot: withModels,
      previousSnapshot: undefined,
      activeMessageId: null,
    })} />)

    // A member with its own model shows the short family, full id on hover.
    const builder = screen.getByTestId('agent-teams-canvas-member-model-builder@canvas-team')
    expect(builder.textContent).toBe('sonnet')
    expect(builder.getAttribute('title')).toBe('claude-sonnet-5')
    expect(builder.getAttribute('data-model-inherited')).toBe('false')

    // The lead shows its own model, and a member with none inherits it.
    const lead = screen.getByTestId('agent-teams-canvas-member-model-team-lead@canvas-team')
    expect(lead.textContent).toBe('opus')
    const reviewer = screen.getByTestId('agent-teams-canvas-member-model-reviewer@canvas-team')
    expect(reviewer.textContent).toBe('opus')
    expect(reviewer.getAttribute('data-model-inherited')).toBe('true')
  })

  it('renders no model chip at all when neither the member nor the lead has one', () => {
    render(<AgentTeamsCanvas {...props()} />)

    const builder = screen.queryByTestId('agent-teams-canvas-member-model-builder@canvas-team')
    expect(builder).toBeNull()
    const lead = screen.queryByTestId('agent-teams-canvas-member-model-team-lead@canvas-team')
    expect(lead).toBeNull()
  })
})
