import { afterEach, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { SessionScheduleMark } from './SessionScheduleMark'
import { useTaskStore } from '@/stores/taskStore'
import { useSettingsStore } from '@/stores/settingsStore'

afterEach(() => { cleanup(); useTaskStore.setState(useTaskStore.getInitialState(), true) })

it('marks only attached unfinished tasks, including paused tasks, without nested buttons', () => {
  useSettingsStore.setState({ locale: 'en' })
  const task = { id: 'task', name: 'Check', cron: '0 9 * * *', prompt: 'Check', enabled: false, createdAt: 1, execution: { kind: 'session' as const, targetSessionId: 'session' } }
  useTaskStore.setState({ tasks: [task] })
  const { rerender } = render(<button><SessionScheduleMark sessionId="session" /></button>)
  expect(screen.getByRole('img', { name: /Paused/ })).toBeInTheDocument()
  expect(screen.getAllByRole('button')).toHaveLength(1)
  act(() => useTaskStore.setState({ tasks: [{ ...task, scheduleState: 'completed' }] }))
  rerender(<button><SessionScheduleMark sessionId="session" /></button>)
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})
