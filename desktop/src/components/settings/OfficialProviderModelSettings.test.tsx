import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { modelsApi } from '@/api/models'
import { providersApi } from '@/api/providers'
import { useProviderStore } from '@/stores/providerStore'
import { useHahaOpenAIOAuthStore } from '@/stores/hahaOpenAIOAuthStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { OfficialProviderModelSettings } from './OfficialProviderModelSettings'

const mapping = {
  main: 'gpt-6-sol',
  haiku: 'gpt-6-luna',
  sonnet: 'gpt-6-sol',
  opus: 'gpt-6-astra',
}

const futureCatalog = {
  models: [{ id: 'gpt-future', name: 'Future GPT', description: '', context: '1000000' }],
}

describe('OfficialProviderModelSettings', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useHahaOpenAIOAuthStore.setState({ status: null })
    vi.spyOn(modelsApi, 'catalog').mockResolvedValue({
      models: [
        { id: 'gpt-6-astra', name: 'GPT-6 Astra', description: 'Frontier', context: '258400' },
        { id: 'gpt-6-sol', name: 'GPT-6 Sol', description: 'Workhorse', context: '258400' },
        { id: 'gpt-6-luna', name: 'GPT-6 Luna', description: 'Fast', context: '258400' },
      ],
    })
    vi.spyOn(modelsApi, 'list').mockRejectedValue(new Error('the active provider\'s list must not be used'))
    vi.spyOn(providersApi, 'getOfficialModels').mockResolvedValue({ models: mapping })
    vi.spyOn(providersApi, 'updateOfficialModels').mockImplementation(async (_id, models) => ({ models }))
    vi.spyOn(useSettingsStore.getState(), 'fetchAll').mockResolvedValue()
    vi.spyOn(useProviderStore.getState(), 'fetchProviders').mockResolvedValue()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('loads OAuth models, lets the user remap aliases, and persists the selection', async () => {
    render(<OfficialProviderModelSettings providerId="openai-official" />)

    const main = await screen.findByRole('combobox', { name: /Main Model/ })
    expect(main).toHaveValue('gpt-6-sol')

    fireEvent.focus(main)
    fireEvent.click(await screen.findByRole('option', { name: 'gpt-6-astra' }))
    fireEvent.change(screen.getByRole('combobox', { name: /Fable Model/ }), {
      target: { value: 'gpt-6-luna' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save model mapping' }))

    await waitFor(() => expect(providersApi.updateOfficialModels).toHaveBeenCalledWith(
      'openai-official',
      {
        main: 'gpt-6-astra',
        fable: 'gpt-6-luna',
        haiku: 'gpt-6-luna',
        sonnet: 'gpt-6-sol',
        opus: 'gpt-6-astra',
      },
    ))
    expect(await screen.findByRole('status')).toHaveTextContent('Model mapping saved')
    expect(useSettingsStore.getState().fetchAll).toHaveBeenCalled()
    // The model picker reads saved mappings from the provider store.
    expect(useProviderStore.getState().fetchProviders).toHaveBeenCalled()
  })

  it('offers the models of the card\'s own provider account, not the active provider\'s', async () => {
    vi.mocked(modelsApi.catalog).mockImplementation(async (providerId) => ({
      models: providerId === 'deepseek-account'
        ? [
            { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', description: '', context: '1048576' },
            { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', description: '', context: '1048576' },
          ]
        : [{ id: 'grok-4.7', name: 'Grok 4.7', description: '', context: '500000' }],
    }))
    vi.mocked(providersApi.getOfficialModels).mockResolvedValue({
      models: { main: 'deepseek-v4-pro[1m]', haiku: 'deepseek-flash', sonnet: 'deepseek-v4-pro[1m]', opus: 'deepseek-v4-pro[1m]' },
    })
    render(<OfficialProviderModelSettings providerId="deepseek-account" />)

    const main = await screen.findByRole('combobox', { name: /Main Model/ })
    fireEvent.focus(main)
    fireEvent.change(main, { target: { value: '' } })

    expect(await screen.findByRole('option', { name: 'deepseek-flash' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'deepseek-v4-pro' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'grok-4.7' })).not.toBeInTheDocument()
    expect(modelsApi.catalog).toHaveBeenCalledWith('deepseek-account')
    expect(modelsApi.list).not.toHaveBeenCalled()
  })

  it('keeps manual model entry available when the OAuth catalog request fails', async () => {
    vi.mocked(modelsApi.catalog).mockRejectedValueOnce(new Error('catalog unavailable'))
    render(<OfficialProviderModelSettings providerId="openai-official" />)

    const main = await screen.findByRole('textbox', { name: /Main Model/ })
    fireEvent.change(main, { target: { value: 'future-oauth-model' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save model mapping' }))

    await waitFor(() => expect(providersApi.updateOfficialModels).toHaveBeenCalledWith(
      'openai-official',
      expect.objectContaining({ main: 'future-oauth-model' }),
    ))
  })

  it('refreshes upstream models without changing unsaved mappings, then saves a newly discovered model', async () => {
    render(<OfficialProviderModelSettings providerId="openai-official" />)
    const main = await screen.findByRole('combobox', { name: /Main Model/ })
    fireEvent.change(main, { target: { value: 'my-unsaved-model' } })

    let completeRefresh!: (value: typeof futureCatalog) => void
    vi.mocked(modelsApi.catalog).mockImplementationOnce(() => new Promise((resolve) => { completeRefresh = resolve }))
    const refresh = screen.getByRole('button', { name: 'Refresh model list' })
    fireEvent.click(refresh)
    expect(refresh).toBeDisabled()
    expect(refresh).toHaveAttribute('aria-busy', 'true')
    expect(modelsApi.catalog).toHaveBeenLastCalledWith('openai-official', { forceRefresh: true })

    await act(async () => completeRefresh(futureCatalog))
    expect(main).toHaveValue('my-unsaved-model')
    expect(providersApi.updateOfficialModels).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().fetchAll).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status')).toHaveTextContent('Model list updated (1)')
    expect(refresh).toBeEnabled()

    fireEvent.change(main, { target: { value: '' } })
    fireEvent.focus(main)
    fireEvent.click(await screen.findByRole('option', { name: 'gpt-future' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save model mapping' }))
    await waitFor(() => expect(providersApi.updateOfficialModels).toHaveBeenCalledWith(
      'openai-official', expect.objectContaining({ main: 'gpt-future' }),
    ))
  })

  it.each(['error', 'empty'] as const)('preserves the previous list on an %s refresh and permits retry', async (outcome) => {
    render(<OfficialProviderModelSettings providerId="openai-official" />)
    const main = await screen.findByRole('combobox', { name: /Main Model/ })
    if (outcome === 'error') {
      vi.mocked(modelsApi.catalog).mockRejectedValueOnce(new Error('upstream rejected the request'))
    } else {
      vi.mocked(modelsApi.catalog).mockResolvedValueOnce({ models: [] })
    }
    const refresh = screen.getByRole('button', { name: 'Refresh model list' })
    fireEvent.click(refresh)
    const error = await screen.findByRole('alert')
    expect(error).toHaveTextContent('The previous list is still available')
    expect(refresh).toHaveAttribute('aria-describedby', error.id)
    expect(refresh).toBeEnabled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(main).toHaveValue('gpt-6-sol')
    fireEvent.focus(main)
    expect(await screen.findByRole('option', { name: 'gpt-6-astra' })).toBeInTheDocument()
    expect(useSettingsStore.getState().fetchAll).not.toHaveBeenCalled()

    vi.mocked(modelsApi.catalog).mockResolvedValueOnce(futureCatalog)
    fireEvent.click(refresh)
    expect(await screen.findByRole('status')).toHaveTextContent('Model list updated (1)')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps the previous catalog and shows only failure when syncing the chat model list fails', async () => {
    render(<OfficialProviderModelSettings providerId="openai-official" />)
    const main = await screen.findByRole('combobox', { name: /Main Model/ })
    vi.mocked(modelsApi.catalog).mockResolvedValueOnce(futureCatalog)
    vi.mocked(useSettingsStore.getState().fetchAll).mockRejectedValueOnce(new Error('chat model list unavailable'))

    fireEvent.click(screen.getByRole('button', { name: 'Refresh model list' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The previous list is still available')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh model list' })).toBeEnabled()
    fireEvent.focus(main)
    expect(await screen.findByRole('option', { name: 'gpt-6-astra' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'gpt-future' })).not.toBeInTheDocument()
  })

  it('ignores a refresh from the previous provider after switching cards', async () => {
    const { rerender } = render(<OfficialProviderModelSettings providerId="openai-official" />)
    await screen.findByRole('combobox', { name: /Main Model/ })
    let completeRefresh!: (value: typeof futureCatalog) => void
    vi.mocked(modelsApi.catalog).mockImplementationOnce(() => new Promise((resolve) => { completeRefresh = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh model list' }))

    vi.mocked(providersApi.getOfficialModels).mockResolvedValueOnce({
      models: { main: 'grok-next', haiku: 'grok-next', sonnet: 'grok-next', opus: 'grok-next' },
    })
    vi.mocked(modelsApi.catalog).mockResolvedValueOnce({
      models: [{ id: 'grok-next', name: 'Next Grok', description: '', context: '' }],
    })
    rerender(<OfficialProviderModelSettings providerId="grok-official" />)
    const main = await screen.findByRole('combobox', { name: /Main Model/ })
    await act(async () => completeRefresh(futureCatalog))

    expect(main).toHaveValue('grok-next')
    fireEvent.focus(main)
    expect(await screen.findByRole('option', { name: 'grok-next' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'gpt-future' })).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(useSettingsStore.getState().fetchAll).not.toHaveBeenCalled()
  })

  it('clears the old provider catalog when the new provider catalog cannot load', async () => {
    const { rerender } = render(<OfficialProviderModelSettings providerId="openai-official" />)
    await screen.findByRole('combobox', { name: /Main Model/ })
    vi.mocked(modelsApi.catalog).mockRejectedValueOnce(new Error('unavailable'))
    rerender(<OfficialProviderModelSettings providerId="grok-official" />)
    await screen.findByRole('textbox', { name: /Main Model/ })
    expect(screen.queryByRole('combobox', { name: /Main Model/ })).not.toBeInTheDocument()
  })

  it('does not update the chat model store when a refresh finishes after unmounting', async () => {
    const { unmount } = render(<OfficialProviderModelSettings providerId="openai-official" />)
    await screen.findByRole('combobox', { name: /Main Model/ })
    let completeRefresh!: (value: typeof futureCatalog) => void
    vi.mocked(modelsApi.catalog).mockImplementationOnce(() => new Promise((resolve) => { completeRefresh = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh model list' }))
    unmount()
    await act(async () => completeRefresh(futureCatalog))
    expect(useSettingsStore.getState().fetchAll).not.toHaveBeenCalled()
  })

  it('ignores the previous account refresh after signing in to another account of the same provider', async () => {
    useHahaOpenAIOAuthStore.setState({
      status: { loggedIn: true, accountId: 'account-a', email: 'a@example.test', expiresAt: null },
    })
    render(<OfficialProviderModelSettings providerId="openai-official" />)
    await screen.findByRole('combobox', { name: /Main Model/ })
    let completeRefresh!: (value: typeof futureCatalog) => void
    vi.mocked(modelsApi.catalog).mockImplementationOnce(() => new Promise((resolve) => { completeRefresh = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh model list' }))

    vi.mocked(modelsApi.catalog).mockResolvedValueOnce({
      models: [{ id: 'account-b-model', name: 'Account B model', description: '', context: '' }],
    })
    act(() => useHahaOpenAIOAuthStore.setState({
      status: { loggedIn: true, accountId: 'account-b', email: 'b@example.test', expiresAt: null },
    }))
    const main = await screen.findByRole('combobox', { name: /Main Model/ })
    await act(async () => completeRefresh(futureCatalog))
    fireEvent.focus(main)
    expect(await screen.findByRole('option', { name: 'account-b-model' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'gpt-future' })).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(useSettingsStore.getState().fetchAll).not.toHaveBeenCalled()
  })
})
