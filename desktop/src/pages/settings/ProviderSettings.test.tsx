import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { providersApi } from '../../api/providers'
import { ApiError } from '../../api/client'
import { getDesktopHost } from '../../lib/desktopHost'
import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { MAGPIE_BANNER_DISMISSED_KEY, useMagpieStore } from '../../stores/magpieStore'
import { BUNDLED_PROVIDER_PRESETS } from '../../config/providerPresets'
import type { SavedProvider } from '../../types/provider'
import { ProviderSettings } from './ProviderSettings'

vi.mock('../../components/settings/ClaudeOfficialLogin', () => ({ ClaudeOfficialLogin: () => null }))
vi.mock('../../components/settings/ChatGPTOfficialLogin', () => ({ ChatGPTOfficialLogin: () => null }))
vi.mock('../../components/settings/GrokOfficialLogin', () => ({ GrokOfficialLogin: () => null }))
vi.mock('../../components/settings/DeepSeekAccountLogin', () => ({
  DeepSeekAccountLogin: () => <div data-testid="deepseek-account-login-stub" />,
}))
vi.mock('../../components/settings/OfficialProviderModelSettings', () => ({
  OfficialProviderModelSettings: ({ providerId }: { providerId: string }) => (
    <div data-testid="official-model-settings" data-provider-id={providerId} />
  ),
}))

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

describe('DeepSeek preset defaults', () => {
  const originalState = useProviderStore.getState()

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useProviderStore.setState(originalState)
  })

  it('fills and saves all five slots as Flash with 1M enabled', async () => {
    useProviderStore.setState({ presets: BUNDLED_PROVIDER_PRESETS })
    useSettingsStore.setState({ locale: 'en' })
    vi.spyOn(useSettingsStore.getState(), 'fetchAll').mockResolvedValue()
    vi.spyOn(providersApi, 'list').mockResolvedValue({ providers: [], activeId: null })
    vi.spyOn(providersApi, 'getSettings').mockResolvedValue({})
    const create = vi.spyOn(providersApi, 'create').mockImplementation(async (input) => ({
      provider: { ...input, id: 'new-deepseek', apiFormat: input.apiFormat ?? 'anthropic' },
    }))

    render(<ProviderSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Add Model/ }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: 'DeepSeek' }))
    expect(dialog.getAllByDisplayValue('deepseek-flash')).toHaveLength(5)
    const contextCheckboxes = dialog.getAllByRole('checkbox', { name: /1M/ })
    expect(contextCheckboxes).toHaveLength(5)
    for (const checkbox of contextCheckboxes) expect(checkbox).toBeChecked()
    fireEvent.change(dialog.getAllByPlaceholderText('sk-...')[0]!, { target: { value: 'fake-deepseek-key' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      presetId: 'deepseek',
      models: {
        main: 'deepseek-flash', fable: 'deepseek-flash', haiku: 'deepseek-flash',
        sonnet: 'deepseek-flash', opus: 'deepseek-flash',
      },
      model1mSupport: { main: true, fable: true, haiku: true, sonnet: true, opus: true },
    })))
  })
})

describe('image generation protocol settings', () => {
  let originalPresets = useProviderStore.getState().presets
  beforeEach(() => {
    originalPresets = useProviderStore.getState().presets
    useProviderStore.setState({ presets: BUNDLED_PROVIDER_PRESETS })
    useSettingsStore.setState({ locale: 'en' })
    vi.spyOn(useSettingsStore.getState(), 'fetchAll').mockResolvedValue()
    vi.spyOn(providersApi, 'list').mockResolvedValue({ providers: [], activeId: null })
    vi.spyOn(providersApi, 'getSettings').mockResolvedValue({})
    vi.spyOn(providersApi, 'updateSettings').mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useProviderStore.setState({ presets: originalPresets })
  })

  it.each(['gemini_native', 'xai_images'] as const)('keeps saved %s image protocol when editing other image fields', async (protocol) => {
    const provider: SavedProvider = {
      ...savedProviders[0]!, id: 'saved-image-provider',
      imageGeneration: { model: 'image-fixture', protocol, baseUrl: 'https://images.example.test/v1', apiKey: 'fake-image-key' },
    }
    vi.mocked(providersApi.list).mockResolvedValue({ providers: [provider], activeId: null })
    const update = vi.spyOn(providersApi, 'update').mockResolvedValue({ provider })
    render(<ProviderSettings />)
    fireEvent.click(within(await screen.findByTestId('provider-saved-image-provider')).getByRole('button', { name: 'Edit' }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.change(dialog.getByRole('textbox', { name: /Image model/ }), { target: { value: 'image-fixture-updated' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith(provider.id, expect.objectContaining({
      imageGeneration: { model: 'image-fixture-updated', protocol, baseUrl: 'https://images.example.test/v1', apiKey: 'fake-image-key' },
    })))
  })

  it('defaults an older image configuration to OpenAI-compatible Images', async () => {
    const provider: SavedProvider = { ...savedProviders[0]!, id: 'old-images', imageGeneration: { model: 'old-image-model' } }
    vi.mocked(providersApi.list).mockResolvedValue({ providers: [provider], activeId: null })
    const update = vi.spyOn(providersApi, 'update').mockResolvedValue({ provider })
    render(<ProviderSettings />)
    fireEvent.click(within(await screen.findByTestId('provider-old-images')).getByRole('button', { name: 'Edit' }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByRole('combobox', { name: 'Image API protocol' })).toHaveValue('openai_images')
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith(provider.id, expect.objectContaining({
      imageGeneration: { model: 'old-image-model', protocol: 'openai_images' },
    })))
  })

  it('saves a newly selected image protocol independently from the chat protocol', async () => {
    const create = vi.spyOn(providersApi, 'create').mockImplementation(async (input) => ({
      provider: { ...input, id: 'new-images', apiFormat: input.apiFormat ?? 'anthropic' },
    }))
    render(<ProviderSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Add Model/ }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: 'AruHub' }))
    fireEvent.change(dialog.getAllByPlaceholderText('sk-...')[0]!, { target: { value: 'fake-new-key' } })
    fireEvent.click(dialog.getByRole('switch', { name: 'Enable image generation' }))
    fireEvent.change(dialog.getByRole('combobox', { name: 'Image API protocol' }), { target: { value: 'gemini_native' } })
    fireEvent.change(dialog.getByRole('textbox', { name: /Image model/ }), { target: { value: 'gemini-image-fixture' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      apiFormat: 'anthropic', imageGeneration: { model: 'gemini-image-fixture', protocol: 'gemini_native' },
    })))
  })

  it('applies the selected preset image protocol and resets to the default when switching presets', async () => {
    useProviderStore.setState({ presets: BUNDLED_PROVIDER_PRESETS.map((preset) => preset.id === 'aruhub'
      ? { ...preset, defaultImageGeneration: { model: 'grok-image-fixture', protocol: 'xai_images' as const } }
      : preset) })
    render(<ProviderSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Add Model/ }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: 'AruHub' }))
    expect(dialog.getByRole('combobox', { name: 'Image API protocol' })).toHaveValue('xai_images')
    expect(dialog.getByRole('textbox', { name: /Image model/ })).toHaveValue('grok-image-fixture')
    fireEvent.click(dialog.getByRole('button', { name: 'Atlas Cloud' }))
    expect(dialog.getByRole('switch', { name: 'Enable image generation' })).not.toBeChecked()
    fireEvent.click(dialog.getByRole('switch', { name: 'Enable image generation' }))
    expect(dialog.getByRole('combobox', { name: 'Image API protocol' })).toHaveValue('openai_images')
  })
})

describe('active sponsor providers', () => {
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

  it('puts AruHub first in the sponsor row with badges and its signup offer', async () => {
    const create = vi.spyOn(providersApi, 'create').mockImplementation(async (input) => ({
      provider: { ...input, id: 'saved-aruhub', apiFormat: input.apiFormat ?? 'anthropic' },
    }))
    const open = vi.spyOn(getDesktopHost().shell, 'open').mockResolvedValue()
    render(<ProviderSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Add Model/ }))
    const dialog = within(screen.getByRole('dialog'))
    const sponsor = dialog.getByRole('button', { name: 'AruHub' })
    expect(sponsor.parentElement?.firstElementChild).toBe(sponsor)
    expect(sponsor.parentElement).toBe(dialog.getByRole('button', { name: 'Atlas Cloud' }).parentElement)
    expect(within(sponsor).getByText('New')).toBeInTheDocument()
    expect(within(sponsor).getByLabelText('Sponsor')).toBeInTheDocument()
    expect(within(dialog.getByRole('button', { name: 'Atlas Cloud' })).queryByLabelText('Sponsor')).not.toBeInTheDocument()
    fireEvent.click(sponsor)
    expect(dialog.getByDisplayValue('https://agent.aruhub.com')).toBeInTheDocument()
    expect(dialog.getAllByDisplayValue('claude-opus-5-5')).toHaveLength(2)
    expect(dialog.getAllByDisplayValue('claude-sonnet-5-5')).toHaveLength(2)
    const offer = dialog.getByRole('button', { name: /注册即送 1 美元全模型通用额度/ })
    fireEvent.click(offer)
    expect(open).toHaveBeenCalledWith('https://aruhub.com/sign-up?aff=Z54g')
    fireEvent.click(dialog.getByRole('button', { name: /Get API Key/ }))
    expect(open).toHaveBeenCalledTimes(2)
    fireEvent.change(dialog.getAllByPlaceholderText('sk-...')[0]!, { target: { value: 'fake-aruhub-key' } })
    expect(dialog.getByText(/注册即送 1 美元全模型通用额度/)).toBeInTheDocument()
    fireEvent.change(dialog.getByDisplayValue('https://agent.aruhub.com'), { target: { value: 'https://other.invalid' } })
    expect(dialog.queryByText(/注册即送 1 美元全模型通用额度/)).not.toBeInTheDocument()
    fireEvent.change(dialog.getByDisplayValue('https://other.invalid'), { target: { value: 'https://agent.aruhub.com' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      presetId: 'aruhub',
      baseUrl: 'https://agent.aruhub.com',
      apiFormat: 'anthropic',
      authStrategy: 'api_key',
      apiKey: 'fake-aruhub-key',
      models: { main: 'claude-opus-5-5', haiku: 'claude-sonnet-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' },
    })))
  })

  it('fetches models through the proxy mode chosen in the form, not the global one', async () => {
    const fetchModels = vi.spyOn(providersApi, 'fetchModels').mockResolvedValue({
      ok: true,
      endpoint: 'https://modelflare.dev/v1/models',
      models: [{ id: 'claude-opus-5-5', ownedBy: 'anthropic' }],
    })
    render(<ProviderSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Add Model/ }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: 'Modelflare' }))
    fireEvent.change(dialog.getAllByPlaceholderText('sk-...')[0]!, { target: { value: 'fake-modelflare-key' } })
    fireEvent.click(dialog.getByRole('radio', { name: 'Direct' }))
    fireEvent.click(dialog.getByRole('button', { name: 'Fetch models' }))
    await waitFor(() => expect(fetchModels).toHaveBeenCalledWith({
      baseUrl: 'https://modelflare.dev', apiKey: 'fake-modelflare-key', proxy: { mode: 'direct' },
    }))
  })

  it('adds Modelflare from the second sponsor pill with badges, model discovery and Claude 5.5 defaults', async () => {
    const create = vi.spyOn(providersApi, 'create').mockImplementation(async (input) => ({
      provider: { ...input, id: 'saved-modelflare', apiFormat: input.apiFormat ?? 'anthropic' },
    }))
    const fetchModels = vi.spyOn(providersApi, 'fetchModels').mockResolvedValue({
      ok: true,
      endpoint: 'https://modelflare.dev/v1/models',
      models: [
        { id: 'claude-opus-5-5', ownedBy: 'anthropic' },
        { id: 'claude-sonnet-5-5', ownedBy: 'anthropic' },
        { id: 'claude-haiku-5-5', ownedBy: 'anthropic' },
      ],
    })
    const open = vi.spyOn(getDesktopHost().shell, 'open').mockResolvedValue()
    render(<ProviderSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Add Model/ }))
    const dialog = within(screen.getByRole('dialog'))
    const sponsor = dialog.getByRole('button', { name: 'Modelflare' })
    expect(sponsor.previousElementSibling).toBe(dialog.getByRole('button', { name: 'AruHub' }))
    expect(sponsor.nextElementSibling).toBe(dialog.getByRole('button', { name: 'Atlas Cloud' }))
    expect(within(sponsor).getByText('New')).toBeInTheDocument()
    expect(within(sponsor).getByLabelText('Sponsor')).toBeInTheDocument()
    expect(sponsor.querySelector('img')?.getAttribute('src')).toContain('modelflare-logo')
    expect(dialog.getByRole('button', { name: 'AruHub' }).querySelector('img')?.getAttribute('src')).toContain('aruhub-logo')
    expect(dialog.getByRole('button', { name: 'Atlas Cloud' }).querySelector('img')).toBeNull()
    expect(dialog.queryByRole('button', { name: 'ApiSmart' })).not.toBeInTheDocument()

    fireEvent.click(sponsor)
    expect(dialog.getByDisplayValue('https://modelflare.dev')).toBeInTheDocument()
    expect(dialog.getAllByDisplayValue('claude-opus-5-5')).toHaveLength(2)
    expect(dialog.getByDisplayValue('claude-sonnet-5-5')).toBeInTheDocument()
    expect(dialog.getByDisplayValue('claude-haiku-5-5')).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Fetch models' })).toBeDisabled()
    fireEvent.click(dialog.getByRole('button', { name: /Get API Key/ }))
    expect(open).toHaveBeenCalledWith('https://modelflare.dev/sign-up?utm_source=github&utm_campaign=cchaha')

    fireEvent.change(dialog.getAllByPlaceholderText('sk-...')[0]!, { target: { value: 'fake-modelflare-key' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Fetch models' }))
    await waitFor(() => expect(fetchModels).toHaveBeenCalledWith({
      baseUrl: 'https://modelflare.dev', apiKey: 'fake-modelflare-key',
    }))
    await dialog.findByText(/Model list loaded \(3\)/)
    fireEvent.click(dialog.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      presetId: 'modelflare',
      baseUrl: 'https://modelflare.dev',
      apiFormat: 'anthropic',
      authStrategy: 'auth_token',
      apiKey: 'fake-modelflare-key',
      models: {
        main: 'claude-opus-5-5', haiku: 'claude-haiku-5-5',
        sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5',
      },
      modelContextWindows: {
        'claude-opus-5-5': 1000000, 'claude-sonnet-5-5': 1000000, 'claude-haiku-5-5': 1000000,
      },
    })))
  })

  it('lets a preset switch protocol while the preset endpoint stays put', async () => {
    const create = vi.spyOn(providersApi, 'create').mockImplementation(async (input) => ({
      provider: { ...input, id: 'saved-aruhub', apiFormat: input.apiFormat ?? 'anthropic' },
    }))
    render(<ProviderSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Add Model/ }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: 'AruHub' }))

    // AruHub is an Anthropic-endpoint preset that also serves OpenAI, so the
    // protocol starts on the preset's own value and is the user's to change.
    const formatTrigger = dialog.getByRole('button', { name: /Anthropic Messages \(native\)/ })
    expect(dialog.queryByText(/point the base URL at an endpoint that serves it/)).not.toBeInTheDocument()

    fireEvent.click(formatTrigger)
    fireEvent.click(await screen.findByRole('option', { name: /OpenAI Chat Completions/ }))

    expect(dialog.getByText(/point the base URL at an endpoint that serves it/)).toBeInTheDocument()
    // The address is the user's to replace, so switching must not rewrite it.
    expect(dialog.getByDisplayValue('https://agent.aruhub.com')).toBeInTheDocument()

    fireEvent.change(dialog.getAllByPlaceholderText('sk-...')[0]!, { target: { value: 'fake-aruhub-key' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      presetId: 'aruhub',
      baseUrl: 'https://agent.aruhub.com',
      apiFormat: 'openai_chat',
      apiKey: 'fake-aruhub-key',
    })))
  })

  it('does not warn about the endpoint while a preset keeps its own protocol', async () => {
    render(<ProviderSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Add Model/ }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: 'Atlas Cloud' }))

    expect(dialog.getByRole('button', { name: /OpenAI Chat Completions \(proxy\)/ })).toBeInTheDocument()
    expect(dialog.queryByText(/point the base URL at an endpoint that serves it/)).not.toBeInTheDocument()
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

  it('keeps a saved ApiSmart provider but no longer offers it as a new provider', async () => {
    vi.mocked(providersApi.list).mockResolvedValue({ providers: [{
      ...savedProviders[0]!, id: 'old-apismart', presetId: 'apismart', name: 'ApiSmart',
      baseUrl: 'https://gw.apismart.ai/v1', apiFormat: 'openai_chat',
    }], activeId: null })
    render(<ProviderSettings />)
    expect(await screen.findByTestId('provider-old-apismart')).toHaveTextContent('ApiSmart')

    fireEvent.click(screen.getByRole('button', { name: /Add Model/ }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByRole('button', { name: 'Atlas Cloud' })).toBeInTheDocument()
    expect(dialog.queryByRole('button', { name: 'ApiSmart' })).not.toBeInTheDocument()
  })
})

describe('built-in DeepSeek Account provider', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    vi.spyOn(useSettingsStore.getState(), 'fetchAll').mockResolvedValue()
    vi.spyOn(useSettingsStore.getState(), 'setModel').mockResolvedValue()
    vi.spyOn(providersApi, 'getSettings').mockResolvedValue({})
    vi.spyOn(providersApi, 'getOfficialModels').mockResolvedValue({
      models: { main: 'deepseek-v4-pro[1m]', haiku: 'deepseek-v4-flash', sonnet: 'deepseek-v4-pro[1m]', opus: 'deepseek-v4-pro[1m]' },
    })
    useProviderStore.setState({
      providers: [], activeId: null, hasLoadedProviders: false, isLoading: false,
      providerOrder: ['claude-official', 'openai-official', 'grok-official', 'deepseek-account'],
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('lists the account provider, activates it and then shows its login and model mapping', async () => {
    let activeId: string | null = null
    vi.spyOn(providersApi, 'list').mockImplementation(async () => ({ providers: [], activeId }))
    const activate = vi.spyOn(providersApi, 'activate').mockImplementation(async (id) => {
      activeId = id
      return { ok: true }
    })

    render(<ProviderSettings />)
    fireEvent.click(await screen.findByRole('tab', { name: /Official sign-in/ }))

    const card = await screen.findByTestId('deepseek-account-provider')
    expect(within(card).getByText('DeepSeek Account')).toBeInTheDocument()
    expect(within(card).getByText(/no API key required/)).toBeInTheDocument()
    expect(within(card).queryByTestId('deepseek-account-login-stub')).not.toBeInTheDocument()

    fireEvent.click(within(card).getByRole('button', { name: /DeepSeek Account/ }))

    await waitFor(() => expect(activate).toHaveBeenCalledWith('deepseek-account'))
    expect(await within(card).findByTestId('deepseek-account-login-stub')).toBeInTheDocument()
    expect(within(card).getByTestId('official-model-settings')).toHaveAttribute('data-provider-id', 'deepseek-account')
    expect(within(card).getByText('Default')).toBeInTheDocument()
  })

  it('shows no account login for the browser (phone) settings view', async () => {
    vi.spyOn(providersApi, 'list').mockResolvedValue({ providers: [], activeId: 'deepseek-account' })

    render(<ProviderSettings browserMode />)

    const card = await screen.findByTestId('deepseek-account-provider')
    expect(within(card).getByText('DeepSeek Account')).toBeInTheDocument()
    expect(within(card).queryByTestId('deepseek-account-login-stub')).not.toBeInTheDocument()
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
    expect(dialog.getByRole('button', { name: 'Custom API' })).toBeInTheDocument()
  })

  it('labels the custom preset in the active locale and prefills that label as the name', async () => {
    useSettingsStore.setState({ locale: 'zh' })
    render(<ProviderSettings />)
    await screen.findByTestId(`provider-${savedProviders[0]!.id}`)

    fireEvent.click(screen.getByRole('button', { name: /添加模型/ }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.queryByRole('button', { name: 'Custom' })).not.toBeInTheDocument()
    fireEvent.click(dialog.getByRole('button', { name: '自定义模型 API' }))
    expect(dialog.getByLabelText(/配置名称/)).toHaveValue('自定义模型 API')
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
    const imageGeneration = dialog.getByRole('switch', { name: 'Enable image generation' })
    const settingsJson = dialog.getByRole('textbox', { name: 'Settings JSON' })
    expect(settingsJson.compareDocumentPosition(imageGeneration) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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
  it('shows the reply output budget for Anthropic providers and saves it budget-only', async () => {
    // The fixture carries OpenAI-compat knobs (sampling, futureOption) that do
    // not apply to a native Anthropic endpoint. For Anthropic the editor keeps
    // the budget visible and editable, hides the advanced controls, and strips
    // any stale compat options on save so they cannot leak into the provider.
    vi.mocked(providersApi.list).mockResolvedValue({ providers: [{ ...provider, apiFormat: 'anthropic' }], activeId: null })
    const dialog = await open()
    const budget = dialog.getByRole('textbox', { name: 'Reply output budget' })
    expect(budget).toHaveValue('64000')
    expect(dialog.queryByRole('button', { name: 'Advanced compatibility' })).not.toBeInTheDocument()
    fireEvent.change(budget, { target: { value: '4096' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(providersApi.update).toHaveBeenCalledWith('compat-provider', expect.objectContaining({
      apiFormat: 'anthropic',
      // Exact object match: sampling/futureOption must be gone, not just omitted from the assertion.
      requestCompatibility: { maxOutputTokens: 4096 },
    })))
    const settings = vi.mocked(providersApi.updateSettings).mock.calls.at(-1)?.[0]
    expect(settings).not.toHaveProperty('requestCompatibility')
    expect(settings).toMatchObject({ env: { CUSTOM_ENV: 'keep', CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS: '4096' } })
  })
})

/**
 * OpenCode Go is the first provider whose wire format depends on the model rather
 * than the record, so what the user has to do — and what they must not have to do
 * — is part of the contract, not just cosmetics.
 */
describe('OpenCode Go provider', () => {
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

  it('puts key and model selection before optional settings and reveals compact option help on focus', async () => {
    const open = vi.spyOn(getDesktopHost().shell, 'open').mockResolvedValue()
    render(<ProviderSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Add Model/ }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: 'OpenCode Go' }))
    const key = dialog.getByLabelText(/API Key/, { selector: 'input' })
    const fetch = dialog.getByRole('button', { name: /Fetch models/ })
    const main = dialog.getByLabelText(/Main Model/, { selector: 'input' })
    const beta = dialog.getByRole('checkbox', { name: 'Disable experimental beta headers' })
    const budget = dialog.getByRole('textbox', { name: 'Reply output budget' })
    // Previously several full-width compatibility cards preceded credentials.
    for (const [first, second] of [[key, fetch], [main, beta], [main, budget]]) {
      expect(first!.compareDocumentPosition(second!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    expect(fetch).toBeDisabled()
    fireEvent.change(key, { target: { value: 'fake-opencode-key' } })
    expect(fetch).toBeEnabled()
    fireEvent.click(dialog.getByRole('button', { name: /Get API Key/ }))
    expect(open).toHaveBeenCalledWith('https://opencode.ai/go?ref=3RK0WVVCGD')
    expect(screen.queryByText(/CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1/)).not.toBeInTheDocument()
    fireEvent.focus(dialog.getByRole('button', { name: 'Disable experimental beta headers' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1')
    fireEvent.click(beta)
    expect(beta).toBeChecked()
    expect(dialog.getByRole('checkbox', { name: 'Enable Tool Search' })).toBeDisabled()
  })

  it('is added with an API key alone, because the preset carries everything else', async () => {
    const create = vi.spyOn(providersApi, 'create').mockImplementation(async (input) => ({
      provider: { ...input, id: 'saved-opencode-go', apiFormat: input.apiFormat ?? 'anthropic' },
    }))
    render(<ProviderSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Add Model/ }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: 'OpenCode Go' }))

    expect(dialog.getByDisplayValue('https://opencode.ai/zen/go/v1')).toBeInTheDocument()
    expect(dialog.getAllByDisplayValue('glm-5.3')).toHaveLength(3)
    expect(dialog.getByDisplayValue('glm-5.3-flash')).toBeInTheDocument()

    fireEvent.change(dialog.getAllByPlaceholderText('sk-...')[0]!, { target: { value: 'fake-opencode-key' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      presetId: 'opencode-go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiFormat: 'openai_chat',
      authStrategy: 'api_key',
      apiKey: 'fake-opencode-key',
      models: { main: 'glm-5.3', haiku: 'glm-5.3-flash', sonnet: 'glm-5.3', opus: 'glm-5.3' },
    })))
  })

  it('groups the fetched catalogue by the endpoint each model is served on', async () => {
    vi.spyOn(providersApi, 'fetchModels').mockResolvedValue({
      ok: true,
      endpoint: 'https://opencode.ai/zen/go/v1/models',
      // Every model reports the same owner, so grouping by it would be useless.
      models: [
        { id: 'glm-5.3', ownedBy: 'opencode' },
        { id: 'minimax-m3', ownedBy: 'opencode' },
        { id: 'grok-4.6', ownedBy: 'opencode' },
        { id: 'gemini-4-argon-contributor', ownedBy: 'opencode' },
      ],
    })
    render(<ProviderSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Add Model/ }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: 'OpenCode Go' }))
    fireEvent.change(dialog.getAllByPlaceholderText('sk-...')[0]!, { target: { value: 'fake-opencode-key' } })
    fireEvent.click(dialog.getByRole('button', { name: /Fetch models/ }))

    const combobox = await dialog.findByRole('combobox', { name: /Main Model/ })
    fireEvent.focus(combobox)

    // The endpoint is the only thing that distinguishes these models, so it is what
    // the picker groups by — this is how the routing stays visible while choosing.
    for (const endpoint of ['/chat/completions', '/messages', '/responses', ':generateContent']) {
      expect(await screen.findByText(endpoint)).toBeInTheDocument()
    }
  })

  it('badges the provider as multi-protocol instead of naming one format', async () => {
    vi.mocked(providersApi.list).mockResolvedValue({ providers: [{
      id: 'saved-opencode-go',
      presetId: 'opencode-go',
      name: 'OpenCode Go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKey: 'fake-opencode-key',
      apiFormat: 'openai_chat',
      models: { main: 'glm-5.3', haiku: 'glm-5.3-flash', sonnet: 'glm-5.3', opus: 'glm-5.3' },
    }], activeId: null })
    render(<ProviderSettings />)
    const card = await screen.findByTestId('provider-saved-opencode-go')
    expect(within(card).getByText('Multi-protocol')).toBeInTheDocument()
    expect(within(card).queryByText('OpenAI Chat')).not.toBeInTheDocument()
  })

  it('shows the preset-owned format as fixed instead of offering a choice that is ignored', async () => {
    render(<ProviderSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Add Model/ }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: 'OpenCode Go' }))

    expect(dialog.getByText('OpenAI Chat Completions (proxy)')).toBeInTheDocument()
    expect(dialog.getByText(/picks the protocol per model/)).toBeInTheDocument()
    // A record-level format cannot express the per-model split, so the server
    // ignores it; leaving a dropdown here would offer a switch that does nothing.
    expect(dialog.queryByRole('button', { name: /OpenAI Chat Completions \(proxy\)|Anthropic Messages/ })).toBeNull()
  })

  it('sends the preset id with a connectivity test so the server resolves the same protocol', async () => {
    const testConfig = vi.spyOn(useProviderStore.getState(), 'testConfig').mockResolvedValue({
      connectivity: { success: true, latencyMs: 1 },
    })
    render(<ProviderSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Add Model/ }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: 'OpenCode Go' }))
    fireEvent.change(dialog.getAllByPlaceholderText('sk-...')[0]!, { target: { value: 'fake-opencode-key' } })
    fireEvent.click(dialog.getByRole('button', { name: /Test Connection/ }))

    await waitFor(() => expect(testConfig).toHaveBeenCalledWith(expect.objectContaining({
      // Without this the probe would try every model on the record's single format
      // and report a false failure for anything that routes elsewhere.
      presetId: 'opencode-go',
      modelId: 'glm-5.3',
    })))
  })

})

/**
 * OpenRouter is a one-key aggregation gateway: the user pastes an sk-or- key and
 * the preset supplies the endpoint, the credential header and the Claude 5.5
 * defaults. Nothing here may require hand-entering an URL or a format.
 */
describe('OpenRouter provider', () => {
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

  it('is added with an API key alone, prefilled with the direct endpoint and Claude 5.5 slots', async () => {
    const create = vi.spyOn(providersApi, 'create').mockImplementation(async (input) => ({
      provider: { ...input, id: 'saved-openrouter', apiFormat: input.apiFormat ?? 'anthropic' },
    }))
    render(<ProviderSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Add Model/ }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: 'OpenRouter' }))

    // The root, not /api/v1 — the CLI appends /v1/messages itself.
    expect(dialog.getByDisplayValue('https://openrouter.ai/api')).toBeInTheDocument()
    // Main and Sonnet share the balanced default; Haiku and Opus stay distinct.
    expect(dialog.getAllByDisplayValue('anthropic/claude-sonnet-5.5')).toHaveLength(2)
    expect(dialog.getByDisplayValue('anthropic/claude-haiku-5.5')).toBeInTheDocument()
    expect(dialog.getByDisplayValue('anthropic/claude-opus-5.5')).toBeInTheDocument()

    fireEvent.change(dialog.getAllByPlaceholderText('sk-...')[0]!, { target: { value: 'sk-or-v1-fake' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      presetId: 'openrouter',
      baseUrl: 'https://openrouter.ai/api',
      apiFormat: 'anthropic',
      authStrategy: 'auth_token',
      apiKey: 'sk-or-v1-fake',
      models: {
        main: 'anthropic/claude-sonnet-5.5',
        haiku: 'anthropic/claude-haiku-5.5',
        sonnet: 'anthropic/claude-sonnet-5.5',
        opus: 'anthropic/claude-opus-5.5',
      },
    })))
  })

  it('links the key field to the OpenRouter key page', async () => {
    const open = vi.spyOn(getDesktopHost().shell, 'open').mockResolvedValue()
    render(<ProviderSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Add Model/ }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: 'OpenRouter' }))

    fireEvent.click(dialog.getByRole('button', { name: /Get API Key/ }))
    expect(open).toHaveBeenCalledWith('https://openrouter.ai/settings/keys')
  })
})

describe('provider list tabs and search', () => {
  let originalPresets = useProviderStore.getState().presets

  beforeEach(() => {
    originalPresets = useProviderStore.getState().presets
    useSettingsStore.setState({ locale: 'en' })
    vi.spyOn(useSettingsStore.getState(), 'fetchAll').mockResolvedValue()
    vi.spyOn(useSettingsStore.getState(), 'setModel').mockResolvedValue()
    vi.spyOn(providersApi, 'getSettings').mockResolvedValue({})
    vi.spyOn(providersApi, 'getOfficialModels').mockResolvedValue({
      models: { main: 'claude-fixture', haiku: 'claude-fixture', sonnet: 'claude-fixture', opus: 'claude-fixture' },
    })
    vi.spyOn(providersApi, 'list').mockResolvedValue({ providers: savedProviders, activeId: null })
    // A previous test's list must not decide which tab this one opens on.
    useProviderStore.setState({
      providers: [], activeId: null, hasLoadedProviders: false, isLoading: false, providerOrder: [],
      presets: BUNDLED_PROVIDER_PRESETS,
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useProviderStore.setState({ presets: originalPresets })
  })

  it('opens a fresh install on API Key with presets to start from', async () => {
    vi.mocked(providersApi.list).mockResolvedValue({ providers: [], activeId: null })
    render(<ProviderSettings />)

    expect(await screen.findByRole('heading', { name: 'No API key providers yet' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /API Key/ })).toHaveAttribute('aria-selected', 'true')
    // Claude Official is still the fallback default, so its tab carries the marker.
    expect(screen.getByRole('tab', { name: /Official sign-in/ })).toHaveTextContent('(contains the default)')
    expect(screen.getByRole('tab', { name: /API Key/ })).not.toHaveTextContent('(contains the default)')
    // Four built-in cards are not worth searching.
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Kimi' }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByRole('button', { name: 'Kimi' })).toHaveAttribute('aria-pressed', 'true')
    expect(dialog.getByDisplayValue('Kimi')).toBeInTheDocument()
  })

  it('opens on Official sign-in when one was made the default, and stays there when the default changes', async () => {
    let activeId: string | null = 'openai-official'
    vi.mocked(providersApi.list).mockImplementation(async () => ({ providers: savedProviders, activeId }))
    const activate = vi.spyOn(providersApi, 'activateOfficial').mockImplementation(async () => {
      activeId = null
      return { ok: true }
    })
    render(<ProviderSettings />)

    const officialTab = await screen.findByRole('tab', { name: /Official sign-in/ })
    await waitFor(() => expect(officialTab).toHaveAttribute('aria-selected', 'true'))
    expect(officialTab).toHaveTextContent('(contains the default)')
    expect(screen.queryByTestId('provider-saved-fennoai')).not.toBeInTheDocument()

    fireEvent.click(within(screen.getByTestId('claude-official-provider')).getByRole('button', { name: /Claude Official/ }))
    await waitFor(() => expect(activate).toHaveBeenCalled())
    await waitFor(() => expect(within(screen.getByTestId('claude-official-provider')).getByText('Default')).toBeInTheDocument())
    expect(screen.getByRole('tab', { name: /Official sign-in/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('filters the open tab by model ID, highlights it, and points at matches in the other tab', async () => {
    render(<ProviderSettings />)
    const search = await screen.findByRole('searchbox', { name: 'Search providers' })
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Drag to reorder' })).toHaveLength(3))

    fireEvent.change(search, { target: { value: 'DeepSeek' } })

    const match = screen.getByTestId('provider-saved-qiniuai')
    expect(screen.queryByTestId('provider-saved-fennoai')).not.toBeInTheDocument()
    expect(within(match).getAllByText(/^deepseek$/i, { selector: 'mark' })).toHaveLength(2)
    expect(screen.getByRole('tab', { name: /API Key/ })).toHaveTextContent(/API Key\s*1/)
    // A filtered list is not an order to drag within.
    expect(screen.queryByRole('button', { name: 'Drag to reorder' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /1 more in Official sign-in/ }))
    expect(screen.getByTestId('deepseek-account-provider')).toBeInTheDocument()
    expect(screen.queryByTestId('claude-official-provider')).not.toBeInTheDocument()

    fireEvent.keyDown(search, { key: 'Escape' })
    expect(search).toHaveValue('')
    expect(screen.getByTestId('claude-official-provider')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Drag to reorder' })).toHaveLength(4)
  })

  it('offers the other tab when the open one has no match', async () => {
    render(<ProviderSettings />)
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search providers' }), { target: { value: 'grok' } })

    expect(screen.getByRole('heading', { name: 'Nothing in API Key matches "grok"' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'View 1 in Official sign-in' }))
    expect(screen.getByTestId('grok-official-provider')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Official sign-in/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('says which hidden field matched, matches every word, and never searches the API key', async () => {
    const hidden: SavedProvider = {
      ...savedProviders[1]!,
      id: 'saved-hidden',
      name: 'Fixture Gateway',
      notes: 'team billing account',
      models: { main: 'main-fixture', haiku: 'haiku-only-fixture', sonnet: 'main-fixture', opus: 'main-fixture' },
    }
    vi.mocked(providersApi.list).mockResolvedValue({ providers: [...savedProviders, hidden], activeId: null })
    render(<ProviderSettings />)
    const search = await screen.findByRole('searchbox', { name: 'Search providers' })

    fireEvent.change(search, { target: { value: 'haiku-only' } })
    expect(screen.getByTestId('provider-saved-hidden')).toHaveTextContent('Matched Haiku Model · haiku-only-fixture')

    fireEvent.change(search, { target: { value: 'gateway billing' } })
    expect(screen.getByTestId('provider-saved-hidden')).toHaveTextContent('Matched Notes · team billing account')
    expect(screen.queryByTestId('provider-saved-fennoai')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'gateway kimi' } })
    expect(screen.queryByTestId('provider-saved-hidden')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'fake-saved-api-key' } })
    expect(screen.getByRole('heading', { name: 'Nothing in API Key matches "fake-saved-api-key"' })).toBeInTheDocument()
    expect(screen.getByText('Search by name, provider, endpoint or model ID')).toBeInTheDocument()
  })
})

describe('Magpie on the provider list', () => {
  const running = {
    status: { installed: true, running: true, baseUrl: 'http://127.0.0.1:3425' },
    models: [
      { id: 'kimi/kimi-k3', runtimeId: 'kimi/kimi-k3', displayName: 'Kimi K3', provider: 'kimi', isGroup: false, contextWindow: 262_144, reasoningEfforts: [] },
      { id: 'ollama/qwen3.6:27b', runtimeId: 'ollama/qwen3.6:27b', displayName: 'Qwen3.6 27B', provider: 'ollama', isGroup: false, reasoningEfforts: [] },
    ],
  }
  const magpieProvider: SavedProvider = {
    id: 'magpie-1', presetId: 'magpie', name: 'Magpie', apiKey: '', baseUrl: 'http://127.0.0.1:3425', apiFormat: 'anthropic',
    models: { main: 'kimi/kimi-k3', haiku: 'ollama/qwen3.6:27b', sonnet: 'kimi/kimi-k3', opus: 'kimi/kimi-k3' },
  }
  let originalPresets = useProviderStore.getState().presets

  beforeEach(() => {
    originalPresets = useProviderStore.getState().presets
    useSettingsStore.setState({ locale: 'en' })
    vi.spyOn(useSettingsStore.getState(), 'fetchAll').mockResolvedValue()
    vi.spyOn(providersApi, 'getSettings').mockResolvedValue({})
    useProviderStore.setState({
      providers: [], activeId: null, hasLoadedProviders: false, isLoading: false, providerOrder: [],
      presets: BUNDLED_PROVIDER_PRESETS,
    })
    useMagpieStore.setState({ state: null, loading: false, bannerDismissed: false })
    localStorage.removeItem(MAGPIE_BANNER_DISMISSED_KEY)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useProviderStore.setState({ presets: originalPresets })
    localStorage.removeItem(MAGPIE_BANNER_DISMISSED_KEY)
  })

  it('offers Magpie at the top of API Key while it runs unconnected, and × hides it for good', async () => {
    vi.spyOn(providersApi, 'list').mockResolvedValue({ providers: savedProviders, activeId: null })
    vi.spyOn(providersApi, 'magpie').mockResolvedValue(running)
    render(<ProviderSettings />)

    const banner = await screen.findByTestId('magpie-connect-banner')
    expect(banner).toHaveTextContent('Magpie is running on this computer')
    expect(banner).toHaveTextContent('2 models, no key needed')
    fireEvent.click(within(banner).getByRole('button', { name: 'Connect' }))
    expect(await screen.findByRole('dialog', { name: 'Connect Magpie' })).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))

    fireEvent.click(within(screen.getByTestId('magpie-connect-banner')).getByRole('button', { name: "Don't show again" }))
    expect(screen.queryByTestId('magpie-connect-banner')).not.toBeInTheDocument()
    expect(localStorage.getItem(MAGPIE_BANNER_DISMISSED_KEY)).toBe('1')
  })

  it('stays quiet while Magpie is not running', async () => {
    vi.spyOn(providersApi, 'list').mockResolvedValue({ providers: savedProviders, activeId: null })
    const check = vi.spyOn(providersApi, 'magpie').mockResolvedValue({ ...running, status: { ...running.status, running: false }, models: null })
    render(<ProviderSettings />)

    await waitFor(() => expect(check).toHaveBeenCalled())
    await screen.findByTestId('provider-saved-fennoai')
    expect(screen.queryByTestId('magpie-connect-banner')).not.toBeInTheDocument()
  })

  it('shows a connected Magpie as a local gateway with its state, and edits it in its own dialog', async () => {
    vi.spyOn(providersApi, 'list').mockResolvedValue({ providers: [magpieProvider], activeId: 'magpie-1' })
    vi.spyOn(providersApi, 'magpie').mockResolvedValue(running)
    render(<ProviderSettings />)

    const card = await screen.findByTestId('provider-magpie-1')
    await waitFor(() => expect(card).toHaveTextContent('Running, 2 models available'))
    expect(card).toHaveTextContent('Local gateway')
    // The connect bar is for an unconnected Magpie only.
    expect(screen.queryByTestId('magpie-connect-banner')).not.toBeInTheDocument()
    expect(within(card).getByText('Background tasks').parentElement).toHaveTextContent('ollama/qwen3.6:27b')

    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }))
    expect(await screen.findByRole('dialog', { name: 'Edit Magpie' })).toBeInTheDocument()
  })

  it('tells a stopped Magpie apart and offers to open it', async () => {
    vi.spyOn(providersApi, 'list').mockResolvedValue({ providers: [magpieProvider], activeId: 'magpie-1' })
    vi.spyOn(providersApi, 'magpie').mockResolvedValue({ ...running, status: { ...running.status, running: false }, models: null })
    const open = vi.spyOn(providersApi, 'openMagpie').mockResolvedValue({ ok: true })
    render(<ProviderSettings />)

    const card = await screen.findByTestId('provider-magpie-1')
    await waitFor(() => expect(card).toHaveTextContent('Not running'))
    fireEvent.click(within(card).getByRole('button', { name: 'Open Magpie' }))
    await waitFor(() => expect(open).toHaveBeenCalled())
  })

  it('hands the add dialog\'s Magpie preset over to the connect dialog', async () => {
    vi.spyOn(providersApi, 'list').mockResolvedValue({ providers: savedProviders, activeId: null })
    vi.spyOn(providersApi, 'magpie').mockResolvedValue(running)
    render(<ProviderSettings />)

    fireEvent.click(await screen.findByRole('button', { name: /Add Model/ }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Magpie' }))
    expect(await screen.findByRole('dialog', { name: 'Connect Magpie' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Add Model' })).not.toBeInTheDocument()
  })
})
