import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionActivityPanel } from './SessionActivityPanel'
import type { SessionActivityModel } from './sessionActivityModel'

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string, params?: Record<string, string | number>) => {
    const translations: Record<string, string> = {
      'chat.backgroundTasks.type.agent': 'Agent',
      'chat.backgroundTasks.type.bash': 'Bash',
      'chat.backgroundTasks.type.workflow': 'Workflow',
      'chat.backgroundTasks.type.task': 'Task',
      'chat.backgroundAgents.status.running': 'running',
      'chat.backgroundAgents.status.completed': 'completed',
      'chat.backgroundAgents.status.failed': 'failed',
      'chat.backgroundAgents.status.stopped': 'stopped',
      'chat.backgroundAgents.tokens': '{count} tokens',
      'chat.duration.seconds': '{seconds}s',
      'chat.duration.minutesSeconds': '{minutes}m {seconds}s',
      'session.activity.title': 'Activity',
      'session.activity.close': 'Close activity',
      'session.activity.clearFinished': 'Clear finished',
      'session.activity.openTeamMember': 'Open team member {name}',
      'session.activity.openRun': 'Open run {name}',
      'session.activity.openBackgroundTask': 'Open background task {name}',
      'session.activity.stopBackgroundTask': 'Stop background task {name}',
      'session.activity.stoppingBackgroundTask': 'Stopping background task {name}',
      'session.activity.details.title': 'Details',
      'session.activity.details.type': 'Type',
      'session.activity.details.description': 'Description',
      'session.activity.details.summary': 'Summary',
      'session.activity.details.outputFile': 'Output file',
      'session.activity.details.usage': 'Usage',
      'session.activity.section.tasks': 'Tasks',
      'session.activity.section.team': 'Team',
      'session.activity.section.backgroundTasks': 'Background Tasks',
      'session.activity.section.subagents': 'SubAgents',
      'session.activity.section.sources': 'Sources',
      'session.activity.empty.tasks': 'No tasks',
      'session.activity.empty.team': 'No team members',
      'session.activity.empty.backgroundTasks': 'No background tasks',
      'session.activity.empty.subagents': 'No SubAgents',
      'session.activity.empty.sources': 'No sources',
      'session.activity.task.completed': 'Task completed',
      'session.activity.task.inProgress': 'Task in progress',
      'session.activity.task.pending': 'Task pending',
      'session.activity.tasks.earlier': 'Earlier tasks',
      'session.activity.tasks.earlierSummary': 'Earlier turns: {completed}/{total} completed',
      'session.activity.status.pending': 'Pending',
      'session.activity.status.inProgress': 'In progress',
      'session.activity.status.completed': 'Completed',
      'session.activity.status.running': 'Running',
      'session.activity.status.failed': 'Failed',
      'session.activity.status.stopped': 'Stopped',
      'session.activity.status.idle': 'Idle',
      'session.activity.status.error': 'Error',
    }

    let text = translations[key] ?? key
    if (params) {
      for (const [paramKey, paramValue] of Object.entries(params)) {
        text = text.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(paramValue))
      }
    }
    return text
  },
}))

function model(overrides: Partial<SessionActivityModel> = {}): SessionActivityModel {
  return {
    sessionId: 'session-1',
    badgeCount: 1,
    sections: {
      output: { id: 'output', title: 'Output', emptyLabel: 'No output', rows: [] },
      tasks: {
        id: 'tasks',
        title: 'Tasks',
        emptyLabel: 'No tasks',
        rows: [{
          id: 'task-1',
          section: 'tasks',
          label: 'Write tests',
          status: 'in_progress',
          description: 'Add panel coverage',
          openable: false,
        }],
      },
      team: { id: 'team', title: 'Team', emptyLabel: 'No team members', rows: [] },
      backgroundTasks: { id: 'backgroundTasks', title: 'Background Tasks', emptyLabel: 'No background tasks', rows: [] },
      subagents: {
        id: 'subagents',
        title: 'SubAgents',
        emptyLabel: 'No SubAgents',
        rows: [{ id: 'tool-1', section: 'subagents', label: 'Kuhn', status: 'running', toolUseId: 'tool-1', openable: true }],
      },
      sources: { id: 'sources', title: 'Sources', emptyLabel: 'No sources', rows: [] },
    },
    ...overrides,
  }
}

describe('SessionActivityPanel', () => {
  afterEach(cleanup)

  it('renders populated tasks section without empty visible section labels', () => {
    render(
      <SessionActivityPanel
        model={model({
          sections: {
            ...model().sections,
            subagents: { id: 'subagents', title: 'SubAgents', emptyLabel: 'No SubAgents', rows: [] },
          },
        })}
        open
        onClose={vi.fn()}
        onOpenSubagent={vi.fn()}
      />,
    )

    expect(screen.getByRole('dialog', { name: /activity/i })).toBeInTheDocument()
    expect(screen.queryByText('Output')).not.toBeInTheDocument()
    expect(screen.getByText('Tasks')).toBeInTheDocument()
    expect(screen.getByText('Write tests')).toHaveAttribute('title', 'Write tests')
    expect(screen.getByText('Add panel coverage')).toHaveAttribute('title', 'Add panel coverage')
    expect(screen.getByLabelText('Task in progress')).toBeInTheDocument()
    expect(screen.queryByText('In progress')).not.toBeInTheDocument()
    expect(screen.queryByText('Team')).not.toBeInTheDocument()
    expect(screen.queryByText('Background Tasks')).not.toBeInTheDocument()
    expect(screen.queryByText('SubAgents')).not.toBeInTheDocument()
    expect(screen.queryByText('Sources')).not.toBeInTheDocument()
    expect(screen.queryByText('No team members')).not.toBeInTheDocument()
    expect(screen.queryByText('No background tasks')).not.toBeInTheDocument()
    expect(screen.queryByText('No SubAgents')).not.toBeInTheDocument()
    expect(screen.queryByText('No sources')).not.toBeInTheDocument()
  })

  it('renders task rows as checklist markers instead of status chips', () => {
    render(
      <SessionActivityPanel
        model={model({
          sections: {
            ...model().sections,
            tasks: {
              id: 'tasks',
              title: 'Tasks',
              emptyLabel: 'No tasks',
              rows: [
                { id: 'done', section: 'tasks', label: 'Finished task', status: 'completed', openable: false },
                { id: 'active', section: 'tasks', label: 'Active task', status: 'in_progress', openable: false },
                { id: 'next', section: 'tasks', label: 'Next task', status: 'pending', openable: false },
              ],
            },
          },
        })}
        open
        onClose={vi.fn()}
        onOpenSubagent={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('Task completed')).toBeInTheDocument()
    expect(screen.getByLabelText('Task in progress')).toBeInTheDocument()
    expect(screen.getByLabelText('Task pending')).toBeInTheDocument()
    expect(screen.getByLabelText('Task in progress').querySelector('svg')).toHaveClass('motion-safe:animate-spin')
    expect(screen.getByText('Active task').closest('button,div')).toHaveClass('py-2.5')
    expect(screen.queryByText('Completed')).not.toBeInTheDocument()
    expect(screen.queryByText('Pending')).not.toBeInTheDocument()
  })

  it('renders earlier task history as a localized compact checklist row', () => {
    render(
      <SessionActivityPanel
        model={model({
          sections: {
            ...model().sections,
            tasks: {
              id: 'tasks',
              title: 'Tasks',
              emptyLabel: 'No tasks',
              rows: [
                { id: 'current', section: 'tasks', label: 'Implement current turn', status: 'in_progress', openable: false },
                {
                  id: 'history',
                  section: 'tasks',
                  label: 'Earlier tasks',
                  status: 'completed',
                  taskHistory: { completed: 3, total: 3, turnCount: 1 },
                  openable: false,
                },
              ],
            },
          },
        })}
        open
        onClose={vi.fn()}
        onOpenSubagent={vi.fn()}
      />,
    )

    expect(screen.getByText('Earlier tasks')).toBeInTheDocument()
    expect(screen.getByText('Earlier turns: 3/3 completed')).toBeInTheDocument()
    expect(screen.getAllByLabelText('Task completed')).toHaveLength(1)
  })

  it('clears visible finished background task keys without showing preview details', () => {
    const onClearFinishedBackgroundTasks = vi.fn()
    render(
      <SessionActivityPanel
        model={model({
          sections: {
            ...model().sections,
            backgroundTasks: {
              id: 'backgroundTasks',
              title: 'Background Tasks',
              emptyLabel: 'No background tasks',
              rows: [{
                id: 'bash-tool-1',
                section: 'backgroundTasks',
                label: 'Run smoke checks',
                status: 'completed',
                description: '# Markdown preview should stay in details',
                summary: 'Task completed with a long markdown report',
                toolUseId: 'bash-tool-1',
                taskId: 'bash-task-1',
                taskType: 'local_bash',
                dismissKey: 'bash-task-1:completed:1000',
                usage: { totalTokens: 94321, durationMs: 67000 },
                openable: true,
              }],
            },
          },
        })}
        open
        onClose={vi.fn()}
        onOpenSubagent={vi.fn()}
        onClearFinishedBackgroundTasks={onClearFinishedBackgroundTasks}
      />,
    )

    expect(screen.getByText('Run smoke checks')).toBeInTheDocument()
    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(screen.queryByText('# Markdown preview should stay in details')).not.toBeInTheDocument()
    expect(screen.queryByText('Task completed with a long markdown report')).not.toBeInTheDocument()
    expect(screen.queryByText('94.3k tokens')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /open background task run smoke checks/i }))

    expect(screen.getByText('Details')).toBeInTheDocument()
    expect(screen.getByText('Description')).toBeInTheDocument()
    expect(screen.getByText('# Markdown preview should stay in details')).toBeInTheDocument()
    expect(screen.getByText('Summary')).toBeInTheDocument()
    expect(screen.getByText('Task completed with a long markdown report')).toBeInTheDocument()
    expect(screen.getByText('Usage')).toBeInTheDocument()
    expect(screen.getByText('94.3k tokens · 1m 7s')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /clear finished/i }))

    expect(onClearFinishedBackgroundTasks).toHaveBeenCalledWith(['bash-task-1:completed:1000'])
  })

  it('stops running background tasks and disables repeat requests while stopping', () => {
    const onStopBackgroundTask = vi.fn()
    const runningModel = model({
      sections: {
        ...model().sections,
        tasks: { id: 'tasks', title: 'Tasks', emptyLabel: 'No tasks', rows: [] },
        subagents: { id: 'subagents', title: 'SubAgents', emptyLabel: 'No SubAgents', rows: [] },
        backgroundTasks: {
          id: 'backgroundTasks',
          title: 'Background Tasks',
          emptyLabel: 'No background tasks',
          rows: [{
            id: 'bash-task-1',
            section: 'backgroundTasks',
            label: 'Sleep for 300 seconds',
            status: 'running',
            taskId: 'bash-task-1',
            taskType: 'local_bash',
            openable: true,
          }],
        },
      },
    })

    const { rerender } = render(
      <SessionActivityPanel
        model={runningModel}
        open
        onClose={vi.fn()}
        onOpenSubagent={vi.fn()}
        onStopBackgroundTask={onStopBackgroundTask}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Stop background task Sleep for 300 seconds' }))
    expect(onStopBackgroundTask).toHaveBeenCalledWith('bash-task-1')

    rerender(
      <SessionActivityPanel
        model={runningModel}
        open
        onClose={vi.fn()}
        onOpenSubagent={vi.fn()}
        onStopBackgroundTask={onStopBackgroundTask}
        stoppingBackgroundTaskIds={{ 'bash-task-1': true }}
      />,
    )

    expect(screen.getByRole('button', { name: 'Stopping background task Sleep for 300 seconds' })).toBeDisabled()
  })

  it('offers the same stop control for a running background SubAgent', () => {
    const onStopBackgroundTask = vi.fn()
    render(
      <SessionActivityPanel
        model={model({
          sections: {
            ...model().sections,
            tasks: { id: 'tasks', title: 'Tasks', emptyLabel: 'No tasks', rows: [] },
            subagents: {
              id: 'subagents',
              title: 'SubAgents',
              emptyLabel: 'No SubAgents',
              rows: [{
                id: 'agent-task-1',
                section: 'subagents',
                label: 'Background reviewer',
                status: 'running',
                taskId: 'agent-task-1',
                toolUseId: 'agent-tool-1',
                openable: true,
              }],
            },
          },
        })}
        open
        onClose={vi.fn()}
        onOpenSubagent={vi.fn()}
        onStopBackgroundTask={onStopBackgroundTask}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Stop background task Background reviewer' }))
    expect(onStopBackgroundTask).toHaveBeenCalledWith('agent-task-1')
  })

  it('keeps SubAgent rows to name and status instead of result previews', () => {
    render(
      <SessionActivityPanel
        model={model({
          sections: {
            ...model().sections,
            subagents: {
              id: 'subagents',
              title: 'SubAgents',
              emptyLabel: 'No SubAgents',
              rows: [{
                id: 'agent-tool-1',
                section: 'subagents',
                label: 'Security reviewer',
                status: 'completed',
                summary: '## Security findings\\nNo blocking issue.',
                toolUseId: 'agent-tool-1',
                openable: true,
              }],
            },
          },
        })}
        open
        onClose={vi.fn()}
        onOpenSubagent={vi.fn()}
      />,
    )

    expect(screen.getByText('Security reviewer')).toBeInTheDocument()
    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(screen.queryByText(/Security findings/)).not.toBeInTheDocument()
    expect(screen.queryByText('No blocking issue.')).not.toBeInTheDocument()
  })

  it('animates running SubAgent rows with a compact reduced-motion-safe live marker', () => {
    render(<SessionActivityPanel model={model()} open onClose={vi.fn()} onOpenSubagent={vi.fn()} />)

    const row = screen.getByRole('button', { name: /open run kuhn.*running/i })
    const mascot = within(row).getByTestId('agent-mascot')
    const motionRing = within(row).getByTestId('agent-mascot-motion-ring')

    expect(row).toHaveTextContent('Running')
    expect(mascot).toHaveAttribute('aria-hidden', 'true')
    expect(mascot).toHaveAttribute('data-agent-mascot-state', 'running')
    expect(mascot).toHaveAttribute('data-agent-mascot-motion', 'active')
    expect(mascot).toHaveAttribute('data-agent-mascot-tone', 'accent')
    expect(mascot).toHaveAttribute('data-agent-mascot-variant')
    expect(motionRing).toBeInTheDocument()
    expect(motionRing).toHaveClass('motion-safe:animate-spin')
    expect(motionRing).toHaveClass('motion-reduce:animate-none')
    expect(row.querySelector('.animate-pulse-dot')).not.toBeInTheDocument()
    expect(row.querySelector('.animate-spin')).not.toBeInTheDocument()
    expect(row.querySelector('.animate-ping')).not.toBeInTheDocument()
  })

  it('keeps Agent mascot variants stable for the same SubAgent seed', () => {
    const repeatedAgentModel = model({
      sections: {
        ...model().sections,
        subagents: {
          id: 'subagents',
          title: 'SubAgents',
          emptyLabel: 'No SubAgents',
          rows: [
            {
              id: 'agent-a-first-render',
              section: 'subagents',
              label: 'Reviewer A',
              status: 'running',
              toolUseId: 'stable-agent-tool',
              openable: true,
            },
            {
              id: 'agent-a-second-render',
              section: 'subagents',
              label: 'Reviewer A again',
              status: 'completed',
              toolUseId: 'stable-agent-tool',
              openable: true,
            },
          ],
        },
      },
    })

    render(
      <SessionActivityPanel
        model={repeatedAgentModel}
        open
        onClose={vi.fn()}
        onOpenSubagent={vi.fn()}
      />,
    )

    const mascots = screen.getAllByTestId('agent-mascot')

    expect(mascots).toHaveLength(2)
    expect(mascots[0]).toHaveAttribute(
      'data-agent-mascot-variant',
      mascots[1]?.getAttribute('data-agent-mascot-variant') ?? '',
    )
  })

  it('opens a compact team member row', () => {
    const onOpenMember = vi.fn()
    const member = {
      agentId: 'security-reviewer@test-team',
      role: 'security-reviewer',
      status: 'running' as const,
      currentTask: 'Auditing auth flow',
    }

    render(
      <SessionActivityPanel
        model={model({
          sections: {
            ...model().sections,
            team: {
              id: 'team',
              title: 'Team',
              emptyLabel: 'No team members',
              rows: [{
                id: member.agentId,
                section: 'team',
                label: member.role,
                status: member.status,
                description: member.currentTask,
                member,
                openable: true,
              }],
            },
          },
        })}
        open
        onClose={vi.fn()}
        onOpenSubagent={vi.fn()}
        onOpenMember={onOpenMember}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /open team member security-reviewer/i }))

    expect(screen.getByText('security-reviewer')).toBeInTheDocument()
    expect(screen.queryByText('Auditing auth flow')).not.toBeInTheDocument()
    expect(onOpenMember).toHaveBeenCalledWith(member)
  })

  it('closes from the close button and Escape', () => {
    const onClose = vi.fn()
    render(<SessionActivityPanel model={model()} open onClose={onClose} onOpenSubagent={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /close activity/i }))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('closes on outside pointerdown', () => {
    const onClose = vi.fn()
    render(
      <>
        <button type="button">Outside</button>
        <SessionActivityPanel model={model()} open onClose={onClose} onOpenSubagent={vi.fn()} />
      </>,
    )

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps open when pointerdown starts from the activity trigger', () => {
    const onClose = vi.fn()
    render(
      <>
        <button type="button" data-session-activity-trigger="true">
          <span>Activity trigger icon</span>
        </button>
        <SessionActivityPanel model={model()} open onClose={onClose} onOpenSubagent={vi.fn()} />
      </>,
    )

    fireEvent.pointerDown(screen.getByText('Activity trigger icon'))

    expect(onClose).not.toHaveBeenCalled()
  })

  it('renders as a rail without closing on outside pointerdown', () => {
    const onClose = vi.fn()
    render(
      <>
        <button type="button">Outside</button>
        <SessionActivityPanel
          model={model()}
          open
          onClose={onClose}
          onOpenSubagent={vi.fn()}
          placement="rail"
        />
      </>,
    )

    expect(screen.getByTestId('session-activity-panel')).toHaveAttribute('data-placement', 'rail')
    expect(screen.getByTestId('session-activity-panel')).toHaveClass('my-4')
    expect(screen.getByTestId('session-activity-panel')).toHaveClass('mr-3')
    expect(screen.getByTestId('session-activity-panel')).toHaveClass('w-[336px]')
    expect(screen.getByTestId('session-activity-panel')).toHaveClass('rounded-[22px]')
    expect(screen.getByTestId('session-activity-panel')).toHaveClass('self-start')
    expect(screen.getByTestId('session-activity-panel')).toHaveClass('max-h-[min(620px,calc(100vh-72px))]')
    expect(screen.getByTestId('session-activity-panel')).not.toHaveClass('h-[calc(100%-24px)]')
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }))

    expect(onClose).not.toHaveBeenCalled()
  })

  it('uses one polished scroll owner instead of nested section scrollbars', () => {
    const taskRows = Array.from({ length: 12 }, (_, index) => ({
      id: `task-${index + 1}`,
      section: 'tasks' as const,
      label: `Task ${index + 1}`,
      status: 'pending' as const,
      openable: false,
    }))
    const teamRows = Array.from({ length: 8 }, (_, index) => ({
      id: `member-${index + 1}`,
      section: 'team' as const,
      label: `Reviewer ${index + 1}`,
      status: 'running' as const,
      openable: false,
    }))
    const backgroundRows = Array.from({ length: 8 }, (_, index) => ({
      id: `background-${index + 1}`,
      section: 'backgroundTasks' as const,
      label: `Background ${index + 1}`,
      status: 'running' as const,
      openable: false,
    }))
    const subagentRows = Array.from({ length: 8 }, (_, index) => ({
      id: `subagent-${index + 1}`,
      section: 'subagents' as const,
      label: `SubAgent ${index + 1}`,
      status: 'running' as const,
      openable: false,
    }))

    render(
      <SessionActivityPanel
        model={model({
          sections: {
            ...model().sections,
            tasks: { id: 'tasks', title: 'Tasks', emptyLabel: 'No tasks', rows: taskRows },
            team: { id: 'team', title: 'Team', emptyLabel: 'No team members', rows: teamRows },
            backgroundTasks: {
              id: 'backgroundTasks',
              title: 'Background Tasks',
              emptyLabel: 'No background tasks',
              rows: backgroundRows,
            },
            subagents: { id: 'subagents', title: 'SubAgents', emptyLabel: 'No SubAgents', rows: subagentRows },
          },
        })}
        open
        onClose={vi.fn()}
        onOpenSubagent={vi.fn()}
        placement="rail"
      />,
    )

    const scrollOwner = screen.getByTestId('session-activity-scroll')
    const tasksSection = document.querySelector('section[aria-label="Tasks"]')
    const teamSection = document.querySelector('section[aria-label="Team"]')
    const backgroundSection = document.querySelector('section[aria-label="Background Tasks"]')
    const subagentsSection = document.querySelector('section[aria-label="SubAgents"]')

    expect(scrollOwner).toHaveClass('overflow-y-auto')
    expect(scrollOwner).toHaveClass('[scrollbar-width:auto]')
    expect(scrollOwner).toHaveClass('[&::-webkit-scrollbar]:w-2.5')
    expect(tasksSection?.querySelector('.overflow-y-auto')).not.toBeInTheDocument()
    expect(teamSection?.querySelector('.overflow-y-auto')).not.toBeInTheDocument()
    expect(backgroundSection?.querySelector('.overflow-y-auto')).not.toBeInTheDocument()
    expect(subagentsSection?.querySelector('.overflow-y-auto')).not.toBeInTheDocument()
  })

  it('opens a SubAgent row when the row is openable', () => {
    const onOpenSubagent = vi.fn()
    render(<SessionActivityPanel model={model()} open onClose={vi.fn()} onOpenSubagent={onOpenSubagent} />)

    fireEvent.click(screen.getByRole('button', { name: /open run kuhn/i }))

    expect(onOpenSubagent).toHaveBeenCalledWith({
      sessionId: 'session-1',
      toolUseId: 'tool-1',
      title: 'Kuhn',
    })
  })

  it('does not open SubAgent rows without a tool use id', () => {
    const onOpenSubagent = vi.fn()
    render(
      <SessionActivityPanel
        model={model({
          sections: {
            ...model().sections,
            subagents: {
              id: 'subagents',
              title: 'SubAgents',
              emptyLabel: 'No SubAgents',
              rows: [{ id: 'agent-no-tool', section: 'subagents', label: 'Local agent', status: 'failed', openable: true }],
            },
          },
        })}
        open
        onClose={vi.fn()}
        onOpenSubagent={onOpenSubagent}
      />,
    )

    expect(screen.queryByRole('button', { name: /open run local agent/i })).not.toBeInTheDocument()
    expect(screen.getByText('Local agent')).toBeInTheDocument()
    expect(onOpenSubagent).not.toHaveBeenCalled()
  })

  it('does not render when closed', () => {
    render(<SessionActivityPanel model={model()} open={false} onClose={vi.fn()} onOpenSubagent={vi.fn()} />)

    expect(screen.queryByRole('dialog', { name: /activity/i })).not.toBeInTheDocument()
  })
})
