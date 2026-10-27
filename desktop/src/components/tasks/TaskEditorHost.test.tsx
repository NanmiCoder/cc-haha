import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { TaskEditorHost } from './TaskEditorHost'
import { useTaskStore } from '@/stores/taskStore'
import { useSettingsStore } from '@/stores/settingsStore'

vi.mock('./NewTaskModal', () => ({ NewTaskModal: ({ editTask }: { editTask: { name: string } }) => <div role="dialog">{editTask.name}</div> }))
afterEach(() => { cleanup(); useTaskStore.setState(useTaskStore.getInitialState(), true) })

it('opens the editor by task ID regardless of the originating page', () => {
  useSettingsStore.setState({ locale: 'en' })
  const fetchTasks = vi.fn(async () => {})
  useTaskStore.setState({ editorTaskId: 'task', loaded: true, fetchTasks, tasks: [{ id: 'task', name: 'Check', cron: '0 9 * * *', prompt: 'Check', enabled: true, createdAt: 1 }] })
  render(<TaskEditorHost />)
  expect(screen.getByRole('dialog')).toHaveTextContent('Check')
  expect(fetchTasks).toHaveBeenCalledOnce()
})
