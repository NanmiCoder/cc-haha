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
    for (const name of ['Atlas Cloud', 'ApiSmart']) {
      expect(within(dialog.getByRole('button', { name })).queryByLabelText('Sponsor')).not.toBeInTheDocument()
    }
    fireEvent.click(sponsor)
    expect(dialog.getByDisplayValue('https://direct.aruhub.com:8443')).toBeInTheDocument()
    expect(dialog.getAllByDisplayValue('claude-opus-5')).toHaveLength(2)
    expect(dialog.getAllByDisplayValue('claude-sonnet-5')).toHaveLength(2)
    const offer = dialog.getByRole('button', { name: /注册即送 1 美元全模型通用额度/ })
    fireEvent.click(offer)
    expect(open).toHaveBeenCalledWith('https://aruhub.com/sign-up?aff=Z54g')
    fireEvent.click(dialog.getByRole('button', { name: /Get API Key/ }))
    expect(open).toHaveBeenCalledTimes(2)
    fireEvent.change(dialog.getAllByPlaceholderText('sk-...')[0]!, { target: { value: 'fake-aruhub-key' } })
    expect(dialog.getByText(/注册即送 1 美元全模型通用额度/)).toBeInTheDocument()
    fireEvent.change(dialog.getByDisplayValue('https://direct.aruhub.com:8443'), { target: { value: 'https://other.invalid' } })
    expect(dialog.queryByText(/注册即送 1 美元全模型通用额度/)).not.toBeInTheDocument()
    fireEvent.change(dialog.getByDisplayValue('https://other.invalid'), { target: { value: 'https://direct.aruhub.com:8443' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      presetId: 'aruhub',
      baseUrl: 'https://direct.aruhub.com:8443',
      apiFormat: 'anthropic',
      authStrategy: 'api_key',
      apiKey: 'fake-aruhub-key',
      models: { main: 'claude-opus-5', haiku: 'claude-sonnet-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5' },
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
    expect(dialog.getByDisplayValue('https://direct.aruhub.com:8443')).toBeInTheDocument()

    fireEvent.change(dialog.getAllByPlaceholderText('sk-...')[0]!, { target: { value: 'fake-aruhub-key' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      presetId: 'aruhub',
      baseUrl: 'https://direct.aruhub.com:8443',
      apiFormat: 'openai_chat',
      apiKey: 'fake-aruhub-key',
    })))
  })

  it('does not warn about the endpoint while a preset keeps its own protocol', async () => {
    render(<ProviderSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Add Model/ }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: 'ApiSmart' }))

    expect(dialog.getByRole('button', { name: /OpenAI Chat Completions \(proxy\)/ })).toBeInTheDocument()
    expect(dialog.queryByText(/point the base URL at an endpoint that serves it/)).not.toBeInTheDocument()
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
  it('keeps compatibility controls hidden for Anthropic providers', async () => {
    vi.mocked(providersApi.list).mockResolvedValue({ providers: [{ ...provider, apiFormat: 'anthropic' }], activeId: null })
    const dialog = await open()
    expect(dialog.queryByRole('textbox', { name: 'Reply output budget' })).not.toBeInTheDocument()
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
    for (const endpoint of ['/chat/completions', '/messages', '/responses']) {
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
