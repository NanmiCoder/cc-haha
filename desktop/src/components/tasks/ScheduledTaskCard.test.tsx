import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ScheduledTaskCard } from './ScheduledTaskCard'
import { useTaskStore } from '@/stores/taskStore'
import { useSettingsStore } from '@/stores/settingsStore'
import type { ScheduledTaskResult } from '@/lib/scheduledTask'

const result: ScheduledTaskResult = { schemaVersion: 1, kind: 'scheduled_task', operation: 'created', taskId: 'task', task: { id: 'task', name: 'Check build', cron: '0 9 * * *', prompt: 'Check', enabled: true, createdAt: 1 } }
afterEach(() => { cleanup(); useTaskStore.setState(useTaskStore.getInitialState(), true) })

it('opens the shared editor and follows live paused/deleted state without losing history', () => {
  useSettingsStore.setState({ locale: 'en' })
  const openTaskEditor = vi.fn()
  useTaskStore.setState({ tasks: [{ ...result.task, enabled: false }], loaded: true, openTaskEditor })
  const { rerender } = render(<ScheduledTaskCard result={result} />)
  expect(screen.getByText('Paused')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Open task' }))
  expect(openTaskEditor).toHaveBeenCalledWith('task')
  act(() => useTaskStore.setState({ tasks: [] }))
  rerender(<ScheduledTaskCard result={result} />)
  expect(screen.getByText('Check build')).toBeInTheDocument()
  expect(screen.getByText('Task deleted')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Open task' })).toBeDisabled()
})

it('does not treat an unavailable task list as deletion', () => {
  useSettingsStore.setState({ locale: 'en' })
  useTaskStore.setState({ loaded: true, error: 'offline' })
  render(<ScheduledTaskCard result={result} />)
  expect(screen.queryByText('Task deleted')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Open task' })).toBeEnabled()
})
