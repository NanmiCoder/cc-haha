import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useScheduledTasksSync } from './useScheduledTasksSync'
import { useTaskStore } from '@/stores/taskStore'

afterEach(() => { cleanup(); vi.useRealTimers(); useTaskStore.setState(useTaskStore.getInitialState(), true) })

function Host({ ready }: { ready: boolean }) { useScheduledTasksSync(ready); return null }

it('refreshes only after connection readiness and coalesces focus while a request is active', () => {
  vi.useFakeTimers()
  const fetchTasks = vi.fn(async () => {})
  useTaskStore.setState({ fetchTasks })
  const { rerender, unmount } = render(<Host ready={false} />)
  expect(fetchTasks).not.toHaveBeenCalled()
  rerender(<Host ready />)
  expect(fetchTasks).toHaveBeenCalledTimes(1)
  useTaskStore.setState({ isLoading: true })
  act(() => { window.dispatchEvent(new Event('focus')); vi.advanceTimersByTime(30_000) })
  expect(fetchTasks).toHaveBeenCalledTimes(1)
  useTaskStore.setState({ isLoading: false })
  act(() => window.dispatchEvent(new Event('focus')))
  expect(fetchTasks).toHaveBeenCalledTimes(2)
  unmount()
  act(() => { window.dispatchEvent(new Event('focus')); vi.advanceTimersByTime(30_000) })
  expect(fetchTasks).toHaveBeenCalledTimes(2)
})
