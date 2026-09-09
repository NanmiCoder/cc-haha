import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { providersApi } from '../../api/providers'
import { getDesktopHost } from '../../lib/desktopHost'
import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'
import type { SavedProvider } from '../../types/provider'
import { ProviderSettings } from './ProviderSettings'

vi.mock('../../components/settings/ClaudeOfficialLogin', () => ({ ClaudeOfficialLogin: () => null }))
vi.mock('../../components/settings/ChatGPTOfficialLogin', () => ({ ChatGPTOfficialLogin: () => null }))
vi.mock('../../components/settings/GrokOfficialLogin', () => ({ GrokOfficialLogin: () => null }))

const savedProviders: SavedProvider[] = ([
  ['xuanshuapi', '玄枢API', 'https://www.xuanshuapi.com', 'claude-sonnet-5'],
  ['fennoai', 'FennoAI', 'https://api.fenno.ai', 'claude-sonnet-5'],
  ['qiniuai', '七牛云 AI', 'https://api.qnaigc.com', 'deepseek/deepseek-v4-pro'],
] as const).map(([presetId, name, baseUrl, model]) => ({
  id: `saved-${presetId}`,
  presetId,
  name,
  baseUrl,
  apiKey: 'fake-saved-api-key',
  apiFormat: 'anthropic',
  models: { main: model, haiku: model, sonnet: model, opus: model },
}))

describe('ApiSmart sponsor provider', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    vi.spyOn(useSettingsStore.getState(), 'fetchAll').mockResolvedValue()
    vi.spyOn(providersApi, 'list').mockResolvedValue({ providers: [], activeId: null })
    vi.spyOn(providersApi, 'getSettings').mockResolvedValue({})
    vi.spyOn(providersApi, 'updateSettings').mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('prefills the sponsor connection, opens its landing page, and saves the selected models', async () => {
    const open = vi.spyOn(getDesktopHost().shell, 'open').mockResolvedValue()
    const create = vi.spyOn(providersApi, 'create').mockImplementation(async (input) => ({
      provider: { ...input, id: 'saved-apismart', apiFormat: input.apiFormat ?? 'anthropic' },
    }))
    render(<ProviderSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Add Provider/ }))
    const dialog = within(screen.getByRole('dialog'))
    const sponsor = dialog.getByRole('button', { name: 'ApiSmart' })
    expect(sponsor.parentElement).toBe(dialog.getByRole('button', { name: 'Atlas Cloud' }).parentElement)
    fireEvent.click(sponsor)
    expect(dialog.getByDisplayValue('https://gw.apismart.ai/v1')).toBeInTheDocument()
    expect(dialog.getAllByDisplayValue('deepseek-v4-pro-0813')).toHaveLength(3)
    expect(dialog.getByDisplayValue('deepseek-v4-flash-0731-tem')).toBeInTheDocument()
    expect(dialog.getByRole('switch', { name: 'Enable image generation' })).toBeChecked()
    expect(dialog.getByDisplayValue('doubao-seedream-5-0')).toBeInTheDocument()

    fireEvent.click(dialog.getByRole('button', { name: /Get API Key/ }))
    expect(open).toHaveBeenCalledWith('https://www.apismart.ai')
    fireEvent.change(dialog.getAllByPlaceholderText('sk-...')[0]!, { target: { value: 'fake-apismart-key' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      presetId: 'apismart',
      name: 'ApiSmart',
      baseUrl: 'https://gw.apismart.ai/v1',
      apiFormat: 'openai_chat',
      authStrategy: 'api_key',
      apiKey: 'fake-apismart-key',
      imageGeneration: { model: 'doubao-seedream-5-0' },
      models: {
        main: 'deepseek-v4-pro-0813',
        haiku: 'deepseek-v4-flash-0731-tem',
        sonnet: 'deepseek-v4-pro-0813',
        opus: 'deepseek-v4-pro-0813',
      },
    })))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('resets image credentials and defaults when switching presets', async () => {
    render(<ProviderSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Add Provider/ }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: 'ApiSmart' }))
    fireEvent.change(dialog.getAllByPlaceholderText('sk-...')[1]!, { target: { value: 'fake-image-only-key' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Atlas Cloud' }))
    expect(dialog.getByRole('switch', { name: 'Enable image generation' })).not.toBeChecked()
    fireEvent.click(dialog.getByRole('button', { name: 'ApiSmart' }))
    expect(dialog.getByDisplayValue('doubao-seedream-5-0')).toBeInTheDocument()
    expect(dialog.getAllByPlaceholderText('sk-...')[1]).toHaveValue('')
  })

  it('preserves image generation disabled on an older saved ApiSmart provider', async () => {
    vi.mocked(providersApi.list).mockResolvedValue({ providers: [{
      ...savedProviders[0]!, id: 'old-apismart', presetId: 'apismart', name: 'ApiSmart',
      baseUrl: 'https://gw.apismart.ai/v1', apiFormat: 'openai_chat',
    }], activeId: null })
    render(<ProviderSettings />)
    const card = await screen.findByTestId('provider-old-apismart')
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }))
    expect(within(screen.getByRole('dialog')).getByRole('switch', { name: 'Enable image generation' }))
      .not.toBeChecked()
  })
})

describe('retired sponsor providers', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    vi.spyOn(useSettingsStore.getState(), 'fetchAll').mockResolvedValue()
    vi.spyOn(providersApi, 'list').mockResolvedValue({ providers: savedProviders, activeId: null })
    vi.spyOn(providersApi, 'getSettings').mockResolvedValue({})
    vi.spyOn(providersApi, 'updateSettings').mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('loads saved providers while hiding their add-provider chips', async () => {
    render(<ProviderSettings />)
    for (const provider of savedProviders) {
      expect(await screen.findByTestId(`provider-${provider.id}`)).toHaveTextContent(provider.name)
    }
    expect(useProviderStore.getState().providers).toEqual(savedProviders)

    fireEvent.click(screen.getByRole('button', { name: /Add Provider/ }))
    const dialog = within(screen.getByRole('dialog'))
    for (const provider of savedProviders) {
      expect(dialog.queryByRole('button', { name: provider.name })).not.toBeInTheDocument()
    }
    expect(dialog.getByRole('button', { name: 'Atlas Cloud' })).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Custom' })).toBeInTheDocument()
  })

  it.each(savedProviders)('edits and saves an existing $presetId provider without losing its connection', async (provider) => {
    const update = vi.spyOn(providersApi, 'update').mockImplementation(async (id, input) => {
      expect(id).toBe(provider.id)
      const updated = { ...provider, ...input } as SavedProvider
      vi.mocked(providersApi.list).mockResolvedValue({
        providers: savedProviders.map((saved) => saved.id === id ? updated : saved),
        activeId: null,
      })
      return { provider: updated }
    })
    render(<ProviderSettings />)
    const card = await screen.findByTestId(`provider-${provider.id}`)
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }))

    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByDisplayValue(provider.baseUrl)).toBeInTheDocument()
    expect(dialog.queryByRole('button', { name: /Get API Key/ })).not.toBeInTheDocument()
    fireEvent.change(dialog.getByDisplayValue(provider.name), { target: { value: `${provider.name} edited` } })
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith(provider.id, expect.objectContaining({
      name: `${provider.name} edited`,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      apiFormat: provider.apiFormat,
      authStrategy: 'auth_token',
      models: provider.models,
      modelContextWindows: { [provider.models.main]: 1000000 },
    })))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(useProviderStore.getState().providers.find((saved) => saved.id === provider.id))
      .toMatchObject({ ...provider, name: `${provider.name} edited` })
    expect(screen.getByTestId(`provider-${provider.id}`)).toHaveTextContent(`${provider.name} edited`)
  })
})
