import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { NewTaskModal } from './NewTaskModal'
import { useAdapterStore } from '../../stores/adapterStore'
import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTaskStore } from '../../stores/taskStore'
import {
  buildOneShotCron,
  toDateTimeLocalValue,
} from '../../lib/oneShotCron'
import type { CronTask } from '../../types/task'

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
      permissionMode: 'bypassPermissions',
      enabled: true,
      recurring: true,
    }))
  })

  describe('schedule controls', () => {
    function renderModal() {
      useSettingsStore.setState({ locale: 'en' })
      useAdapterStore.setState({
        fetchConfig: vi.fn(async () => {}),
        config: {},
      } as Partial<ReturnType<typeof useAdapterStore.getState>>)
      return render(<NewTaskModal open onClose={vi.fn()} />)
    }

    it('gives the frequency select a name', () => {
      // All seven native selects in the app shipped without a label or an
      // `aria-label`, leaving them nameless in the accessibility tree.
      renderModal()
      expect(screen.getByLabelText('Frequency')).toHaveValue('daily')
    })

    it('names the time field even though it shares the frequency caption', () => {
      // One「频率」heading covers both controls, so the time input carries its
      // name on `aria-label` rather than a second visible label.
      renderModal()
      expect(screen.getByLabelText('Run time')).toHaveValue('09:00')
    })

    it('announces an invalid custom cron instead of only printing it', () => {
      renderModal()
      fireEvent.change(screen.getByLabelText('Frequency'), { target: { value: 'customCron' } })

      const cronField = screen.getByLabelText('Custom cron expression')
      fireEvent.change(cronField, { target: { value: 'not a cron' } })

      expect(screen.getByRole('alert')).toHaveTextContent('Invalid cron expression')
      expect(cronField).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled()
    })
  })

  describe('one-shot reservation', () => {
    function renderModal(props: { editTask?: CronTask } = {}) {
      const createTask = vi.fn(async () => {})
      const updateTask = vi.fn(async () => {})
      useTaskStore.setState({ createTask, updateTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
      useSettingsStore.setState({ locale: 'en' })
      useAdapterStore.setState({
        fetchConfig: vi.fn(async () => {}),
        config: {},
      } as Partial<ReturnType<typeof useAdapterStore.getState>>)
      render(<NewTaskModal open onClose={vi.fn()} {...props} />)
      return { createTask, updateTask }
    }

    function fillRequiredFields() {
      fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'standup ping' } })
      fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'one-time send' } })
      fireEvent.change(screen.getByPlaceholderText(/Look at the commits/i), { target: { value: 'send the reminder' } })
    }

    it('creates a non-recurring task pinned to the chosen time', () => {
      const { createTask } = renderModal()
      fillRequiredFields()
      fireEvent.change(screen.getByLabelText('Frequency'), { target: { value: 'oneShot' } })

      const target = new Date(Date.now() + 2 * 60 * 60 * 1000)
      target.setSeconds(0, 0)
      const datetime = toDateTimeLocalValue(target)
      fireEvent.change(screen.getByLabelText('Send at'), { target: { value: datetime } })

      fireEvent.click(screen.getByRole('button', { name: 'Create task' }))

      expect(createTask).toHaveBeenCalledTimes(1)
      expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
        recurring: false,
        enabled: true,
        cron: buildOneShotCron(target),
      }))
    })

    it('disables submit and warns when the target is beyond the 48h window', () => {
      renderModal()
      fillRequiredFields()
      fireEvent.change(screen.getByLabelText('Frequency'), { target: { value: 'oneShot' } })

      const tooFar = new Date(Date.now() + 72 * 60 * 60 * 1000)
      tooFar.setSeconds(0, 0)
      fireEvent.change(screen.getByLabelText('Send at'), { target: { value: toDateTimeLocalValue(tooFar) } })

      expect(screen.getByRole('alert')).toHaveTextContent('Pick a future time within the next 48 hours.')
      expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled()
    })

    it('loads an existing reservation back into the one-shot picker when editing', () => {
      const target = new Date(Date.now() + 3 * 60 * 60 * 1000)
      target.setSeconds(0, 0)
      const editTask: CronTask = {
        id: 'res-1',
        name: 'standup ping',
        description: 'one-time send',
        cron: buildOneShotCron(target),
        prompt: 'send the reminder',
        enabled: true,
        recurring: false,
        createdAt: target.getTime() - 60 * 60 * 1000,
      }
      renderModal({ editTask })

      expect(screen.getByLabelText('Frequency')).toHaveValue('oneShot')
      expect(screen.getByLabelText('Send at')).toHaveValue(toDateTimeLocalValue(target))
    })
  })
})
