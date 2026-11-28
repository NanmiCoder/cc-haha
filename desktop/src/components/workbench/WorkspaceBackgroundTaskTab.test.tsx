import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WorkspaceBackgroundTaskTab } from './WorkspaceBackgroundTaskTab'
import { sessionsApi } from '@/api/sessions'
import { ApiError } from '@/api/client'
import { useChatStore } from '@/stores/chatStore'
import type { WorkspaceBackgroundTaskTab as WorkspaceBackgroundTaskTabModel } from '@/lib/workspace/types'

vi.mock('@/i18n', () => ({
  useTranslation: () => (key: string, params?: Record<string, string | number>) => {
    const map: Record<string, string> = {
      'workspace.backgroundTask.header': 'Background Task Output',
      'workspace.backgroundTask.toggleWrap': 'Toggle word wrap',
      'workspace.backgroundTask.copyCommand': 'Copy command',
      'workspace.backgroundTask.loading': 'Loading output…',
      'workspace.backgroundTask.waitingForOutput': 'Waiting for output…',
      'workspace.backgroundTask.noOutput': 'No output available',
      'workspace.backgroundTask.loadFailed': 'Failed to load background task output',
      'workspace.backgroundTask.truncatedNotice': 'Showing the latest 64 KB of output',
      'workspace.backgroundTask.scrollToBottom': 'Scroll to bottom',
      'common.copied': 'Copied',
      'common.retry': 'Retry',
      'session.activity.stopBackgroundTask': `Stop ${params?.name ?? ''}`,
      'session.activity.stoppingBackgroundTask': `Stopping ${params?.name ?? ''}`,
    }
    return map[key] ?? key
  },
}))

const SESSION_ID = 'session-bg-tab'

const TAB: WorkspaceBackgroundTaskTabModel = {
  id: 'wt-bgtask-1',
  kind: 'background-task',
  dock: 'side',
  preview: false,
  createdAt: 1000,
  taskId: 'ci-task-1',
  toolUseId: 'tool-ci-1',
  title: 'Watch GitHub CI checks',
}

function seedChatSession(status: 'running' | 'completed' = 'running') {
  useChatStore.setState((state) => ({
    ...state,
    sessions: {
      ...state.sessions,
      [SESSION_ID]: {
        ...(state.sessions[SESSION_ID] ?? {}),
        messages: [
          {
            id: 'msg-1',
            type: 'tool_use',
            toolName: 'Bash',
            toolUseId: 'tool-ci-1',
            input: { command: 'gh pr checks 2047 --watch --interval 20', run_in_background: true },
            timestamp: 1000,
          },
        ],
        backgroundAgentTasks: {
          'ci-task-1': {
            taskId: 'ci-task-1',
            toolUseId: 'tool-ci-1',
            taskType: 'local_bash',
            description: 'Watch GitHub CI checks',
            status,
            startedAt: 1000,
            updatedAt: 1000,
          },
        },
        stoppingBackgroundTaskIds: {},
      } as unknown as (typeof state.sessions)[string],
    },
  }))
}

describe('WorkspaceBackgroundTaskTab', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    seedChatSession('running')
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('renders header, command banner, line-numbered output, and polls while running', async () => {
    const getOutput = vi
      .spyOn(sessionsApi, 'getBackgroundTaskOutput')
      .mockResolvedValueOnce({
        taskId: 'ci-task-1',
        state: 'available',
        text: 'line one\n\u001b[32mline two\u001b[0m\n',
        totalBytes: 24,
        truncated: false,
      })
      .mockResolvedValueOnce({
        taskId: 'ci-task-1',
        state: 'available',
        text: 'line one\nline two\nline three\n',
        totalBytes: 36,
        truncated: true,
      })

    render(<WorkspaceBackgroundTaskTab sessionId={SESSION_ID} tab={TAB} active />)

    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getByText('Background Task Output')).toBeInTheDocument()
    expect(screen.getByTestId('background-task-command')).toHaveTextContent('gh pr checks 2047 --watch --interval 20')
    expect(screen.getByTestId('background-task-output-lines')).toHaveTextContent('line one')
    expect(screen.getByTestId('background-task-output-lines')).toHaveTextContent('line two')
    expect(screen.queryByTestId('background-task-truncated')).not.toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(1000)
      await Promise.resolve()
    })

    expect(getOutput).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('background-task-output-lines')).toHaveTextContent('line three')
    expect(screen.getByTestId('background-task-truncated')).toHaveTextContent('Showing the latest 64 KB of output')

    // Word wrap toggle
    const wrapButton = screen.getByTestId('background-task-wrap-toggle')
    expect(wrapButton).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(wrapButton)
    expect(wrapButton).toHaveAttribute('aria-pressed', 'false')

    // Stop button calls chatStore.stopBackgroundTask
    const stopSpy = vi.fn()
    act(() => {
      useChatStore.setState({ stopBackgroundTask: stopSpy })
    })
    fireEvent.click(screen.getByTestId('background-task-stop'))
    expect(stopSpy).toHaveBeenCalledWith(SESSION_ID, 'ci-task-1')
  })

  it('treats transient 404 while running as waiting and recovers on subsequent poll', async () => {
    vi.spyOn(sessionsApi, 'getBackgroundTaskOutput')
      .mockRejectedValueOnce(new ApiError(404, 'Not found'))
      .mockResolvedValueOnce({
        taskId: 'ci-task-1',
        state: 'available',
        text: 'Server ready on :3000\n',
        totalBytes: 22,
        truncated: false,
      })

    render(<WorkspaceBackgroundTaskTab sessionId={SESSION_ID} tab={TAB} active />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(screen.getByTestId('background-task-output-empty')).toHaveTextContent('Waiting for output…')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(screen.getByTestId('background-task-output-lines')).toHaveTextContent('Server ready on :3000')
  })

  it('shows scroll-to-bottom button when scrolled away from bottom', async () => {
    vi.spyOn(sessionsApi, 'getBackgroundTaskOutput').mockResolvedValue({
      taskId: 'ci-task-1',
      state: 'available',
      text: Array.from({ length: 40 }, (_, i) => `output line ${i + 1}`).join('\n'),
      totalBytes: 600,
      truncated: false,
    })

    seedChatSession('completed')
    render(<WorkspaceBackgroundTaskTab sessionId={SESSION_ID} tab={TAB} active />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    const scroller = screen.getByTestId('background-task-output-scroll')
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
    scroller.scrollTop = 100

    fireEvent.scroll(scroller)
    const scrollBtn = screen.getByTestId('background-task-scroll-bottom')
    expect(scrollBtn).toBeInTheDocument()
    expect(scrollBtn).toHaveAccessibleName('Scroll to bottom')
    expect(scrollBtn).toHaveClass('dropdown-glass', 'popover-motion', 'rounded-[var(--radius-control)]')
    expect(scrollBtn).not.toHaveClass('rounded-full')

    fireEvent.click(scrollBtn)
    expect(scroller.scrollTop).toBe(1000)
    expect(screen.queryByTestId('background-task-scroll-bottom')).not.toBeInTheDocument()
  })

  it('uses IconButton loading state while stopping and ErrorState with retry on load failure', async () => {
    const getOutput = vi
      .spyOn(sessionsApi, 'getBackgroundTaskOutput')
      .mockRejectedValueOnce(new Error('Disk read failed'))
      .mockResolvedValueOnce({
        taskId: 'ci-task-1',
        state: 'available',
        text: 'recovered line\n',
        totalBytes: 15,
        truncated: false,
      })

    act(() => {
      useChatStore.setState((state) => ({
        ...state,
        sessions: {
          ...state.sessions,
          [SESSION_ID]: {
            ...state.sessions[SESSION_ID]!,
            stoppingBackgroundTaskIds: { 'ci-task-1': true },
          },
        },
      }))
    })

    render(<WorkspaceBackgroundTaskTab sessionId={SESSION_ID} tab={TAB} active />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    const stopButton = screen.getByTestId('background-task-stop')
    expect(stopButton).toBeDisabled()
    expect(stopButton).toHaveAttribute('aria-busy', 'true')

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Failed to load background task output')
    expect(alert).toHaveTextContent('Disk read failed')

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(getOutput).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('background-task-output-lines')).toHaveTextContent('recovered line')
  })
})
