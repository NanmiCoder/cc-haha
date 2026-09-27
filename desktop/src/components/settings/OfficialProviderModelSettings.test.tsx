import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { modelsApi } from '@/api/models'
import { providersApi } from '@/api/providers'
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
    vi.spyOn(modelsApi, 'list').mockResolvedValue({
      models: [
        { id: 'gpt-6-astra', name: 'GPT-6 Astra', description: 'Frontier', context: '258400' },
        { id: 'gpt-6-sol', name: 'GPT-6 Sol', description: 'Workhorse', context: '258400' },
        { id: 'gpt-6-luna', name: 'GPT-6 Luna', description: 'Fast', context: '258400' },
      ],
      provider: { id: 'openai-official', name: 'ChatGPT Official' },
    })
    vi.spyOn(providersApi, 'getOfficialModels').mockResolvedValue({ models: mapping })
    vi.spyOn(providersApi, 'updateOfficialModels').mockImplementation(async (_id, models) => ({ models }))
    vi.spyOn(useSettingsStore.getState(), 'fetchAll').mockResolvedValue()
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
  })

  it('keeps manual model entry available when the OAuth catalog request fails', async () => {
    vi.mocked(modelsApi.list).mockRejectedValueOnce(new Error('catalog unavailable'))
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
