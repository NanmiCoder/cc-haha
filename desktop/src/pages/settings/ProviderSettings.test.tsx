import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { providersApi } from '../../api/providers'
import { ApiError } from '../../api/client'
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
    fireEvent.click(await screen.findByRole('button', { name: /Add Model/ }))
    const dialog = within(screen.getByRole('dialog'))
    const sponsor = dialog.getByRole('button', { name: 'ApiSmart' })
    expect(sponsor.parentElement).toBe(dialog.getByRole('button', { name: 'Atlas Cloud' }).parentElement)
    fireEvent.click(sponsor)
    expect(dialog.getByDisplayValue('https://gw.apismart.ai/v1')).toBeInTheDocument()
    expect(dialog.getAllByDisplayValue('deepseek-v4-pro-0813')).toHaveLength(3)
    expect(dialog.getByDisplayValue('deepseek-v4-flash-0731-tem')).toBeInTheDocument()
    expect(dialog.getByRole('switch', { name: 'Enable image generation' })).toBeChecked()
    expect(dialog.getByDisplayValue('doubao-seedream-5-0')).toBeInTheDocument()
    fireEvent.change(dialog.getByRole('textbox', { name: 'Reply output budget' }), { target: { value: '48000' } })

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
      requestCompatibility: { maxOutputTokens: 48000 },
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
    fireEvent.click(await screen.findByRole('button', { name: /Add Model/ }))
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

  it('explains why a remote endpoint change needs an explicit key and allows retry', async () => {
    const provider = { ...savedProviders[0]!, apiKey: '' }
    vi.mocked(providersApi.list).mockResolvedValue({ providers: [provider], activeId: null })
    const update = vi.spyOn(providersApi, 'update')
      .mockRejectedValueOnce(new ApiError(400, { code: 'REMOTE_PROVIDER_CREDENTIAL_REQUIRED' }))
      .mockResolvedValue({ provider })
    render(<ProviderSettings browserMode />)
    fireEvent.click(within(await screen.findByTestId(`provider-${provider.id}`)).getByRole('button', { name: 'Edit' }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.change(dialog.getByDisplayValue(provider.baseUrl), { target: { value: 'https://replacement.invalid' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('enter the model or image API key again')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.change(dialog.getAllByPlaceholderText('sk-...')[0]!, { target: { value: 'fake-explicit-new-key' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(update).toHaveBeenLastCalledWith(provider.id, expect.objectContaining({ apiKey: 'fake-explicit-new-key', baseUrl: 'https://replacement.invalid' })))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('loads saved providers while hiding their add-provider chips', async () => {
    render(<ProviderSettings />)
    for (const provider of savedProviders) {
      expect(await screen.findByTestId(`provider-${provider.id}`)).toHaveTextContent(provider.name)
    }
    expect(useProviderStore.getState().providers).toEqual(savedProviders)

    fireEvent.click(screen.getByRole('button', { name: /Add Model/ }))
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

describe('provider request compatibility', () => {
  const provider = {
    ...savedProviders[0]!, id: 'compat-provider', apiFormat: 'openai_chat' as const,
    requestCompatibility: { maxOutputTokens: 64000, sampling: 'unsupported' as const, futureOption: { keep: true } },
  }
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    vi.spyOn(useSettingsStore.getState(), 'fetchAll').mockResolvedValue()
    vi.spyOn(providersApi, 'list').mockResolvedValue({ providers: [provider], activeId: null })
    vi.spyOn(providersApi, 'getSettings').mockResolvedValue({ env: { CUSTOM_ENV: 'keep' }, futureSetting: true })
    vi.spyOn(providersApi, 'updateSettings').mockResolvedValue({ ok: true })
    vi.spyOn(providersApi, 'update').mockImplementation(async (_id, input) => ({ provider: { ...provider, ...input } as SavedProvider }))
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })
  const open = async () => {
    render(<ProviderSettings />)
    const card = await screen.findByTestId('provider-compat-provider')
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }))
    const dialog = within(screen.getByRole('dialog'))
    await waitFor(() => expect((dialog.getByRole('textbox', { name: 'Settings JSON' }) as HTMLTextAreaElement).value).toContain('CUSTOM_ENV'))
    return dialog
  }
  it('loads, edits and saves compatibility while preserving unknown provider fields', async () => {
    const dialog = await open()
    const budget = dialog.getByRole('textbox', { name: 'Reply output budget' })
    expect(budget).toHaveValue('64000')
    fireEvent.change(budget, { target: { value: '48000' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Advanced compatibility' }))
    expect(dialog.getByRole('combobox', { name: 'Sampling parameters' })).toHaveValue('unsupported')
    fireEvent.change(dialog.getByRole('combobox', { name: 'Output token field' }), { target: { value: 'max_completion_tokens' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(providersApi.update).toHaveBeenCalledWith('compat-provider', expect.objectContaining({ requestCompatibility: { maxOutputTokens: 48000, sampling: 'unsupported', outputTokenField: 'max_completion_tokens', futureOption: { keep: true } } })))
    const settings = vi.mocked(providersApi.updateSettings).mock.calls.at(-1)?.[0]
    expect(settings).not.toHaveProperty('requestCompatibility')
    expect(settings).toMatchObject({ futureSetting: true, env: { CUSTOM_ENV: 'keep', CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS: '48000' } })
  })
  it('disables save for invalid budgets and clearing sends null', async () => {
    const dialog = await open()
    fireEvent.change(dialog.getByRole('textbox', { name: 'Reply output budget' }), { target: { value: '-3' } })
    expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(dialog.getByRole('alert')).toHaveTextContent('positive whole number')
    fireEvent.click(dialog.getByRole('button', { name: 'Reset compatibility' }))
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(providersApi.update).toHaveBeenCalledWith('compat-provider', expect.objectContaining({ requestCompatibility: null })))
    expect(vi.mocked(providersApi.updateSettings).mock.calls.at(-1)?.[0]).not.toHaveProperty('env.CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS')
  })
  it('raw JSON updates and removes the same provider configuration', async () => {
    const dialog = await open()
    const editor = dialog.getByRole('textbox', { name: 'Settings JSON' })
    const parsed = JSON.parse((editor as HTMLTextAreaElement).value)
    parsed.requestCompatibility = { maxOutputTokens: 42000, reasoning: 'unsupported' }
    fireEvent.change(editor, { target: { value: JSON.stringify(parsed) } })
    expect(dialog.getByRole('textbox', { name: 'Reply output budget' })).toHaveValue('42000')
    const next = JSON.parse((editor as HTMLTextAreaElement).value)
    delete next.requestCompatibility
    fireEvent.change(editor, { target: { value: JSON.stringify(next) } })
    expect(dialog.getByRole('textbox', { name: 'Reply output budget' })).toHaveValue('')
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(providersApi.update).toHaveBeenCalledWith('compat-provider', expect.objectContaining({ requestCompatibility: null, baseUrl: provider.baseUrl })))
  })
  it('shows Responses capabilities without Chat-only token parameter controls', async () => {
    vi.mocked(providersApi.list).mockResolvedValue({ providers: [{ ...provider, apiFormat: 'openai_responses' }], activeId: null })
    const dialog = await open()
    fireEvent.click(dialog.getByRole('button', { name: 'Advanced compatibility' }))
    expect(dialog.queryByRole('combobox', { name: 'Output token field' })).not.toBeInTheDocument()
    expect(dialog.getByRole('combobox', { name: 'Reasoning parameters' })).toBeInTheDocument()
  })
  it('keeps compatibility controls hidden for Anthropic providers', async () => {
    vi.mocked(providersApi.list).mockResolvedValue({ providers: [{ ...provider, apiFormat: 'anthropic' }], activeId: null })
    const dialog = await open()
    expect(dialog.queryByRole('textbox', { name: 'Reply output budget' })).not.toBeInTheDocument()
  })
})
