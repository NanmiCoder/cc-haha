import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { providersApi } from '../../api/providers'
import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'
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
  OfficialProviderModelSettings: () => null,
}))

const savedProvider: SavedProvider = {
  id: 'saved-proxy-target',
  presetId: 'custom',
  name: 'Proxy Fixture',
  baseUrl: 'https://api.example.test',
  apiKey: 'fake-saved-key',
  apiFormat: 'anthropic',
  models: { main: 'model-main', haiku: 'model-haiku', sonnet: 'model-sonnet', opus: 'model-opus' },
}

describe('per-provider network proxy override', () => {
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

  const openEditDialog = async (provider: SavedProvider, browserMode = false) => {
    vi.mocked(providersApi.list).mockResolvedValue({ providers: [provider], activeId: null })
    render(<ProviderSettings browserMode={browserMode} />)
    fireEvent.click(within(await screen.findByTestId('provider-saved-proxy-target')).getByRole('button', { name: 'Edit' }))
    return within(screen.getByRole('dialog'))
  }

  it.each([
    { mode: 'create', browserMode: false },
    { mode: 'edit', browserMode: false },
    { mode: 'create', browserMode: true },
    { mode: 'edit', browserMode: true },
  ] as const)('places the proxy after the other settings in $mode (browserMode=$browserMode)', async ({ mode, browserMode }) => {
    vi.mocked(providersApi.list).mockResolvedValue({ providers: [savedProvider], activeId: null })
    render(<ProviderSettings browserMode={browserMode} />)
    if (mode === 'create') {
      fireEvent.click(await screen.findByRole('button', { name: /Add Model/ }))
    } else {
      fireEvent.click(within(await screen.findByTestId('provider-saved-proxy-target')).getByRole('button', { name: 'Edit' }))
    }
    const dialog = within(screen.getByRole('dialog'))
    const proxy = dialog.getByRole('radiogroup', { name: 'Network proxy' })
    const earlierFields = [
      dialog.getByLabelText(/^API Key/),
      dialog.getByRole('textbox', { name: /^Main Model/ }),
      dialog.getByRole('switch', { name: 'Enable image generation' }),
    ]
    if (!browserMode) earlierFields.push(dialog.getByRole('textbox', { name: 'Settings JSON' }))
    for (const field of earlierFields) {
      expect(field.compareDocumentPosition(proxy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })

  it('defaults to follow-global and clears the override on save', async () => {
    const dialog = await openEditDialog(savedProvider)
    expect(dialog.getByRole('radio', { name: 'Follow global' })).toBeChecked()
    const update = vi.spyOn(providersApi, 'update').mockResolvedValue({ provider: savedProvider })
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith(savedProvider.id, expect.objectContaining({
      proxy: null,
    })))
  })

  it('saves a direct override', async () => {
    const dialog = await openEditDialog(savedProvider)
    fireEvent.click(dialog.getByRole('radio', { name: 'Direct' }))
    const update = vi.spyOn(providersApi, 'update').mockResolvedValue({ provider: savedProvider })
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith(savedProvider.id, expect.objectContaining({
      proxy: { mode: 'direct' },
    })))
  })

  it('requires a URL when the manual mode is selected', async () => {
    const dialog = await openEditDialog(savedProvider)
    fireEvent.click(dialog.getByRole('radio', { name: 'Manual' }))
    expect(dialog.getByRole('textbox', { name: /Proxy URL/ })).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('saves a manual override with the entered URL', async () => {
    const dialog = await openEditDialog(savedProvider)
    fireEvent.click(dialog.getByRole('radio', { name: 'Manual' }))
    fireEvent.change(dialog.getByRole('textbox', { name: /Proxy URL/ }), { target: { value: 'http://proxy.example:7890' } })
    const update = vi.spyOn(providersApi, 'update').mockResolvedValue({ provider: savedProvider })
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith(savedProvider.id, expect.objectContaining({
      proxy: { mode: 'manual', url: 'http://proxy.example:7890' },
    })))
  })

  it('loads a saved manual override into the form', async () => {
    const dialog = await openEditDialog({
      ...savedProvider,
      proxy: { mode: 'manual', url: 'http://saved.example:1080' },
    })
    expect(dialog.getByRole('radio', { name: 'Manual' })).toBeChecked()
    expect(dialog.getByRole('textbox', { name: /Proxy URL/ })).toHaveValue('http://saved.example:1080')
  })

  it.each(['direct', 'manual'] as const)('preserves the hidden %s proxy when a phone only edits the name', async (mode) => {
    // Remote projections expose the mode, but never a saved proxy URL or password.
    const provider = { ...savedProvider, apiKey: '', proxy: { mode } }
    const dialog = await openEditDialog(provider, true)
    expect(dialog.getByRole('radio', { name: mode === 'manual' ? 'Manual' : 'Direct' })).toBeChecked()
    expect(dialog.getByRole('button', { name: 'Save' })).toBeEnabled()
    if (mode === 'manual') {
      expect(dialog.getByRole('textbox', { name: /Proxy URL/ })).toHaveValue('')
      expect(dialog.getByPlaceholderText('Saved on the computer; leave blank to keep')).toBeInTheDocument()
    }
    const update = vi.spyOn(providersApi, 'update').mockResolvedValue({ provider })
    fireEvent.change(dialog.getByDisplayValue(savedProvider.name), { target: { value: 'Renamed on phone' } })
    expect(dialog.getByRole('button', { name: 'Save' })).toBeEnabled()
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith(provider.id, expect.objectContaining({ name: 'Renamed on phone' })))
    expect(update.mock.calls[0]![1]).not.toHaveProperty('proxy')
  })

  it('submits an explicit proxy replacement from a phone without restoring a hidden URL', async () => {
    const provider = { ...savedProvider, apiKey: '', proxy: { mode: 'manual' as const } }
    const dialog = await openEditDialog(provider, true)
    const update = vi.spyOn(providersApi, 'update').mockResolvedValue({ provider })
    fireEvent.change(dialog.getByRole('textbox', { name: /Proxy URL/ }), { target: { value: 'invalid' } })
    expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(dialog.getByRole('textbox', { name: /Proxy URL/ }), { target: { value: 'https://replacement.example:8443' } })
    fireEvent.change(dialog.getAllByPlaceholderText('sk-...')[0]!, { target: { value: 'fake-replacement-key' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith(provider.id, expect.objectContaining({
      proxy: { mode: 'manual', url: 'https://replacement.example:8443' }, apiKey: 'fake-replacement-key',
    })))
  })

  it('lets a phone explicitly clear its saved direct override', async () => {
    const provider = { ...savedProvider, apiKey: '', proxy: { mode: 'direct' as const } }
    const dialog = await openEditDialog(provider, true)
    const update = vi.spyOn(providersApi, 'update').mockResolvedValue({ provider })
    fireEvent.click(dialog.getByRole('radio', { name: 'Follow global' }))
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith(provider.id, expect.objectContaining({ proxy: null })))
  })
})
