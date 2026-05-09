import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { NewTaskModal } from './NewTaskModal'
import { useAdapterStore } from '../../stores/adapterStore'
import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTaskStore } from '../../stores/taskStore'

afterEach(() => {
  cleanup()
  useAdapterStore.setState(useAdapterStore.getInitialState(), true)
  useProviderStore.setState(useProviderStore.getInitialState(), true)
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  useTaskStore.setState(useTaskStore.getInitialState(), true)
})

describe('NewTaskModal', () => {
  it('creates scheduled tasks with a provider-scoped model selection', async () => {
    const createTask = vi.fn(async () => {})
    useTaskStore.setState({ createTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
    useAdapterStore.setState({
      fetchConfig: vi.fn(async () => {}),
      config: {},
    } as Partial<ReturnType<typeof useAdapterStore.getState>>)
    useSettingsStore.setState({
      locale: 'en',
      currentModel: {
        id: 'provider-main',
        name: 'provider-main',
        description: '',
        context: '',
      },
      availableModels: [
        { id: 'claude-sonnet-4-6', name: 'Sonnet', description: '', context: '' },
      ],
      activeProviderName: 'Provider A',
    })
    useProviderStore.setState({
      providers: [{
        id: 'provider-a',
        presetId: 'custom',
        name: 'Provider A',
        apiKey: '***',
        baseUrl: 'https://api.example.com',
        apiFormat: 'anthropic',
        models: {
          main: 'provider-main',
          haiku: 'provider-fast',
          sonnet: 'provider-main',
          opus: '',
        },
      }],
      activeId: 'provider-a',
      hasLoadedProviders: true,
      isLoading: true,
    })

    render(<NewTaskModal open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: 'provider cron' },
    })
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'exercise provider selection' },
    })
    fireEvent.change(screen.getByPlaceholderText(/Look at the commits/i), {
      target: { value: 'Say hello from the scheduled task.' },
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /provider-main/i }))
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /provider-fast/i }))
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
      await Promise.resolve()
    })

    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      model: 'provider-fast',
      providerId: 'provider-a',
      enabled: true,
      recurring: true,
    }))
  })
})
