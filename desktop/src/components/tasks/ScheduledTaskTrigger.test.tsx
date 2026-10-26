import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ScheduledTaskTrigger } from './ScheduledTaskTrigger'
import { useTaskStore } from '@/stores/taskStore'
import { useSettingsStore } from '@/stores/settingsStore'

afterEach(() => { cleanup(); useTaskStore.setState(useTaskStore.getInitialState(), true) })

it('names the scheduled source and opens the actual task', () => {
  useSettingsStore.setState({ locale: 'en' })
  const openTaskEditor = vi.fn()
  useTaskStore.setState({ openTaskEditor })
  render(<ScheduledTaskTrigger trigger={{ taskId: 'task', runId: 'run', taskName: 'Check build', scheduledFor: '2030-01-01T01:00:00Z' }} />)
  expect(screen.getByText('Sent by scheduled task')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Check build' }))
  expect(openTaskEditor).toHaveBeenCalledWith('task')
})
