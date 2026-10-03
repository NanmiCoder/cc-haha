import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentTeamsMemberInspector } from '@/components/agentTeams/AgentTeamsMemberInspector'
import { formatWorkbenchMessageTime } from '@/components/agentTeams/agentTeamsModel'
import { useSettingsStore } from '@/stores/settingsStore'
import type {
  TeamMember,
  TeamWorkbenchMessage,
  TeamWorkbenchSnapshot,
  TeamWorkbenchTask,
} from '@/types/team'

const builder: TeamMember = {
  agentId: 'builder@team-a',
  name: 'builder',
  role: 'server engineer',
  status: 'running',
  activity: 'idle',
}

const reviewer: TeamMember = {
  agentId: 'reviewer@team-a',
  name: 'reviewer',
  role: 'qa engineer',
  status: 'running',
  activity: 'active',
}

function task(status: TeamWorkbenchTask['status']): TeamWorkbenchTask {
  return {
    id: '7',
    subject: 'Build API routes',
    description: '',
    owner: 'builder',
    status,
    blocks: [],
    blockedBy: [],
    taskListId: 'team-a',
  }
}

function message(overrides: Partial<TeamWorkbenchMessage> & { id: string }): TeamWorkbenchMessage {
  return {
    from: 'builder',
    to: 'reviewer',
    recipients: ['reviewer'],
    kind: 'direct',
    text: 'body',
    timestamp: '2026-08-08T07:10:00.000Z',
    ...overrides,
  }
}

function snapshot(
  generatedAt: string,
  status: TeamWorkbenchTask['status'],
  messages: TeamWorkbenchMessage[] = [],
): TeamWorkbenchSnapshot {
  return {
    version: 'v1',
    generatedAt,
    team: {
      name: 'team-a',
      leadAgentId: 'lead@team-a',
      leadSessionId: 'lead-session',
      members: [builder, reviewer],
    },
    tasks: [task(status)],
    messages,
  }
}

function renderInspector(options: {
  snapshots?: TeamWorkbenchSnapshot[]
  selectedIndex?: number
  snapshot?: TeamWorkbenchSnapshot
  onBack?: () => void
  onClose?: () => void
  onOpenExecution?: () => void
} = {}) {
  const snapshots = options.snapshots ?? [snapshot('2026-08-08T07:00:00.000Z', 'pending')]
  const selectedIndex = options.selectedIndex ?? snapshots.length - 1
  const selected = options.snapshot ?? snapshots[selectedIndex]!
  return render(
    <AgentTeamsMemberInspector
      snapshots={snapshots}
      selectedIndex={selectedIndex}
      snapshot={selected}
      member={builder}
      isLead={false}
      leadIsStreaming={false}
      onBack={options.onBack ?? vi.fn()}
      onClose={options.onClose ?? vi.fn()}
      onOpenExecution={options.onOpenExecution ?? vi.fn()}
    />,
  )
}

describe('AgentTeamsMemberInspector', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('points members with no team messages to their execution progress', () => {
    const onOpenExecution = vi.fn()
    renderInspector({ onOpenExecution })
    expect(screen.getByText(/Approved tasks are delivered directly; use the execution button below/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /execution/i }))
    expect(onOpenExecution).toHaveBeenCalledOnce()
  })

  it('derives the first start and elapsed duration from task state transitions', () => {
    const snapshots = [
      snapshot('2026-08-08T07:00:00.000Z', 'pending'),
      snapshot('2026-08-08T07:05:00.000Z', 'in_progress'),
      snapshot('2026-08-08T07:12:00.000Z', 'completed'),
    ]
    renderInspector({ snapshots })

    const row = screen.getByTestId('agent-teams-member-task-7')
    const expectedStart = formatWorkbenchMessageTime('2026-08-08T07:05:00.000Z')
    expect(row.textContent).toContain('#7')
    expect(row.textContent).toContain('Build API routes')
    expect(row.textContent).toContain('Completed')
    expect(row.textContent).toContain(`${expectedStart} +7:00`)
    expect(row.getAttribute('data-task-state')).toBe('completed')
    expect(screen.getByText('1', { selector: 'dd' })).toBeTruthy()
  })

  it('shows message direction, renders human Markdown, and narrates protocol payloads', () => {
    const messages = [
      message({
        id: 'human',
        text: '## Finding A\n\n**Key evidence**',
      }),
      message({
        id: 'protocol',
        from: 'reviewer',
        to: 'builder',
        recipients: ['builder'],
        kind: 'system',
        protocolType: 'idle_notification',
        text: '{"type":"idle_notification","idleReason":"available"}',
        timestamp: '2026-08-08T07:11:00.000Z',
      }),
    ]
    const selected = snapshot('2026-08-08T07:12:00.000Z', 'in_progress', messages)
    renderInspector({ snapshots: [selected] })

    const human = screen.getByTestId('agent-teams-member-message-human')
    expect(human.getAttribute('data-message-direction')).toBe('sent')
    expect(human.textContent).toContain('Sent')
    expect(human.textContent).toContain('reviewer')
    expect(human.querySelector('h2')?.textContent).toBe('Finding A')
    expect(human.querySelector('strong')?.textContent).toBe('Key evidence')

    const protocol = screen.getByTestId('agent-teams-member-message-protocol')
    expect(protocol.getAttribute('data-message-direction')).toBe('received')
    expect(protocol.getAttribute('data-message-body')).toBe('lifecycle')
    expect(protocol.className).toContain('color-tertiary')
    expect(protocol.textContent).toContain('Received')
    expect(protocol.textContent).toContain('Went idle, waiting for work · available')
    expect(protocol.textContent).not.toContain('idle_notification')
  })

  it('calls back for the feed, close control, and explicit execution handoff', () => {
    const onBack = vi.fn()
    const onClose = vi.fn()
    const onOpenExecution = vi.fn()
    renderInspector({ onBack, onClose, onOpenExecution })

    fireEvent.click(screen.getByRole('button', { name: 'Back to communication' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close communication panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'View builder execution' }))

    expect(onBack).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onOpenExecution).toHaveBeenCalledTimes(1)
  })

  it('reports the model a teammate runs on, and flags one that inherits the lead', () => {
    const lead: TeamMember = {
      agentId: 'lead@team-a',
      name: 'lead',
      role: 'Lead',
      status: 'running',
      model: 'claude-opus-4-8',
    }
    const base = snapshot('2026-08-08T07:00:00.000Z', 'pending')
    const withLead: TeamWorkbenchSnapshot = {
      ...base,
      team: { ...base.team, members: [lead, builder, reviewer] },
    }
    const renderMember = (member: TeamMember) => render(
      <AgentTeamsMemberInspector
        snapshots={[withLead]}
        selectedIndex={0}
        snapshot={withLead}
        member={member}
        isLead={false}
        leadIsStreaming={false}
        onBack={vi.fn()}
        onClose={vi.fn()}
        onOpenExecution={vi.fn()}
      />,
    )

    // A teammate with its own model shows the full id, not the short family.
    const own = renderMember({ ...builder, model: 'claude-haiku-4-5' })
    const ownCell = screen.getByTestId('agent-teams-member-model')
    expect(ownCell.textContent).toBe('claude-haiku-4-5')
    expect(ownCell.getAttribute('data-model-inherited')).toBe('false')
    own.unmount()

    // One with no model of its own names where the model comes from.
    renderMember({ ...builder })
    const inheritedCell = screen.getByTestId('agent-teams-member-model')
    expect(inheritedCell.textContent).toBe('Inherit from lead · claude-opus-4-8')
    expect(inheritedCell.getAttribute('data-model-inherited')).toBe('true')
  })

  it('shows the actual provider snapshot alongside its model', () => {
    const frame = snapshot('2026-08-08T07:00:00.000Z', 'pending')
    render(<AgentTeamsMemberInspector
      snapshots={[frame]} selectedIndex={0} snapshot={frame}
      member={{ ...builder, model: 'same-model-id', providerId: 'saved-provider', providerName: 'Execution provider' }}
      isLead={false} leadIsStreaming={false} onBack={vi.fn()} onClose={vi.fn()} onOpenExecution={vi.fn()}
    />)
    expect(screen.getByTestId('agent-teams-member-provider').textContent).toBe('Execution provider')
    expect(screen.getByTestId('agent-teams-member-model').textContent).toBe('same-model-id')
  })

  it('never leaves the model cell blank when nothing is known', () => {
    renderInspector()

    const cell = screen.getByTestId('agent-teams-member-model')
    expect(cell.textContent).toBe('Unknown')
    expect(cell.textContent).not.toContain('undefined')
  })

  describe('recovery states', () => {
    const now = Date.parse('2026-08-08T07:00:00.000Z')

    function renderMember(member: TeamMember, clock?: number) {
      const base = snapshot('2026-08-08T07:00:00.000Z', 'in_progress')
      const frame: TeamWorkbenchSnapshot = {
        ...base,
        team: { ...base.team, members: [member, reviewer] },
      }
      return render(
        <AgentTeamsMemberInspector
          snapshots={[frame]}
          selectedIndex={0}
          snapshot={frame}
          member={member}
          isLead={false}
          leadIsStreaming={false}
          now={clock}
          onBack={vi.fn()}
          onClose={vi.fn()}
          onOpenExecution={vi.fn()}
        />,
      )
    }

    it('says a stopped member resumes from its saved conversation when messaged', () => {
      const onOpenExecution = vi.fn()
      const frame = snapshot('2026-08-08T07:00:00.000Z', 'in_progress')
      const stopped: TeamMember = { ...builder, status: 'idle', activity: 'stopped' }
      render(
        <AgentTeamsMemberInspector
          snapshots={[frame]}
          selectedIndex={0}
          snapshot={frame}
          member={stopped}
          isLead={false}
          leadIsStreaming={false}
          onBack={vi.fn()}
          onClose={vi.fn()}
          onOpenExecution={onOpenExecution}
        />,
      )

      expect(screen.getByText('Stopped')).toBeTruthy()
      const notice = screen.getByTestId('agent-teams-member-recovery')
      expect(notice.getAttribute('data-member-state')).toBe('stopped')
      expect(screen.getByTestId('agent-teams-member-recovery-hint').textContent)
        .toBe('Send a message to resume it from its saved conversation')
      expect(screen.queryByTestId('agent-teams-member-last-error')).toBeNull()

      // The way back is the member's own conversation, where the composer lives.
      const execution = screen.getByRole('button', { name: 'View builder execution' }) as HTMLButtonElement
      expect(execution.disabled).toBe(false)
      fireEvent.click(execution)
      expect(onOpenExecution).toHaveBeenCalledOnce()
    })

    it('counts down to the next automatic retry and names the failure behind it', () => {
      const retrying: TeamMember = {
        ...builder,
        status: 'idle',
        activity: 'idle',
        lastError: 'API Error: 529 overloaded',
        autoRetry: { attempt: 2, max: 5, nextAt: now + 45_000 },
      }
      const view = renderMember(retrying, now)

      expect(screen.getByText('Auto-retry 2/5')).toBeTruthy()
      expect(screen.getByTestId('agent-teams-member-recovery').getAttribute('data-member-state'))
        .toBe('retrying')
      expect(screen.getByTestId('agent-teams-member-last-error').textContent)
        .toBe('API Error: 529 overloaded')
      expect(screen.getByTestId('agent-teams-member-recovery-hint').textContent)
        .toBe('Retrying automatically in 45s')

      view.rerender(
        <AgentTeamsMemberInspector
          snapshots={[]}
          selectedIndex={0}
          snapshot={snapshot('2026-08-08T07:00:00.000Z', 'in_progress')}
          member={{ ...retrying, autoRetry: { attempt: 3, max: 5, nextAt: now + 125_000 } }}
          isLead={false}
          leadIsStreaming={false}
          now={now}
          onBack={vi.fn()}
          onClose={vi.fn()}
          onOpenExecution={vi.fn()}
        />,
      )
      expect(screen.getByTestId('agent-teams-member-recovery-hint').textContent)
        .toBe('Retrying automatically in about 2 min')
      view.unmount()

      // Past its schedule, the retry is due rather than counting negative.
      renderMember(retrying, now + 46_000)
      expect(screen.getByTestId('agent-teams-member-recovery-hint').textContent)
        .toBe('Retrying automatically now')
    })

    it('shows no countdown while replaying, where the present clock means nothing', () => {
      renderMember({
        ...builder,
        status: 'idle',
        activity: 'idle',
        lastError: 'API Error: 529 overloaded',
        autoRetry: { attempt: 1, max: 5, nextAt: now + 15_000 },
      })

      expect(screen.getByText('Auto-retry 1/5')).toBeTruthy()
      expect(screen.getByTestId('agent-teams-member-last-error').textContent)
        .toBe('API Error: 529 overloaded')
      expect(screen.queryByTestId('agent-teams-member-recovery-hint')).toBeNull()
    })

    it('keeps a long failure reason on one line with the full text on hover', () => {
      const reason = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 215000 tokens > 200000 maximum"}}'
      renderMember({ ...builder, status: 'error', activity: 'idle', lastError: reason })

      expect(screen.getByText('Error')).toBeTruthy()
      expect(screen.getByTestId('agent-teams-member-recovery').getAttribute('data-member-state'))
        .toBe('error')
      const lastError = screen.getByTestId('agent-teams-member-last-error')
      expect(lastError.textContent).toBe(reason)
      expect(lastError.getAttribute('title')).toBe(reason)
      expect(lastError.className).toContain('truncate')
      expect(screen.getByTestId('agent-teams-member-recovery-hint').textContent)
        .toBe('Once the problem is fixed, send a message to let it continue')
    })

    it('drops the failure notice while a failed member works its way back', () => {
      renderMember({ ...builder, status: 'error', activity: 'active', lastError: 'Credit balance is too low' })

      expect(screen.getByText('Executing #7')).toBeTruthy()
      expect(screen.queryByTestId('agent-teams-member-recovery')).toBeNull()
    })
  })
})
