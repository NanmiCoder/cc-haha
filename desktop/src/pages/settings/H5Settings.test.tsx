import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { H5Settings } from './H5Settings'
import { Settings } from '../Settings'
import { ProviderSettings } from './ProviderSettings'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useProviderStore } from '@/stores/providerStore'
import { providersApi } from '@/api/providers'
import { settingsApi } from '@/api/settings'
import { modelsApi } from '@/api/models'
import type { SavedProvider } from '@/types/provider'

const saved: SavedProvider = {
  id: 'fixture-provider', name: 'Fixture provider', presetId: 'custom', baseUrl: 'https://fixture.example', apiKey: '', apiFormat: 'anthropic',
  models: { main: 'fixture-model', haiku: 'fixture-model', sonnet: 'fixture-model', opus: 'fixture-model' },
}
beforeEach(() => {
  useSettingsStore.setState({ locale: 'en', outputStyle: 'default', responseLanguage: '', effortLevel: 'high', currentModel: { id: 'fixture-model', name: 'Fixture model', context: '', description: '', supportedReasoningEfforts: ['low', 'high'] } })
  useUIStore.setState({ activeSettingsTab: 'providers', pendingSettingsTab: null })
  useProviderStore.setState({ providers: [saved], activeId: null, hasLoadedProviders: true })
  vi.spyOn(providersApi, 'list').mockResolvedValue({ providers: [saved], activeId: null })
  vi.spyOn(useSettingsStore.getState(), 'fetchAll').mockResolvedValue()
  vi.spyOn(providersApi, 'getSettings').mockResolvedValue({})
  vi.spyOn(providersApi, 'updateSettings').mockResolvedValue({ ok: true })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('limits browser navigation to providers and general, with local appearance and shared agent preferences', async () => {
  useUIStore.setState({ activeSettingsTab: 'terminal' })
  render(<H5Settings />)
  const nav = within(screen.getByRole('navigation', { name: 'Settings' }))
  expect(nav.getAllByRole('button')).toHaveLength(2)
  expect(screen.queryByRole('button', { name: 'Terminal' })).not.toBeInTheDocument()
  fireEvent.click(nav.getByRole('button', { name: 'General' }))
  expect(screen.getByText('Appearance and interface language apply only to this browser.')).toBeInTheDocument()
  const update = vi.spyOn(settingsApi, 'updateUser').mockResolvedValue({ ok: true })
  fireEvent.change(screen.getByLabelText('Output Style'), { target: { value: 'Learning' } })
  await waitFor(() => expect(update).toHaveBeenCalledWith({ outputStyle: 'Learning' }))
  await waitFor(() => expect(screen.getByLabelText('Reasoning effort')).not.toBeDisabled())
  const effort = vi.spyOn(modelsApi, 'setEffort').mockResolvedValue({ ok: true, level: 'low' })
  fireEvent.change(screen.getByLabelText('Reasoning effort'), { target: { value: 'low' } })
  await waitFor(() => expect(effort).toHaveBeenCalledWith('low'))
  expect(screen.queryByLabelText(/ngrok Authtoken/)).not.toBeInTheDocument()
})
it('edits saved providers without reading or overwriting stored keys or global settings', async () => {
  const update = vi.spyOn(providersApi, 'update').mockResolvedValue({ provider: saved })
  render(<ProviderSettings browserMode />)
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.queryByRole('textbox', { name: 'Settings JSON' })).not.toBeInTheDocument()
  expect(dialog.queryByRole('button', { name: 'Test Connection' })).not.toBeInTheDocument()
  expect(dialog.queryByRole('button', { name: /Fetch Models/ })).not.toBeInTheDocument()
  expect(dialog.getByLabelText('API Key')).toHaveValue('')
  expect(providersApi.getSettings).not.toHaveBeenCalled()
  fireEvent.click(dialog.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(update).toHaveBeenCalled())
  expect(update.mock.calls[0]![0]).toBe('fixture-provider')
  expect(update.mock.calls[0]![1]).not.toHaveProperty('apiKey')
  expect(providersApi.updateSettings).not.toHaveBeenCalled()
})
it('creates a provider using the existing form and reports save errors without leaking details', async () => {
  const create = vi.spyOn(providersApi, 'create').mockRejectedValue(new Error('secret upstream credential'))
  render(<ProviderSettings browserMode />)
  fireEvent.click(screen.getByRole('button', { name: /Add Model/ }))
  const dialog = within(screen.getByRole('dialog'))
  fireEvent.change(dialog.getByPlaceholderText('sk-...'), { target: { value: 'fake-test-key' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Add' }))
  await waitFor(() => expect(create).toHaveBeenCalled())
  expect(await dialog.findByRole('alert')).toHaveTextContent('The action failed. Please retry.')
  expect(screen.queryByText('secret upstream credential')).not.toBeInTheDocument()
})
it('activates and deletes providers through the existing API without connection probes', async () => {
  const activate = vi.spyOn(providersApi, 'activate').mockResolvedValue({ ok: true })
  const remove = vi.spyOn(providersApi, 'delete').mockResolvedValue({ ok: true })
  const probe = vi.spyOn(providersApi, 'test')
  render(<ProviderSettings browserMode />)
  const row = within(await screen.findByTestId('provider-fixture-provider'))
  fireEvent.click(row.getByRole('button', { name: 'Set default' }))
  await waitFor(() => expect(activate).toHaveBeenCalledWith('fixture-provider'))
  fireEvent.click(row.getByRole('button', { name: 'Delete' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(remove).toHaveBeenCalledWith('fixture-provider'))
  expect(probe).not.toHaveBeenCalled()
})
it('changes browser appearance without writing connected computer settings', async () => {
  useUIStore.setState({ activeSettingsTab: 'general', followSystemTheme: true })
  const update = vi.spyOn(settingsApi, 'updateUser')
  render(<H5Settings />)
  fireEvent.change(screen.getByLabelText('Appearance'), { target: { value: 'ink-blue' } })
  expect(useUIStore.getState().theme).toBe('ink-blue')
  expect(useUIStore.getState().followSystemTheme).toBe(false)
  expect(update).not.toHaveBeenCalled()
})

it('routes the actual Settings page to the browser-safe panels', async () => {
  render(<Settings />)
  const nav = within(screen.getByRole('navigation', { name: 'Settings' }))
  expect(nav.getAllByRole('button')).toHaveLength(2)
  expect(screen.queryByTestId('settings-navigation')).not.toBeInTheDocument()
  expect(await screen.findByTestId('provider-fixture-provider')).toBeInTheDocument()
})

it.each([true, false])('shows beta details on focus without overflowing narrow forms (browserMode=%s)', async (browserMode) => {
  render(<ProviderSettings browserMode={browserMode} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  expect(screen.queryByText(/CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1/)).not.toBeInTheDocument()
  fireEvent.focus(within(screen.getByRole('dialog')).getByRole('button', { name: 'Disable experimental beta headers' }))
  const description = await screen.findByRole('tooltip')
  expect(description).toHaveTextContent('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1')
  expect(description.classList.contains('[overflow-wrap:anywhere]')).toBe(true)
})
