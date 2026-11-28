import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BackgroundTasksIndicator } from './BackgroundTasksIndicator'
import { useTabStore } from '@/stores/tabStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useActivityPanelStore } from '@/stores/activityPanelStore'
import type { BackgroundAgentTask, UIMessage } from '@/types/chat'

vi.mock('@/i18n', () => ({
  useTranslation: () => (key: string, params?: Record<string, string | number>) => {
    if (key === 'chat.backgroundTasks.runningOne') return '1 task running'
    if (key === 'chat.backgroundTasks.runningMany') return `${params?.count} tasks running`
    if (key === 'session.activity.section.backgroundTasks') return 'Background Tasks'
    return key
  },
}))

const SESSION_ID = 'session-bg-indicator'

function makeTask(overrides: Partial<BackgroundAgentTask> & { taskId: string }): BackgroundAgentTask {
  return {
    status: 'running',
    taskType: 'local_bash',
    description: 'Watch GitHub CI checks for commit 7fae469c3',
    startedAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

describe('BackgroundTasksIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useWorkspaceStore.setState({ bySession: {} })
    useTabStore.setState({ activeTabId: SESSION_ID })
    useActivityPanelStore.getState().close(SESSION_ID)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders nothing when there are no running visible background tasks', () => {
    const { container } = render(
      <BackgroundTasksIndicator
        sessionId={SESSION_ID}
        backgroundTasks={{
          done: makeTask({ taskId: 'done', status: 'completed' }),
          dream: makeTask({ taskId: 'dream', taskType: 'dream' }),
          teammate: makeTask({ taskId: 'mate', taskType: 'in_process_teammate' }),
        }}
        messages={[]}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows count, opens hover card on mouse enter, and opens workspace tab on shell task click', () => {
    const messages: UIMessage[] = [
      {
        id: 'm1',
        type: 'tool_use',
        toolName: 'Bash',
        toolUseId: 'tool-ci',
        input: { command: 'gh pr checks 2047 --watch', run_in_background: true },
        timestamp: 900,
      },
    ]

    render(
      <BackgroundTasksIndicator
        sessionId={SESSION_ID}
        backgroundTasks={{
          ci: makeTask({ taskId: 'ci-1', toolUseId: 'tool-ci', description: 'Watch GitHub CI checks for commit 7fae' }),
        }}
        messages={messages}
      />,
    )

    const trigger = screen.getByTestId('background-tasks-indicator')
    expect(trigger).toHaveTextContent('1 task running')
    expect(screen.queryByTestId('background-tasks-popover')).not.toBeInTheDocument()

    fireEvent.mouseEnter(trigger)
    const popover = screen.getByTestId('background-tasks-popover')
    expect(popover).toHaveTextContent('Background Tasks')
    expect(popover).toHaveTextContent('Watch GitHub CI checks for commit 7fae')

    // Moving from trigger into popover keeps it open
    fireEvent.mouseLeave(trigger)
    fireEvent.mouseEnter(popover)
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(screen.getByTestId('background-tasks-popover')).toBeInTheDocument()

    // Clicking the shell task opens the right-hand workspace tab and closes popover
    fireEvent.click(screen.getByTestId('background-tasks-popover-item-ci-1'))
    expect(screen.queryByTestId('background-tasks-popover')).not.toBeInTheDocument()

    const workspace = useWorkspaceStore.getState().getSession(SESSION_ID)
    expect(workspace.layout).toBe('split')
    expect(workspace.tabs).toHaveLength(1)
    expect(workspace.tabs[0]).toMatchObject({
      kind: 'background-task',
      dock: 'side',
      taskId: 'ci-1',
      toolUseId: 'tool-ci',
      title: 'Watch GitHub CI checks for commit 7fae',
    })
  })

  it('routes subagent and workflow running tasks to their respective surfaces', () => {
    const onOpenAgentRun = vi.fn()
    render(
      <BackgroundTasksIndicator
        sessionId={SESSION_ID}
        backgroundTasks={{
          agent: makeTask({
            taskId: 'agent-1',
            taskType: 'local_agent',
            toolUseId: 'tool-agent',
            description: 'Explore repository',
            startedAt: 1000,
          }),
          wf: makeTask({
            taskId: 'wf-1',
            taskType: 'local_workflow',
            description: 'Nightly audit',
            startedAt: 2000,
          }),
        }}
        messages={[]}
        onOpenAgentRun={onOpenAgentRun}
      />,
    )

    const trigger = screen.getByTestId('background-tasks-indicator')
    expect(trigger).toHaveTextContent('2 tasks running')

    fireEvent.click(trigger)
    fireEvent.click(screen.getByTestId('background-tasks-popover-item-agent-1'))
    expect(onOpenAgentRun).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      taskId: 'agent-1',
      toolUseId: 'tool-agent',
      title: 'Explore repository',
    })

    fireEvent.click(trigger)
    fireEvent.click(screen.getByTestId('background-tasks-popover-item-wf-1'))
    expect(useActivityPanelStore.getState().isOpen(SESSION_ID)).toBe(true)
  })

  it('opens cleanly when clicking an unfocused trigger and uses V6C glass popover tokens', () => {
    render(
      <BackgroundTasksIndicator
        sessionId={SESSION_ID}
        backgroundTasks={{
          ci: makeTask({ taskId: 'ci-1', description: 'Watch CI' }),
        }}
        messages={[]}
      />,
    )

    const trigger = screen.getByTestId('background-tasks-indicator')
    expect(trigger).toHaveClass('rounded-[var(--radius-control)]')

    // Simulate clicking an unfocused trigger (pointerDown -> mouseDown -> focus -> click).
    // Previously `onFocus` opened the menu and `onClick` immediately toggled it back closed.
    fireEvent.pointerDown(trigger)
    fireEvent.mouseDown(trigger)
    fireEvent.focus(trigger)
    fireEvent.click(trigger)

    const popover = screen.getByTestId('background-tasks-popover')
    expect(popover).toHaveClass('dropdown-glass', 'popover-motion', 'z-[var(--z-dropdown)]', 'rounded-[var(--radius-xl)]', 'p-[5px]')
    expect(screen.getByText('Background Tasks')).toHaveClass('text-[11px]', 'font-semibold')
    expect(screen.getByTestId('background-tasks-popover-item-ci-1')).toHaveClass('rounded-[var(--radius-control)]')

    // Clicking again closes the popover.
    fireEvent.pointerDown(trigger)
    fireEvent.mouseDown(trigger)
    fireEvent.click(trigger)
    expect(screen.queryByTestId('background-tasks-popover')).not.toBeInTheDocument()

    // Keyboard focus without pointer interaction still opens the popover.
    fireEvent.focus(trigger)
    expect(screen.getByTestId('background-tasks-popover')).toBeInTheDocument()
  })
})
