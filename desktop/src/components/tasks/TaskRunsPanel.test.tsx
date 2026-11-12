import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { TaskRunsPanel } from './TaskRunsPanel'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTaskStore } from '../../stores/taskStore'
import type { TaskRun } from '../../types/task'

afterEach(() => {
  cleanup()
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  useTaskStore.setState(useTaskStore.getInitialState(), true)
})

describe('TaskRunsPanel', () => {
  it('renders scheduled task summaries as markdown', async () => {
    const run: TaskRun = {
      id: 'run-1',
      taskId: 'task-1',
      taskName: 'Daily summary',
      startedAt: '2026-05-08T12:05:37.000Z',
      status: 'completed',
      prompt: 'Summarize recent commits',
      output: '3 commits in the last 7 days, main changes:\n\n**1. 2865d50 - UI accessibility improvements**\n- Add theme-color meta tag\n- Fix select label issue',
      durationMs: 12000,
      sessionId: 'session-1',
    }
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      fetchTaskRuns: vi.fn(async () => [run]),
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    const { container } = render(
      <TaskRunsPanel taskId="task-1" onClose={vi.fn()} />,
    )

    await waitFor(() => expect(screen.getByRole('button', { name: 'Summary' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Summary' }))

    expect(screen.getByText('1. 2865d50 - UI accessibility improvements')).toBeInTheDocument()
    expect(container.querySelector('strong')).toHaveTextContent('1. 2865d50 - UI accessibility improvements')
    expect(screen.getByText('Add theme-color meta tag')).toBeInTheDocument()
    expect(container.querySelector('li')).toHaveTextContent('Add theme-color meta tag')
    expect(container.textContent).not.toContain('**1. 2865d50')
  })

  it('keeps large output out of the list response and loads detail only when expanded', async () => {
    const summary: TaskRun = {
      id: 'run-summary',
      taskId: 'task-1',
      taskName: 'Daily summary',
      startedAt: '2026-05-08T12:05:37.000Z',
      status: 'completed',
      prompt: 'Summarize',
      hasOutput: true,
      outputPreview: 'preview only',
    }
    let resolveDetail: (run: TaskRun) => void = () => {}
    const detail = new Promise<TaskRun>((resolve) => { resolveDetail = resolve })
    const fetchDetail = vi.fn(() => detail)
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      fetchTaskRuns: vi.fn(async () => [summary]),
      fetchTaskRunDetail: fetchDetail,
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    render(<TaskRunsPanel taskId="task-1" onClose={vi.fn()} />)

    const summaryButton = await screen.findByRole('button', { name: 'Summary' })
    expect(screen.queryByText('full detail loaded lazily')).not.toBeInTheDocument()
    expect(fetchDetail).not.toHaveBeenCalled()
    fireEvent.click(summaryButton)
    await waitFor(() => expect(fetchDetail).toHaveBeenCalledWith(
      'run-summary',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ))
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByText('No output')).not.toBeInTheDocument()
    resolveDetail({
      ...summary,
      output: '**full detail loaded lazily**',
    })
    expect(await screen.findByText('full detail loaded lazily')).toBeInTheDocument()
  })

  it('aborts an in-flight detail request on collapse', async () => {
    const summary: TaskRun = {
      id: 'run-abort',
      taskId: 'task-1',
      taskName: 'Task',
      startedAt: '2026-05-08T12:05:37.000Z',
      status: 'completed',
      prompt: 'prompt',
      hasOutput: true,
    }
    let detailSignal: AbortSignal | undefined
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      fetchTaskRuns: vi.fn(async () => [summary]),
      fetchTaskRunDetail: vi.fn((_runId: string, options?: { signal?: AbortSignal }) => {
        detailSignal = options?.signal
        return new Promise<TaskRun>(() => {})
      }),
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    render(<TaskRunsPanel taskId="task-1" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))
    await waitFor(() => expect(detailSignal).toBeDefined())
    expect(detailSignal?.aborted).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(detailSignal?.aborted).toBe(true)
  })

  it('shows a detail failure and retries without requiring collapse', async () => {
    const summary: TaskRun = {
      id: 'run-retry',
      taskId: 'task-1',
      taskName: 'Task',
      startedAt: '2026-05-08T12:05:37.000Z',
      status: 'completed',
      prompt: 'prompt',
      hasOutput: true,
    }
    const fetchDetail = vi.fn()
      .mockRejectedValueOnce(new Error('detail unavailable'))
      .mockResolvedValueOnce({ ...summary, output: 'detail after retry' })
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      fetchTaskRuns: vi.fn(async () => [summary]),
      fetchTaskRunDetail: fetchDetail,
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    render(<TaskRunsPanel taskId="task-1" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))
    expect(await screen.findByText('Error')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('detail after retry')).toBeInTheDocument()
    expect(fetchDetail).toHaveBeenCalledTimes(2)
  })

  it('ignores a stale list response after the selected task changes', async () => {
    let resolveOld: (runs: TaskRun[]) => void = () => {}
    const oldRequest = new Promise<TaskRun[]>((resolve) => { resolveOld = resolve })
    const fetchRuns = vi.fn((taskId: string) => taskId === 'old-task'
      ? oldRequest
      : Promise.resolve([{
        id: 'new-run',
        taskId: 'new-task',
        taskName: 'New',
        startedAt: '2026-05-08T12:05:37.000Z',
        status: 'failed' as const,
        prompt: 'new',
      }]))
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({ fetchTaskRuns: fetchRuns } as Partial<ReturnType<typeof useTaskStore.getState>>)

    const view = render(<TaskRunsPanel taskId="old-task" onClose={vi.fn()} />)
    view.rerender(<TaskRunsPanel taskId="new-task" onClose={vi.fn()} />)
    await screen.findByText('Failed')
    resolveOld([{
      id: 'old-run',
      taskId: 'old-task',
      taskName: 'Old',
      startedAt: '2025-05-08T12:05:37.000Z',
      status: 'completed',
      prompt: 'old',
    }])
    await Promise.resolve()

    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.queryByText('Completed')).not.toBeInTheDocument()
  })

  it('does not let a slow detail response overwrite a newer list generation', async () => {
    const summary: TaskRun = {
      id: 'same-run',
      taskId: 'task-1',
      taskName: 'Task',
      startedAt: '2026-05-08T12:05:37.000Z',
      status: 'completed',
      prompt: 'prompt',
      hasOutput: true,
    }
    let resolveDetail: (run: TaskRun) => void = () => {}
    const detailRequest = new Promise<TaskRun>((resolve) => { resolveDetail = resolve })
    let listCalls = 0
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      fetchTaskRuns: vi.fn(async () => {
        listCalls += 1
        return listCalls === 1 ? [summary] : [{ ...summary, output: 'newer list output' }]
      }),
      fetchTaskRunDetail: vi.fn(() => detailRequest),
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    const view = render(<TaskRunsPanel taskId="task-1" refreshKey={0} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))
    view.rerender(<TaskRunsPanel taskId="task-1" refreshKey={1} onClose={vi.fn()} />)
    expect(await screen.findByText('newer list output')).toBeInTheDocument()

    await act(async () => {
      resolveDetail({ ...summary, output: 'stale detail output' })
      await detailRequest
    })

    await waitFor(() => expect(screen.getByText('newer list output')).toBeInTheDocument())
    expect(screen.queryByText('stale detail output')).not.toBeInTheDocument()
  })

  it('keeps loaded detail visible across later summary-only polls', async () => {
    const summary: TaskRun = {
      id: 'run-cached-detail',
      taskId: 'task-1',
      taskName: 'Task',
      startedAt: '2026-05-08T12:05:37.000Z',
      status: 'completed',
      prompt: 'prompt',
      hasOutput: true,
    }
    const fetchRuns = vi.fn(async () => [summary])
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      fetchTaskRuns: fetchRuns,
      fetchTaskRunDetail: vi.fn(async () => ({
        ...summary,
        output: 'cached detail output',
      })),
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    const view = render(<TaskRunsPanel taskId="task-1" refreshKey={0} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))
    expect(await screen.findByText('cached detail output')).toBeInTheDocument()

    view.rerender(<TaskRunsPanel taskId="task-1" refreshKey={1} onClose={vi.fn()} />)
    await waitFor(() => expect(fetchRuns).toHaveBeenCalledTimes(2))
    expect(screen.getByText('cached detail output')).toBeInTheDocument()
  })

  it('discards a slow detail response after collapse and retries on the next expansion', async () => {
    const summary: TaskRun = {
      id: 'run-collapse',
      taskId: 'task-1',
      taskName: 'Task',
      startedAt: '2026-05-08T12:05:37.000Z',
      status: 'completed',
      prompt: 'prompt',
      hasOutput: true,
    }
    let resolveFirst: (run: TaskRun) => void = () => {}
    const firstDetail = new Promise<TaskRun>((resolve) => { resolveFirst = resolve })
    const fetchDetail = vi.fn()
      .mockReturnValueOnce(firstDetail)
      .mockReturnValue(new Promise<TaskRun>(() => {}))
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      fetchTaskRuns: vi.fn(async () => [summary]),
      fetchTaskRunDetail: fetchDetail,
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    render(<TaskRunsPanel taskId="task-1" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    await act(async () => {
      resolveFirst({ ...summary, output: 'discarded detail' })
      await firstDetail
    })

    fireEvent.click(screen.getByRole('button', { name: 'Summary' }))
    expect(fetchDetail).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('discarded detail')).not.toBeInTheDocument()
  })

  it('resets selection and rejects old detail after the selected task changes', async () => {
    const summary = (taskId: string): TaskRun => ({
      id: 'shared-run-id',
      taskId,
      taskName: taskId,
      startedAt: '2026-05-08T12:05:37.000Z',
      status: 'completed',
      prompt: taskId,
      hasOutput: true,
    })
    let resolveOldDetail: (run: TaskRun) => void = () => {}
    const oldDetail = new Promise<TaskRun>((resolve) => { resolveOldDetail = resolve })
    const fetchDetail = vi.fn(() => oldDetail)
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      fetchTaskRuns: vi.fn(async (taskId: string) => [summary(taskId)]),
      fetchTaskRunDetail: fetchDetail,
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    const view = render(<TaskRunsPanel taskId="old-task" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))
    view.rerender(<TaskRunsPanel taskId="new-task" onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Summary' })).toBeInTheDocument())
    await act(async () => {
      resolveOldDetail({ ...summary('old-task'), output: 'old task detail' })
      await oldDetail
    })

    expect(screen.queryByText('old task detail')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hide' })).not.toBeInTheDocument()
  })

  it('keeps lazy detail functional through the StrictMode effect lifecycle', async () => {
    const summary: TaskRun = {
      id: 'strict-run',
      taskId: 'task-1',
      taskName: 'Task',
      startedAt: '2026-05-08T12:05:37.000Z',
      status: 'completed',
      prompt: 'prompt',
      hasOutput: true,
    }
    useSettingsStore.setState({ locale: 'en' })
    useTaskStore.setState({
      fetchTaskRuns: vi.fn(async () => [summary]),
      fetchTaskRunDetail: vi.fn(async () => ({ ...summary, output: 'strict detail' })),
    } as Partial<ReturnType<typeof useTaskStore.getState>>)

    render(
      <StrictMode>
        <TaskRunsPanel taskId="task-1" onClose={vi.fn()} />
      </StrictMode>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Summary' }))

    expect(await screen.findByText('strict detail')).toBeInTheDocument()
  })
})
