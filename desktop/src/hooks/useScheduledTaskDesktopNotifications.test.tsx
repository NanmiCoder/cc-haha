import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { useScheduledTaskDesktopNotifications } from './useScheduledTaskDesktopNotifications'
import { useSettingsStore } from '../stores/settingsStore'

const { listMock, getRecentRunsMock, notifyDesktopMock, serverReadyMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  getRecentRunsMock: vi.fn(),
  notifyDesktopMock: vi.fn(),
  serverReadyMock: vi.fn(),
}))

vi.mock('../api/tasks', () => ({
  tasksApi: {
    list: listMock,
    getRecentRuns: getRecentRunsMock,
  },
}))

vi.mock('../lib/desktopNotifications', () => ({
  notifyDesktop: notifyDesktopMock,
}))

vi.mock('../lib/desktopRuntime', () => ({
  whenDesktopServerReady: serverReadyMock,
}))

function Harness() {
  useScheduledTaskDesktopNotifications()
  return null
}

describe('useScheduledTaskDesktopNotifications', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-03T00:00:30.000Z'))
    localStorage.clear()
    listMock.mockReset()
    getRecentRunsMock.mockReset()
    notifyDesktopMock.mockReset()
    notifyDesktopMock.mockResolvedValue(true)
    serverReadyMock.mockReset()
    serverReadyMock.mockResolvedValue(undefined)
  })

  it('does not poll until the desktop server is ready', async () => {
    let resolveReady: () => void = () => {}
    serverReadyMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveReady = resolve
      }),
    )
    listMock.mockResolvedValue({ tasks: [] })
    getRecentRunsMock.mockResolvedValue({ runs: [] })

    render(<Harness />)

    expect(JSON.parse(localStorage.getItem('cc-haha.scheduledTaskNotificationScan.v1')!))
      .toEqual({
        initializedAtMs: Date.parse('2026-05-03T00:00:30.000Z'),
        initializationPending: true,
      })

    // While the server is not ready, the poller must stay silent — this is the
    // regression guard for the startup race that logged "Failed to fetch" warnings.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(listMock).not.toHaveBeenCalled()
    expect(getRecentRunsMock).not.toHaveBeenCalled()

    resolveReady()
    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))
    expect(getRecentRunsMock).not.toHaveBeenCalled()
  })

  it('does not overlap scheduled-task polls while the previous task request is pending', async () => {
    let resolveTasks: (value: { tasks: [] }) => void = () => {}
    listMock.mockReturnValue(new Promise<{ tasks: [] }>((resolve) => {
      resolveTasks = resolve
    }))

    render(<Harness />)
    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))

    await vi.advanceTimersByTimeAsync(90_000)
    expect(listMock).toHaveBeenCalledTimes(1)
    expect(getRecentRunsMock).not.toHaveBeenCalled()

    resolveTasks({ tasks: [] })
    await vi.runAllTicks()
  })

  it('retains the startup completion floor when the first task-list request fails and retries', async () => {
    const desktopTask = {
      id: 'task-1',
      name: 'Daily review',
      cron: '* * * * *',
      prompt: 'review',
      enabled: true,
      createdAt: 1,
      notification: { enabled: true, channels: ['desktop'] },
    }
    const completedWhileTaskListFailed = {
      id: 'completed-while-task-list-failed',
      taskId: 'task-1',
      taskName: 'Daily review',
      startedAt: '2026-05-03T00:00:29.000Z',
      completedAt: '2026-05-03T00:00:30.500Z',
      status: 'completed',
      prompt: 'review',
    }
    listMock
      .mockRejectedValueOnce(new Error('task list unavailable'))
      .mockResolvedValue({ tasks: [desktopTask] })
    getRecentRunsMock.mockResolvedValue({ runs: [completedWhileTaskListFailed] })

    render(<Harness />)
    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))

    vi.setSystemTime(new Date('2026-05-03T00:00:31.000Z'))
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'scheduled-task:completed-while-task-list-failed',
    })))
  })

  it('retains the startup completion floor when unmounted during the first task-list request', async () => {
    const desktopTask = {
      id: 'task-1',
      name: 'Daily review',
      cron: '* * * * *',
      prompt: 'review',
      enabled: true,
      createdAt: 1,
      notification: { enabled: true, channels: ['desktop'] },
    }
    const completedWhileTaskListPending = {
      id: 'completed-while-task-list-pending',
      taskId: 'task-1',
      taskName: 'Daily review',
      startedAt: '2026-05-03T00:00:29.000Z',
      completedAt: '2026-05-03T00:00:30.500Z',
      status: 'completed',
      prompt: 'review',
    }
    let resolveFirstTaskList: (value: { tasks: typeof desktopTask[] }) => void = () => {}
    const firstTaskList = new Promise<{ tasks: typeof desktopTask[] }>((resolve) => {
      resolveFirstTaskList = resolve
    })
    listMock
      .mockReturnValueOnce(firstTaskList)
      .mockResolvedValue({ tasks: [desktopTask] })
    getRecentRunsMock.mockResolvedValue({ runs: [completedWhileTaskListPending] })

    const firstMount = render(<Harness />)
    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))
    firstMount.unmount()
    vi.setSystemTime(new Date('2026-05-03T00:00:31.000Z'))
    resolveFirstTaskList({ tasks: [desktopTask] })
    await vi.runAllTicks()

    render(<Harness />)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'scheduled-task:completed-while-task-list-pending',
    })))
  })

  it('does not overlap recent-run requests while the previous run poll is pending', async () => {
    listMock.mockResolvedValue({
      tasks: [{
        id: 'task-1',
        name: 'Daily review',
        cron: '* * * * *',
        prompt: 'review',
        enabled: true,
        createdAt: 1,
        notification: { enabled: true, channels: ['desktop'] },
      }],
    })
    let resolveRuns: (value: { runs: [] }) => void = () => {}
    getRecentRunsMock.mockReturnValue(new Promise<{ runs: [] }>((resolve) => {
      resolveRuns = resolve
    }))

    render(<Harness />)
    await vi.waitFor(() => expect(getRecentRunsMock).toHaveBeenCalledTimes(1))

    await vi.advanceTimersByTimeAsync(90_000)
    expect(listMock).toHaveBeenCalledTimes(1)
    expect(getRecentRunsMock).toHaveBeenCalledTimes(1)

    resolveRuns({ runs: [] })
    await vi.runAllTicks()
  })

  it('notifies the first completed desktop task created after an empty initial poll', async () => {
    const desktopTask = {
      id: 'task-new',
      name: 'New task',
      cron: '* * * * *',
      prompt: 'review',
      enabled: true,
      createdAt: 1,
      notification: { enabled: true, channels: ['desktop'] },
    }
    listMock
      .mockResolvedValueOnce({ tasks: [] })
      .mockResolvedValue({ tasks: [desktopTask] })
    getRecentRunsMock.mockResolvedValue({
      runs: [{
        id: 'run-new-task',
        taskId: 'task-new',
        taskName: 'New task',
        startedAt: '2026-05-03T00:01:00.000Z',
        completedAt: '2026-05-03T00:01:01.000Z',
        status: 'completed',
        prompt: 'review',
        output: 'done',
      }],
    })

    render(<Harness />)
    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))
    expect(getRecentRunsMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(1))

    expect(notifyDesktopMock).toHaveBeenCalledWith({
      dedupeKey: 'scheduled-task:run-new-task',
      title: '定时任务 New task',
      body: '完成: done',
      target: { type: 'scheduled' },
    })
  })

  it('delivers a terminal run that completes while the first history request is pending', async () => {
    const desktopTask = {
      id: 'task-1',
      name: 'Daily review',
      cron: '* * * * *',
      prompt: 'review',
      enabled: true,
      createdAt: 1,
      notification: { enabled: true, channels: ['desktop'] },
    }
    const oldRun = {
      id: 'old-before-startup',
      taskId: 'task-1',
      taskName: 'Daily review',
      startedAt: '2026-05-03T00:00:00.000Z',
      completedAt: '2026-05-03T00:00:01.000Z',
      status: 'completed',
      prompt: 'review',
    }
    const completedDuringRequest = {
      ...oldRun,
      id: 'completed-during-request',
      startedAt: '2026-05-03T00:00:29.000Z',
      completedAt: '2026-05-03T00:00:30.500Z',
      outputPreview: 'fresh result',
    }
    let resolveRuns: (value: { runs: typeof oldRun[] }) => void = () => {}
    const pendingRuns = new Promise<{ runs: typeof oldRun[] }>((resolve) => {
      resolveRuns = resolve
    })
    listMock.mockResolvedValue({ tasks: [desktopTask] })
    getRecentRunsMock.mockReturnValue(pendingRuns)

    render(<Harness />)
    await vi.waitFor(() => expect(getRecentRunsMock).toHaveBeenCalledTimes(1))
    vi.setSystemTime(new Date('2026-05-03T00:00:31.000Z'))
    resolveRuns({ runs: [completedDuringRequest, oldRun] })

    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(1))
    expect(notifyDesktopMock).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'scheduled-task:completed-during-request',
    }))
    expect(notifyDesktopMock).not.toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'scheduled-task:old-before-startup',
    }))
  })

  it('retries a failed first-poll delivery instead of baselining it', async () => {
    const desktopTask = {
      id: 'task-1',
      name: 'Daily review',
      cron: '* * * * *',
      prompt: 'review',
      enabled: true,
      createdAt: 1,
      notification: { enabled: true, channels: ['desktop'] },
    }
    const completedDuringRequest = {
      id: 'first-poll-retry',
      taskId: 'task-1',
      taskName: 'Daily review',
      startedAt: '2026-05-03T00:00:29.000Z',
      completedAt: '2026-05-03T00:00:30.500Z',
      status: 'completed',
      prompt: 'review',
    }
    listMock.mockResolvedValue({ tasks: [desktopTask] })
    getRecentRunsMock.mockResolvedValue({ runs: [completedDuringRequest] })
    notifyDesktopMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    render(<Harness />)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(localStorage.getItem('cc-haha.notifiedDesktopTaskRuns.v1')!))
      .not.toContain('first-poll-retry')

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(2))
    expect(JSON.parse(localStorage.getItem('cc-haha.notifiedDesktopTaskRuns.v1')!))
      .toContain('first-poll-retry')
  })

  it('persists the first-poll time floor when stopped before history resolves', async () => {
    const desktopTask = {
      id: 'task-1',
      name: 'Daily review',
      cron: '* * * * *',
      prompt: 'review',
      enabled: true,
      createdAt: 1,
      notification: { enabled: true, channels: ['desktop'] },
    }
    const completedWhileStopped = {
      id: 'completed-while-stopped',
      taskId: 'task-1',
      taskName: 'Daily review',
      startedAt: '2026-05-03T00:00:29.000Z',
      completedAt: '2026-05-03T00:00:30.500Z',
      status: 'completed',
      prompt: 'review',
    }
    let resolveFirstRuns: (value: { runs: [] }) => void = () => {}
    const firstRuns = new Promise<{ runs: [] }>((resolve) => {
      resolveFirstRuns = resolve
    })
    listMock.mockResolvedValue({ tasks: [desktopTask] })
    getRecentRunsMock
      .mockReturnValueOnce(firstRuns)
      .mockResolvedValue({ runs: [completedWhileStopped] })

    const firstMount = render(<Harness />)
    await vi.waitFor(() => expect(getRecentRunsMock).toHaveBeenCalledTimes(1))
    firstMount.unmount()
    vi.setSystemTime(new Date('2026-05-03T00:00:31.000Z'))
    resolveFirstRuns({ runs: [] })

    render(<Harness />)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'scheduled-task:completed-while-stopped',
    })))
  })

  it('does not notify old runs on first poll and notifies new desktop-enabled task runs later', async () => {
    listMock.mockResolvedValue({
      tasks: [{
        id: 'task-1',
        name: 'Daily review',
        cron: '* * * * *',
        prompt: 'review',
        enabled: true,
        createdAt: 1,
        notification: { enabled: true, channels: ['desktop'] },
      }],
    })
    getRecentRunsMock.mockImplementation((_limit, options) => {
      if (options?.completedAfterMs !== undefined || options?.nonterminalOnly) {
        return Promise.resolve({ runs: [] })
      }
      return Promise.resolve({
        runs: [
          {
            id: 'run-new',
            taskId: 'task-1',
            taskName: 'Daily review',
            startedAt: '2026-05-03T00:01:00.000Z',
            completedAt: '2026-05-03T00:01:01.000Z',
            status: 'failed',
            prompt: 'review',
            error: 'provider timeout',
          },
          {
            id: 'run-old',
            taskId: 'task-1',
            taskName: 'Daily review',
            startedAt: '2026-05-03T00:00:00.000Z',
            completedAt: '2026-05-03T00:00:01.000Z',
            status: 'completed',
            prompt: 'review',
            output: 'old result',
          },
        ],
      })
    })

    render(<Harness />)
    await vi.waitFor(() => expect(getRecentRunsMock).toHaveBeenCalledTimes(2))
    expect(notifyDesktopMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(1))
    expect(notifyDesktopMock).toHaveBeenCalledWith({
      dedupeKey: 'scheduled-task:run-new',
      title: '定时任务 Daily review',
      body: '失败: provider timeout',
      target: { type: 'scheduled' },
    })
  })

  it('targets the run session when a scheduled task run has a session id', async () => {
    listMock.mockResolvedValue({
      tasks: [{
        id: 'task-1',
        name: 'Daily review',
        cron: '* * * * *',
        prompt: 'review',
        enabled: true,
        createdAt: 1,
        notification: { enabled: true, channels: ['desktop'] },
      }],
    })
    getRecentRunsMock.mockImplementation((_limit, options) => {
      if (options?.completedAfterMs !== undefined || options?.nonterminalOnly) {
        return Promise.resolve({ runs: [] })
      }
      return Promise.resolve({
        runs: [{
          id: 'run-new',
          taskId: 'task-1',
          taskName: 'Daily review',
          startedAt: '2026-05-03T00:01:00.000Z',
          completedAt: '2026-05-03T00:01:01.000Z',
          status: 'completed',
          prompt: 'review',
          output: 'done',
          sessionId: 'session-task-run',
        }],
      })
    })

    render(<Harness />)
    await vi.waitFor(() => expect(getRecentRunsMock).toHaveBeenCalledTimes(2))

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(1))
    expect(notifyDesktopMock).toHaveBeenCalledWith({
      dedupeKey: 'scheduled-task:run-new',
      title: '定时任务 Daily review',
      body: '完成: done',
      target: {
        type: 'session',
        sessionId: 'session-task-run',
        title: 'Daily review',
      },
    })
  })

  it('ignores task runs without the desktop notification channel', async () => {
    listMock.mockResolvedValue({
      tasks: [{
        id: 'task-1',
        name: 'IM only',
        cron: '* * * * *',
        prompt: 'review',
        enabled: true,
        createdAt: 1,
        notification: { enabled: true, channels: ['telegram'] },
      }],
    })
    getRecentRunsMock.mockResolvedValue({
      runs: [{
        id: 'run-1',
        taskId: 'task-1',
        taskName: 'IM only',
        startedAt: '2026-05-03T00:00:00.000Z',
        completedAt: '2026-05-03T00:00:01.000Z',
        status: 'completed',
        prompt: 'review',
      }],
    })

    render(<Harness />)
    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(30_000)

    expect(getRecentRunsMock).not.toHaveBeenCalled()
    expect(notifyDesktopMock).not.toHaveBeenCalled()
  })

  it('does not mark a run as notified when desktop notification delivery fails', async () => {
    notifyDesktopMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    listMock.mockResolvedValue({
      tasks: [{
        id: 'task-1',
        name: 'Daily review',
        cron: '* * * * *',
        prompt: 'review',
        enabled: true,
        createdAt: 1,
        notification: { enabled: true, channels: ['desktop'] },
      }],
    })
    getRecentRunsMock.mockImplementation((_limit, options) => {
      if (options?.completedAfterMs !== undefined || options?.nonterminalOnly) {
        return Promise.resolve({ runs: [] })
      }
      return Promise.resolve({
        runs: [{
          id: 'run-new',
          taskId: 'task-1',
          taskName: 'Daily review',
          startedAt: '2026-05-03T00:01:00.000Z',
          completedAt: '2026-05-03T00:01:01.000Z',
          status: 'completed',
          prompt: 'review',
        }],
      })
    })

    render(<Harness />)
    await vi.waitFor(() => expect(getRecentRunsMock).toHaveBeenCalledTimes(2))

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(1))

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(2))
  })

  it('keeps legacy notified IDs as dedupe without suppressing fresh summary runs', async () => {
    localStorage.setItem('cc-haha.notifiedDesktopTaskRuns.v1', JSON.stringify(['run-before-restart']))
    listMock.mockResolvedValue({
      tasks: [{
        id: 'task-1',
        name: 'Daily review',
        cron: '* * * * *',
        prompt: 'review',
        enabled: true,
        createdAt: 1,
        notification: { enabled: true, channels: ['desktop'] },
      }],
    })
    const firstFreshRun = {
      id: 'run-unseen-legacy-history',
      taskId: 'task-1',
      taskName: 'Daily review',
      startedAt: '2026-05-03T00:01:00.000Z',
      completedAt: '2026-05-03T00:01:01.000Z',
      status: 'completed',
      prompt: 'review',
    }
    const laterRun = {
      id: 'run-after-legacy-baseline',
      taskId: 'task-1',
      taskName: 'Daily review',
      startedAt: '2026-05-03T00:02:00.000Z',
      completedAt: '2026-05-03T00:02:01.000Z',
      status: 'completed',
      prompt: 'review',
      hasOutput: true,
      outputPreview: 'summary result',
    }
    getRecentRunsMock.mockImplementation((_limit, options) => {
      if (options?.nonterminalOnly) return Promise.resolve({ runs: [] })
      if (options?.completedAfterMs !== undefined) {
        return Promise.resolve({ runs: [firstFreshRun] })
      }
      return Promise.resolve({
        runs: [
          laterRun,
          firstFreshRun,
        ],
      })
    })

    render(<Harness />)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'scheduled-task:run-unseen-legacy-history',
    })))

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(2))
    expect(getRecentRunsMock).toHaveBeenCalledWith(50, { summaryOnly: true })
    expect(notifyDesktopMock).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'scheduled-task:run-after-legacy-baseline',
      body: '完成: summary result',
    }))

    await vi.advanceTimersByTimeAsync(30_000)
    expect(notifyDesktopMock).toHaveBeenCalledTimes(2)
  })

  it('persists empty initialization so a run completed after restart is not treated as old', async () => {
    vi.setSystemTime(new Date('2026-05-03T00:00:30.000Z'))
    listMock.mockResolvedValue({ tasks: [] })
    const firstMount = render(<Harness />)
    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))
    expect(localStorage.getItem('cc-haha.scheduledTaskNotificationScan.v1')).not.toBeNull()
    firstMount.unmount()

    listMock.mockReset()
    listMock.mockResolvedValue({
      tasks: [{
        id: 'task-after-restart',
        name: 'After restart',
        cron: '* * * * *',
        prompt: 'review',
        enabled: true,
        createdAt: 1,
        notification: { enabled: true, channels: ['desktop'] },
      }],
    })
    getRecentRunsMock.mockResolvedValue({
      runs: [{
        id: 'run-after-restart',
        taskId: 'task-after-restart',
        taskName: 'After restart',
        startedAt: '2026-05-03T00:01:00.000Z',
        completedAt: '2026-05-03T00:01:01.000Z',
        status: 'completed',
        prompt: 'review',
      }],
    })

    render(<Harness />)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(1))
    expect(notifyDesktopMock).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'scheduled-task:run-after-restart',
    }))
  })

  it('does not replay old history when desktop notifications are enabled after an empty initialization', async () => {
    vi.setSystemTime(new Date('2026-05-03T00:00:30.000Z'))
    const task = {
      id: 'task-1',
      name: 'Daily review',
      cron: '* * * * *',
      prompt: 'review',
      enabled: true,
      createdAt: 1,
      notification: { enabled: true, channels: ['desktop'] },
    }
    listMock
      .mockResolvedValueOnce({
        tasks: [{
          ...task,
          notification: { enabled: false, channels: ['desktop'] },
        }],
      })
      .mockResolvedValue({ tasks: [task] })
    getRecentRunsMock.mockResolvedValue({
      runs: [
        {
          id: 'run-after-initialization',
          taskId: 'task-1',
          taskName: 'Daily review',
          startedAt: '2026-05-03T00:01:00.000Z',
          completedAt: '2026-05-03T00:01:01.000Z',
          status: 'completed',
          prompt: 'review',
        },
        {
          id: 'run-before-initialization',
          taskId: 'task-1',
          taskName: 'Daily review',
          startedAt: '2026-05-03T00:00:00.000Z',
          completedAt: '2026-05-03T00:00:01.000Z',
          status: 'completed',
          prompt: 'review',
        },
      ],
    })

    render(<Harness />)
    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))
    expect(getRecentRunsMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(1))
    expect(notifyDesktopMock).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'scheduled-task:run-after-initialization',
    }))
    expect(notifyDesktopMock).not.toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'scheduled-task:run-before-initialization',
    }))
  })

  it('continues catch-up with a persisted cursor and delivers at most 50 runs per poll', async () => {
    localStorage.setItem('cc-haha.notifiedDesktopTaskRuns.v1', JSON.stringify(['run-before-restart']))
    localStorage.setItem('cc-haha.scheduledTaskNotificationScan.v1', JSON.stringify({
      initializedAtMs: Date.parse('2026-05-02T00:00:00.000Z'),
    }))
    const desktopTask = {
      id: 'task-1',
      name: 'Daily review',
      cron: '* * * * *',
      prompt: 'review',
      enabled: true,
      createdAt: 1,
      notification: { enabled: true, channels: ['desktop'] },
    }
    const makeRun = (index: number) => ({
      id: `offline-${index}`,
      taskId: 'task-1',
      taskName: 'Daily review',
      startedAt: new Date(Date.UTC(2026, 4, 3, 0, index)).toISOString(),
      completedAt: new Date(Date.UTC(2026, 4, 3, 0, index, 1)).toISOString(),
      status: 'completed',
      prompt: 'review',
    })
    const firstPageRuns = Array.from({ length: 50 }, (_, index) => makeRun(54 - index))
    listMock.mockResolvedValue({ tasks: [desktopTask] })
    getRecentRunsMock
      .mockResolvedValueOnce({
        runs: firstPageRuns,
        nextCursor: 'older-page',
      })
      .mockResolvedValueOnce({
        runs: Array.from({ length: 5 }, (_, index) => makeRun(4 - index)),
      })
      .mockResolvedValue({ runs: firstPageRuns })

    render(<Harness />)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(50))
    expect(getRecentRunsMock).toHaveBeenNthCalledWith(1, 50, { summaryOnly: true })
    expect(JSON.parse(localStorage.getItem('cc-haha.scheduledTaskNotificationScan.v1')!)).toMatchObject({
      cursor: 'older-page',
    })

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(55))
    expect(getRecentRunsMock).toHaveBeenNthCalledWith(2, 50, {
      cursor: 'older-page',
      summaryOnly: true,
    })

    await vi.advanceTimersByTimeAsync(30_000)
    expect(notifyDesktopMock).toHaveBeenCalledTimes(55)
  })

  it('does not duplicate the completed scan boundary after more than 200 catch-up deliveries', async () => {
    localStorage.setItem('cc-haha.notifiedDesktopTaskRuns.v1', JSON.stringify([]))
    localStorage.setItem('cc-haha.scheduledTaskNotificationScan.v1', JSON.stringify({
      initializedAtMs: Date.parse('2026-05-02T00:00:00.000Z'),
    }))
    listMock.mockResolvedValue({
      tasks: [{
        id: 'task-1',
        name: 'Daily review',
        cron: '* * * * *',
        prompt: 'review',
        enabled: true,
        createdAt: 1,
        notification: { enabled: true, channels: ['desktop'] },
      }],
    })
    const runs = Array.from({ length: 251 }, (_, index) => ({
      id: `large-catch-up-${250 - index}`,
      taskId: 'task-1',
      taskName: 'Daily review',
      startedAt: new Date(Date.UTC(2026, 4, 3, 0, 250 - index)).toISOString(),
      completedAt: new Date(Date.UTC(2026, 4, 3, 0, 250 - index, 1)).toISOString(),
      status: 'completed',
      prompt: 'review',
    }))
    const pages = Array.from({ length: 6 }, (_, pageIndex) =>
      runs.slice(pageIndex * 50, (pageIndex + 1) * 50))
    pages.forEach((page, pageIndex) => {
      getRecentRunsMock.mockResolvedValueOnce({
        runs: page,
        ...(pageIndex < pages.length - 1 ? { nextCursor: `page-${pageIndex + 1}` } : {}),
      })
    })
    getRecentRunsMock.mockResolvedValue({ runs: pages[0] })

    render(<Harness />)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(50))
    for (const expected of [100, 150, 200, 250, 251]) {
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(expected))
    }

    await vi.advanceTimersByTimeAsync(30_000)
    expect(notifyDesktopMock).toHaveBeenCalledTimes(251)
  })

  it('keeps the oldest running low-water until two concurrent runs complete behind a newer head', async () => {
    const task = {
      id: 'task-1',
      name: 'Daily review',
      cron: '* * * * *',
      prompt: 'review',
      enabled: true,
      createdAt: 1,
      notification: { enabled: true, channels: ['desktop'] },
    }
    const run = (id: string, startedAt: string, status: 'running' | 'completed') => ({
      id,
      taskId: 'task-1',
      taskName: 'Daily review',
      startedAt,
      ...(status === 'completed' ? { completedAt: startedAt } : {}),
      status,
      prompt: 'review',
    })
    const newest = run('newest-terminal', '2026-05-03T00:03:00.000Z', 'completed')
    const youngerRunning = run('younger-running', '2026-05-03T00:02:00.000Z', 'running')
    const oldestRunning = run('oldest-running', '2026-05-03T00:01:00.000Z', 'running')
    localStorage.setItem('cc-haha.scheduledTaskNotificationScan.v1', JSON.stringify({
      initializedAtMs: Date.parse('2026-05-02T00:00:00.000Z'),
      boundary: {
        runId: oldestRunning.id,
        startedAtMs: Date.parse(oldestRunning.startedAt),
        terminal: false,
      },
    }))
    listMock.mockResolvedValue({ tasks: [task] })
    getRecentRunsMock
      .mockResolvedValueOnce({ runs: [newest, youngerRunning, oldestRunning] })
      .mockResolvedValueOnce({
        runs: [
          newest,
          { ...youngerRunning, status: 'completed', completedAt: youngerRunning.startedAt },
          oldestRunning,
        ],
      })
      .mockResolvedValue({
        runs: [
          newest,
          { ...youngerRunning, status: 'completed', completedAt: youngerRunning.startedAt },
          { ...oldestRunning, status: 'completed', completedAt: oldestRunning.startedAt },
        ],
      })

    render(<Harness />)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(localStorage.getItem('cc-haha.scheduledTaskNotificationScan.v1')!)).toMatchObject({
      boundary: { runId: 'oldest-running', terminal: false },
    })

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(2))
    expect(notifyDesktopMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      dedupeKey: 'scheduled-task:younger-running',
    }))

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(3))
    expect(notifyDesktopMock).toHaveBeenNthCalledWith(3, expect.objectContaining({
      dedupeKey: 'scheduled-task:oldest-running',
    }))
  })

  it('persists a cross-page running low-water through restart, retention deletion, and delivery retry', async () => {
    const task = {
      id: 'task-1',
      name: 'Daily review',
      cron: '* * * * *',
      prompt: 'review',
      enabled: true,
      createdAt: 1,
      notification: { enabled: true, channels: ['desktop'] },
    }
    const youngRunning = {
      id: 'young-running',
      taskId: 'task-1',
      taskName: 'Daily review',
      startedAt: '2026-05-03T00:01:50.000Z',
      status: 'running',
      prompt: 'review',
    }
    const oldRunning = {
      ...youngRunning,
      id: 'old-running',
      startedAt: '2026-05-03T00:01:00.000Z',
    }
    const baseline = {
      ...youngRunning,
      id: 'baseline',
      startedAt: '2026-05-03T00:00:00.000Z',
      completedAt: '2026-05-03T00:00:01.000Z',
      status: 'completed',
    }
    const fillers = Array.from({ length: 49 }, (_, index) => ({
      ...baseline,
      id: `filler-${index}`,
      taskId: 'other-task',
      startedAt: new Date(Date.parse('2026-05-03T00:01:49.000Z') - index * 1000).toISOString(),
    }))
    localStorage.setItem('cc-haha.scheduledTaskNotificationScan.v1', JSON.stringify({
      initializedAtMs: Date.parse('2026-05-02T00:00:00.000Z'),
      boundary: {
        runId: baseline.id,
        startedAtMs: Date.parse(baseline.startedAt),
        terminal: true,
      },
    }))
    listMock.mockResolvedValue({ tasks: [task] })
    getRecentRunsMock
      .mockResolvedValueOnce({ runs: [youngRunning, ...fillers], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ runs: [oldRunning, baseline] })
      .mockResolvedValue({
        runs: [{
          ...youngRunning,
          status: 'completed',
          completedAt: '2026-05-03T00:02:00.000Z',
        }, baseline],
      })

    const firstMount = render(<Harness />)
    await vi.waitFor(() => expect(getRecentRunsMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(localStorage.getItem('cc-haha.scheduledTaskNotificationScan.v1')!)).toMatchObject({
      cursor: 'page-2',
      scanLowWater: { runId: 'young-running', terminal: false },
    })
    firstMount.unmount()

    render(<Harness />)
    await vi.waitFor(() => expect(getRecentRunsMock).toHaveBeenCalledTimes(2))
    expect(JSON.parse(localStorage.getItem('cc-haha.scheduledTaskNotificationScan.v1')!)).toMatchObject({
      boundary: { runId: 'old-running', terminal: false },
    })

    notifyDesktopMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(localStorage.getItem('cc-haha.scheduledTaskNotificationScan.v1')!)).toMatchObject({
      boundary: { runId: 'old-running', terminal: false },
    })

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(2))
    expect(notifyDesktopMock).toHaveBeenLastCalledWith(expect.objectContaining({
      dedupeKey: 'scheduled-task:young-running',
    }))
    expect(JSON.parse(localStorage.getItem('cc-haha.scheduledTaskNotificationScan.v1')!)).toMatchObject({
      boundary: { runId: 'young-running', terminal: true },
    })
  })

  it('drops stale scan progress and safely rescans the head when the server resets a cursor', async () => {
    const task = {
      id: 'task-1',
      name: 'Daily review',
      cron: '* * * * *',
      prompt: 'review',
      enabled: true,
      createdAt: 1,
      notification: { enabled: true, channels: ['desktop'] },
    }
    const baseline = {
      id: 'baseline',
      taskId: 'task-1',
      taskName: 'Daily review',
      startedAt: '2026-05-03T00:00:00.000Z',
      completedAt: '2026-05-03T00:00:01.000Z',
      status: 'completed',
      prompt: 'review',
    }
    const fresh = {
      ...baseline,
      id: 'fresh-after-reset',
      startedAt: '2026-05-03T00:01:00.000Z',
      completedAt: '2026-05-03T00:01:01.000Z',
    }
    localStorage.setItem('cc-haha.scheduledTaskNotificationScan.v1', JSON.stringify({
      initializedAtMs: Date.parse('2026-05-02T00:00:00.000Z'),
      boundary: {
        runId: baseline.id,
        startedAtMs: Date.parse(baseline.startedAt),
        terminal: true,
      },
      cursor: 'stale-cursor',
      scanHead: {
        runId: 'stale-head',
        startedAtMs: Date.parse('2026-05-03T00:02:00.000Z'),
        terminal: true,
      },
      scanLowWater: {
        runId: 'stale-running',
        startedAtMs: Date.parse('2026-05-03T00:01:30.000Z'),
        terminal: false,
      },
    }))
    listMock.mockResolvedValue({ tasks: [task] })
    getRecentRunsMock.mockResolvedValue({ runs: [fresh, baseline], reset: true })

    render(<Harness />)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(1))
    expect(notifyDesktopMock).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'scheduled-task:fresh-after-reset',
    }))
    expect(JSON.parse(localStorage.getItem('cc-haha.scheduledTaskNotificationScan.v1')!)).toEqual({
      initializedAtMs: Date.parse('2026-05-02T00:00:00.000Z'),
      boundary: {
        runId: 'fresh-after-reset',
        startedAtMs: Date.parse(fresh.startedAt),
        terminal: true,
      },
    })
  })

  it('tracks a run that was already running on the first poll and notifies when it completes', async () => {
    const task = {
      id: 'task-1',
      name: 'Daily review',
      cron: '* * * * *',
      prompt: 'review',
      enabled: true,
      createdAt: 1,
      notification: { enabled: true, channels: ['desktop'] },
    }
    const running = {
      id: 'running-at-startup',
      taskId: 'task-1',
      taskName: 'Daily review',
      startedAt: '2026-05-03T00:00:20.000Z',
      status: 'running',
      prompt: 'review',
    }
    listMock.mockResolvedValue({ tasks: [task] })
    getRecentRunsMock
      .mockResolvedValueOnce({ runs: [running], revisionToken: 'source-1' })
      .mockResolvedValue({
        runs: [{
          ...running,
          status: 'completed',
          completedAt: '2026-05-03T00:00:40.000Z',
        }],
        revisionToken: 'source-2',
      })

    render(<Harness />)
    await vi.waitFor(() => expect(getRecentRunsMock).toHaveBeenCalled())
    expect(notifyDesktopMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'scheduled-task:running-at-startup',
    })))
  })

  it('discovers an initial running run beyond the first 50 history rows without scanning terminal history', async () => {
    const task = {
      id: 'task-1',
      name: 'Daily review',
      cron: '* * * * *',
      prompt: 'review',
      enabled: true,
      createdAt: 1,
      notification: { enabled: true, channels: ['desktop'] },
    }
    const oldRunning = {
      id: 'running-on-older-page',
      taskId: 'task-1',
      taskName: 'Daily review',
      startedAt: '2026-05-02T23:50:00.000Z',
      status: 'running',
      prompt: 'review',
    }
    listMock.mockResolvedValue({ tasks: [task] })
    getRecentRunsMock.mockImplementation((_limit, options) => {
      if (options?.nonterminalOnly) {
        return Promise.resolve({ runs: [oldRunning], revisionToken: 'source-1' })
      }
      if (options?.completedAfterMs !== undefined) {
        return Promise.resolve({ runs: [], revisionToken: 'source-1' })
      }
      return Promise.resolve({
        runs: [{
          ...oldRunning,
          status: 'completed',
          completedAt: '2026-05-03T00:01:00.000Z',
        }],
        revisionToken: 'source-2',
      })
    })

    render(<Harness />)
    await vi.waitFor(() => expect(getRecentRunsMock).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ summaryOnly: true, nonterminalOnly: true }),
    ))
    expect(notifyDesktopMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(getRecentRunsMock).toHaveBeenCalledWith(
      50,
      { summaryOnly: true },
    ))
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'scheduled-task:running-on-older-page',
    })))
    expect(notifyDesktopMock).not.toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: expect.stringMatching(/^scheduled-task:terminal-/),
    }))
  })

  it('does not miss a newly appended terminal run tied with the prior boundary timestamp', async () => {
    const task = {
      id: 'task-1',
      name: 'Daily review',
      cron: '* * * * *',
      prompt: 'review',
      enabled: true,
      createdAt: 1,
      notification: { enabled: true, channels: ['desktop'] },
    }
    const baseline = {
      id: 'tie-baseline',
      taskId: 'task-1',
      taskName: 'Daily review',
      startedAt: '2026-05-03T00:01:00.000Z',
      completedAt: '2026-05-03T00:01:01.000Z',
      status: 'completed',
      prompt: 'review',
    }
    const tiedNewRun = {
      ...baseline,
      id: 'tie-new-run',
      completedAt: '2026-05-03T00:02:00.000Z',
    }
    localStorage.setItem('cc-haha.notifiedDesktopTaskRuns.v1', JSON.stringify([baseline.id]))
    localStorage.setItem('cc-haha.scheduledTaskNotificationScan.v1', JSON.stringify({
      initializedAtMs: Date.parse('2026-05-03T00:00:30.000Z'),
      revisionToken: 'source-1',
      boundary: {
        runId: baseline.id,
        startedAtMs: Date.parse(baseline.startedAt),
        terminal: true,
      },
    }))
    listMock.mockResolvedValue({ tasks: [task] })
    getRecentRunsMock.mockResolvedValue({
      runs: [baseline, tiedNewRun],
      revisionToken: 'source-2',
    })

    render(<Harness />)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'scheduled-task:tie-new-run',
    })))
  })

  it('retries a failed delivery beyond a tied boundary after persisting the new revision', async () => {
    const task = {
      id: 'task-1',
      name: 'Daily review',
      cron: '* * * * *',
      prompt: 'review',
      enabled: true,
      createdAt: 1,
      notification: { enabled: true, channels: ['desktop'] },
    }
    const baseline = {
      id: 'tie-retry-baseline',
      taskId: 'task-1',
      taskName: 'Daily review',
      startedAt: '2026-05-03T00:01:00.000Z',
      completedAt: '2026-05-03T00:01:01.000Z',
      status: 'completed',
      prompt: 'review',
    }
    const tiedNewRun = {
      ...baseline,
      id: 'tie-retry-new-run',
      completedAt: '2026-05-03T00:02:00.000Z',
    }
    localStorage.setItem('cc-haha.notifiedDesktopTaskRuns.v1', JSON.stringify([baseline.id]))
    localStorage.setItem('cc-haha.scheduledTaskNotificationScan.v1', JSON.stringify({
      initializedAtMs: Date.parse('2026-05-03T00:00:30.000Z'),
      revisionToken: 'source-1',
      boundary: {
        runId: baseline.id,
        startedAtMs: Date.parse(baseline.startedAt),
        terminal: true,
      },
    }))
    listMock.mockResolvedValue({ tasks: [task] })
    getRecentRunsMock.mockResolvedValue({
      runs: [baseline, tiedNewRun],
      revisionToken: 'source-2',
    })
    notifyDesktopMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    render(<Harness />)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(2))
    expect(notifyDesktopMock).toHaveBeenLastCalledWith(expect.objectContaining({
      dedupeKey: 'scheduled-task:tie-retry-new-run',
    }))
  })

  it('pages startup completion candidates and finds a freshly completed old-start run on page two', async () => {
    const task = {
      id: 'task-1',
      name: 'Daily review',
      cron: '* * * * *',
      prompt: 'review',
      enabled: true,
      createdAt: 1,
      notification: { enabled: true, channels: ['desktop'] },
    }
    const pageOne = Array.from({ length: 50 }, (_, index) => ({
      id: `fresh-page-one-${index}`,
      taskId: 'task-1',
      taskName: 'Daily review',
      startedAt: new Date(Date.parse('2026-05-03T00:00:29.000Z') - index * 1000).toISOString(),
      completedAt: new Date(Date.parse('2026-05-03T00:00:31.000Z') + index * 1000).toISOString(),
      status: 'completed',
      prompt: 'review',
    }))
    const pageTwo = [{
      id: 'fresh-old-start-on-page-two',
      taskId: 'task-1',
      taskName: 'Daily review',
      startedAt: '2026-05-02T12:00:00.000Z',
      completedAt: '2026-05-03T00:01:00.000Z',
      status: 'completed',
      prompt: 'review',
    }]
    listMock.mockResolvedValue({ tasks: [task] })
    getRecentRunsMock.mockImplementation((_limit, options) => {
      if (options?.nonterminalOnly) return Promise.resolve({ runs: [] })
      if (options?.cursor === 'completion-page-two') return Promise.resolve({ runs: pageTwo })
      return Promise.resolve({ runs: pageOne, nextCursor: 'completion-page-two' })
    })

    render(<Harness />)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(50))
    expect(notifyDesktopMock).not.toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'scheduled-task:fresh-old-start-on-page-two',
    }))

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'scheduled-task:fresh-old-start-on-page-two',
    })))
  })

  it('does not let a legacy delivered-id store suppress a fresh startup completion', async () => {
    localStorage.setItem('cc-haha.notifiedDesktopTaskRuns.v1', JSON.stringify(['legacy-delivered']))
    listMock.mockResolvedValue({
      tasks: [{
        id: 'task-1',
        name: 'Daily review',
        cron: '* * * * *',
        prompt: 'review',
        enabled: true,
        createdAt: 1,
        notification: { enabled: true, channels: ['desktop'] },
      }],
    })
    getRecentRunsMock.mockResolvedValue({
      runs: [{
        id: 'fresh-after-legacy-store',
        taskId: 'task-1',
        startedAt: '2026-05-03T00:00:29.000Z',
        completedAt: '2026-05-03T00:00:31.000Z',
        status: 'completed',
      }],
    })

    render(<Harness />)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'scheduled-task:fresh-after-legacy-store',
      title: '定时任务 Daily review',
      body: '状态: 完成',
    })))
  })

  it('keeps startup catch-up pending until desktop notifications become enabled', async () => {
    const task = {
      id: 'task-1',
      name: 'Daily review',
      cron: '* * * * *',
      prompt: 'review',
      enabled: true,
      createdAt: 1,
      notification: { enabled: true, channels: ['desktop'] },
    }
    listMock
      .mockResolvedValueOnce({
        tasks: [{
          ...task,
          notification: { enabled: false, channels: ['desktop'] },
        }],
      })
      .mockResolvedValue({ tasks: [task] })
    getRecentRunsMock.mockResolvedValue({
      runs: [{
        id: 'completed-after-enable-with-old-start',
        taskId: 'task-1',
        taskName: 'Daily review',
        startedAt: '2026-05-02T12:00:00.000Z',
        completedAt: '2026-05-03T00:00:31.000Z',
        status: 'completed',
        prompt: 'review',
      }],
    })

    render(<Harness />)
    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(localStorage.getItem('cc-haha.scheduledTaskNotificationScan.v1')!))
      .toMatchObject({ initializationPending: true })

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'scheduled-task:completed-after-enable-with-old-start',
    })))
  })

  it('restarts initialization when a run completes between the completion and nonterminal snapshots', async () => {
    const task = {
      id: 'task-1',
      name: 'Daily review',
      cron: '* * * * *',
      prompt: 'review',
      enabled: true,
      createdAt: 1,
      notification: { enabled: true, channels: ['desktop'] },
    }
    const completedBetweenSnapshots = {
      id: 'completed-between-initial-snapshots',
      taskId: 'task-1',
      startedAt: '2026-05-02T12:00:00.000Z',
      completedAt: '2026-05-03T00:00:31.000Z',
      status: 'completed',
    }
    let completionQueryCount = 0
    listMock.mockResolvedValue({ tasks: [task] })
    getRecentRunsMock.mockImplementation((_limit, options) => {
      if (options?.completedAfterMs !== undefined) {
        completionQueryCount += 1
        return Promise.resolve(completionQueryCount === 1
          ? { runs: [], revisionToken: 'source-before-completion' }
          : { runs: [completedBetweenSnapshots], revisionToken: 'source-after-completion' })
      }
      if (options?.nonterminalOnly) {
        return Promise.resolve({ runs: [], revisionToken: 'source-after-completion' })
      }
      return Promise.resolve({
        runs: [completedBetweenSnapshots],
        revisionToken: 'source-after-completion',
      })
    })

    render(<Harness />)
    await vi.waitFor(() => expect(getRecentRunsMock).toHaveBeenCalledTimes(2))
    expect(JSON.parse(localStorage.getItem('cc-haha.scheduledTaskNotificationScan.v1')!))
      .toEqual({
        initializedAtMs: Date.parse('2026-05-03T00:00:30.000Z'),
        initializationPending: true,
      })
    expect(notifyDesktopMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'scheduled-task:completed-between-initial-snapshots',
    })))
    expect(completionQueryCount).toBe(2)
  })

  it('notifies a missed one-shot reservation through the desktop path', async () => {
    useSettingsStore.setState({ locale: 'en' })
    listMock.mockResolvedValue({
      tasks: [{
        id: 'task-1',
        name: 'Daily review',
        cron: '0 10 15 6 *',
        prompt: 'review',
        enabled: false,
        createdAt: 1,
        recurring: false,
        notification: { enabled: true, channels: ['desktop'] },
      }],
    })
    getRecentRunsMock.mockImplementation((_limit, options) => {
      if (options?.completedAfterMs !== undefined || options?.nonterminalOnly) {
        return Promise.resolve({ runs: [] })
      }
      return Promise.resolve({
        runs: [{
          id: 'run-missed',
          taskId: 'task-1',
          taskName: 'Daily review',
          startedAt: '2026-05-03T00:01:00.000Z',
          completedAt: '2026-05-03T00:01:00.000Z',
          status: 'missed',
          prompt: 'review',
        }],
      })
    })

    render(<Harness />)
    await vi.waitFor(() => expect(getRecentRunsMock).toHaveBeenCalledTimes(2))

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(1))
    expect(notifyDesktopMock).toHaveBeenCalledWith({
      dedupeKey: 'scheduled-task:run-missed',
      title: 'Missed reservation: Daily review',
      body: 'A one-time scheduled send was missed while the app was closed. Run it now or reschedule it.',
      target: { type: 'scheduled' },
    })
  })
})
