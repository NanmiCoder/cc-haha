import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
      output: '最近7天有3个commit，主要改动：\n\n**1. 2865d50 - UI无障碍改进**\n- 添加 theme-color meta 标签\n- 修复 select 标签问题',
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

    expect(screen.getByText('1. 2865d50 - UI无障碍改进')).toBeInTheDocument()
    expect(container.querySelector('strong')).toHaveTextContent('1. 2865d50 - UI无障碍改进')
    expect(screen.getByText('添加 theme-color meta 标签')).toBeInTheDocument()
    expect(container.querySelector('li')).toHaveTextContent('添加 theme-color meta 标签')
    expect(container.textContent).not.toContain('**1. 2865d50')
  })
})
