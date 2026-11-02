import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { TaskRow } from './TaskRow'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTaskStore } from '../../stores/taskStore'
import type { CronTask } from '../../types/task'

const task: CronTask = {
  id: 'task-1',
  name: 'daily-code-review',
  description: 'Review yesterday’s commits',
  cron: '*/20 * * * *',
  prompt: 'Look at the commits',
  enabled: true,
  createdAt: Date.parse('2026-07-26T09:00:00.000Z'),
  lastFiredAt: '2026-07-26T09:20:00.000Z',
}

function renderRow(props: Partial<Parameters<typeof TaskRow>[0]> = {}) {
  useSettingsStore.setState({ locale: 'en' })
  return render(
    <TaskRow task={task} showLogs={false} onToggleLogs={vi.fn()} {...props} />,
  )
}

afterEach(() => {
  cleanup()
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  useTaskStore.setState(useTaskStore.getInitialState(), true)
})

describe('TaskRow', () => {
  it('exposes the logs toggle as a pressed state rather than a background class', () => {
    // The open state used to be a bare `bg-[…]` override, which is invisible to
    // assistive tech and could lose to the tone's own hover fill depending on
    // stylesheet order.
    const { rerender } = renderRow()
    expect(screen.getByRole('button', { name: 'Logs' })).toHaveAttribute('aria-pressed', 'false')

    rerender(<TaskRow task={task} showLogs onToggleLogs={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Logs' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('reads the schedule out as one caption line with the raw cron on hover', () => {
    renderRow()
    expect(screen.getByTitle('*/20 * * * *')).toHaveTextContent('Runs every 20 minutes')
    // Created / last run / description used to be two stacked lines; the handoff
    // folds them into a single caption separated by middots.
    expect(screen.getByText(/Review yesterday/)).toHaveTextContent(/Created: .+ · Last run: .+ · Review/)
  })

  it('keeps the run button unavailable while the task is disabled', () => {
    renderRow({ task: { ...task, enabled: false } })
    expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled()
  })

  it('names the menu items by their label alone, not by the icon ligature', () => {
    // The material-symbols spans render their glyph name as text, so without
    // `aria-hidden` every menu item was announced as "edit Edit".
    renderRow()
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('shows a finished one-time task as completed and offers no enable action', () => {
    renderRow({ task: { ...task, enabled: false, scheduleState: 'completed' } })
    expect(screen.getByLabelText('Completed')).toBeInTheDocument()
    expect(screen.queryByLabelText('Disabled')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument()
  })

  it('does not leak an unhandled rejection when the server refuses to resume a task', async () => {
    const updateTask = vi.fn().mockRejectedValue(new Error('One-time task must be scheduled in the future'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    useTaskStore.setState({ updateTask })
    renderRow({ task: { ...task, enabled: false } })
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }))
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith('Failed to update task:', expect.any(Error)))
    consoleError.mockRestore()
  })
})
