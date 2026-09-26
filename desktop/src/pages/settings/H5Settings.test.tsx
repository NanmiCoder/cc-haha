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
import type { SavedProvider } from '@/types/provider'

const saved: SavedProvider = {
  id: 'fixture-provider', name: 'Fixture provider', presetId: 'custom', baseUrl: 'https://fixture.example', apiKey: '', apiFormat: 'anthropic',
  models: { main: 'fixture-model', haiku: 'fixture-model', sonnet: 'fixture-model', opus: 'fixture-model' },
}

// The H5 surface now exposes the full desktop tab list; only the tab it
// navigates into needs real rendering. Everything else is a light stub so the
// test stays focused on the navigation parity, not every page's internals.
vi.mock('../ActivitySettings', () => ({ ActivitySettings: () => <div>ActivitySettings Mock</div> }))
vi.mock('../AdapterSettings', () => ({ AdapterSettings: () => <div>AdapterSettings Mock</div> }))
vi.mock('../ComputerUseSettings', () => ({ ComputerUseSettings: () => <div>ComputerUseSettings Mock</div> }))
vi.mock('../DiagnosticsSettings', () => ({ DiagnosticsSettings: () => <div>DiagnosticsSettings Mock</div> }))
vi.mock('../McpSettings', () => ({ McpSettings: () => <div>McpSettings Mock</div> }))
vi.mock('../MemorySettings', () => ({ MemorySettings: () => <div>MemorySettings Mock</div> }))
vi.mock('../TerminalSettings', () => ({ TerminalSettings: () => <div>TerminalSettings Mock</div> }))
vi.mock('../TraceList', () => ({ TraceList: () => <div>TraceList Mock</div> }))
vi.mock('./GeneralSettings', () => ({ GeneralSettings: () => <div>GeneralSettings Mock</div> }))
vi.mock('./H5AccessSettings', () => ({ H5AccessSettings: () => <div>H5AccessSettings Mock</div> }))
vi.mock('./AboutSettings', () => ({ AboutSettings: () => <div>AboutSettings Mock</div> }))
vi.mock('../../features/pets/PetSettings', () => ({ PetSettings: () => <div>PetSettings Mock</div> }))
vi.mock('../../components/settings/AgentManager', () => ({ AgentManager: () => <div>AgentManager Mock</div> }))
vi.mock('../../components/skills/SkillList', () => ({ SkillList: () => <div>SkillList Mock</div> }))
vi.mock('../../components/skills/SkillDetail', () => ({ SkillDetail: () => <div>SkillDetail Mock</div> }))
vi.mock('../../components/plugins/PluginList', () => ({ PluginList: () => <div>PluginList Mock</div> }))
vi.mock('../../components/plugins/PluginDetail', () => ({ PluginDetail: () => <div>PluginDetail Mock</div> }))
vi.mock('../../stores/skillStore', () => ({ useSkillStore: (selector: (s: { selectedSkill: string | null }) => unknown) => selector({ selectedSkill: null }) }))
vi.mock('../../stores/pluginStore', () => ({ usePluginStore: (selector: (s: { selectedPlugin: string | null }) => unknown) => selector({ selectedPlugin: null }) }))

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
it('exposes the same full section list as the desktop rail', async () => {
  render(<H5Settings />)
  const nav = within(screen.getByRole('navigation', { name: 'Settings' }))
  expect(nav.getAllByRole('button')).toHaveLength(16)
  expect(nav.getByRole('button', { name: 'H5 Access' })).toBeInTheDocument()
  expect(nav.getByRole('button', { name: 'Terminal' })).toBeInTheDocument()
  expect(nav.getByRole('button', { name: 'About' })).toBeInTheDocument()
})
it('navigates to any desktop section, including ones the old two-pill fence hid', async () => {
  useUIStore.setState({ activeSettingsTab: 'terminal' })
  render(<H5Settings />)
  expect(screen.getByText('TerminalSettings Mock')).toBeInTheDocument()
  const nav = within(screen.getByRole('navigation', { name: 'Settings' }))
  fireEvent.click(nav.getByRole('button', { name: 'H5 Access' }))
  expect(screen.getByText('H5AccessSettings Mock')).toBeInTheDocument()
  expect(useUIStore.getState().activeSettingsTab).toBe('h5Access')
  expect(useUIStore.getState().pendingSettingsTab).toBeNull()
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
it('routes the actual Settings page to the full browser tab list', async () => {
  render(<Settings />)
  const nav = within(screen.getByRole('navigation', { name: 'Settings' }))
  expect(nav.getAllByRole('button')).toHaveLength(16)
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
