import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { modelsApi } from '@/api/models'
import { providersApi } from '@/api/providers'
import { useProviderStore } from '@/stores/providerStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { OfficialProviderModelSettings } from './OfficialProviderModelSettings'

const mapping = {
  main: 'gpt-6-sol',
  haiku: 'gpt-6-luna',
  sonnet: 'gpt-6-sol',
  opus: 'gpt-6-astra',
}

describe('OfficialProviderModelSettings', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
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
})
