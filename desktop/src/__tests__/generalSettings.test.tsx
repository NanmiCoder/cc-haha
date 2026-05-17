import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'

import { Settings } from '../pages/Settings'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useUpdateStore } from '../stores/updateStore'
import type { SavedProvider } from '../types/provider'
import type { ProviderPreset } from '../types/providerPreset'
import type { ThemeMode } from '../types/settings'

const MOCK_DELETE_PROVIDER = vi.fn()
const MOCK_GET_SETTINGS = vi.fn()
const MOCK_UPDATE_SETTINGS = vi.fn()
const desktopNotificationsMock = vi.hoisted(() => ({
  getDesktopNotificationPermission: vi.fn(),
  notifyDesktop: vi.fn(),
  requestDesktopNotificationPermission: vi.fn(),
  openDesktopNotificationSettings: vi.fn(),
}))
const clipboardMock = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(),
}))
const providerStoreState = {
  providers: [] as SavedProvider[],
  activeId: null as string | null,
  hasLoadedProviders: true,
  presets: [] as ProviderPreset[],
  isLoading: false,
  isPresetsLoading: false,
  fetchProviders: vi.fn(),
  fetchPresets: vi.fn(),
  deleteProvider: MOCK_DELETE_PROVIDER,
  activateProvider: vi.fn(),
  activateOfficial: vi.fn(),
  testProvider: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  testConfig: vi.fn(),
}

vi.mock('../api/agents', () => ({
  agentsApi: {
    list: vi.fn().mockResolvedValue({ activeAgents: [], allAgents: [] }),
  },
}))

vi.mock('../stores/providerStore', () => ({
  useProviderStore: () => providerStoreState,
}))

vi.mock('../api/providers', () => ({
  providersApi: {
    getSettings: MOCK_GET_SETTINGS,
    updateSettings: MOCK_UPDATE_SETTINGS,
  },
}))

vi.mock('../lib/desktopNotifications', () => desktopNotificationsMock)
vi.mock('../components/chat/clipboard', () => clipboardMock)
vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,h5qr'),
  },
}))

vi.mock('../components/settings/ClaudeOfficialLogin', () => ({
  ClaudeOfficialLogin: () => <div data-testid="claude-official-login" />,
}))

vi.mock('../pages/AdapterSettings', () => ({
  AdapterSettings: () => <div>Adapter Settings Mock</div>,
}))

vi.mock('../pages/ActivitySettings', () => ({
  ActivitySettings: () => <div>Activity Settings Mock</div>,
}))

vi.mock('../stores/agentStore', () => ({
  useAgentStore: () => ({
    activeAgents: [],
    allAgents: [],
    isLoading: false,
    error: null,
    selectedAgent: null,
    fetchAgents: vi.fn(),
    selectAgent: vi.fn(),
  }),
}))

vi.mock('../stores/skillStore', () => ({
  useSkillStore: () => ({
    skills: [],
    selectedSkill: null,
    isLoading: false,
    isDetailLoading: false,
    error: null,
    fetchSkills: vi.fn(),
    fetchSkillDetail: vi.fn(),
    clearSelection: vi.fn(),
  }),
}))

vi.mock('../components/chat/CodeViewer', () => ({
  CodeViewer: ({ code }: { code: string }) => <pre data-testid="code-viewer">{code}</pre>,
}))

describe('Settings > General tab', () => {
  beforeEach(() => {
    vi.useRealTimers()
    MOCK_DELETE_PROVIDER.mockReset()
    desktopNotificationsMock.getDesktopNotificationPermission.mockReset()
    desktopNotificationsMock.notifyDesktop.mockReset()
    desktopNotificationsMock.requestDesktopNotificationPermission.mockReset()
    desktopNotificationsMock.openDesktopNotificationSettings.mockReset()
    desktopNotificationsMock.getDesktopNotificationPermission.mockResolvedValue('default')
    desktopNotificationsMock.notifyDesktop.mockResolvedValue(true)
    desktopNotificationsMock.requestDesktopNotificationPermission.mockResolvedValue('granted')
    desktopNotificationsMock.openDesktopNotificationSettings.mockResolvedValue(true)
    clipboardMock.copyTextToClipboard.mockReset()
    clipboardMock.copyTextToClipboard.mockResolvedValue(true)
    MOCK_GET_SETTINGS.mockResolvedValue({})
    MOCK_UPDATE_SETTINGS.mockResolvedValue({})
    providerStoreState.providers = []
    providerStoreState.activeId = null
    providerStoreState.hasLoadedProviders = true
    providerStoreState.presets = []
    providerStoreState.isLoading = false
    providerStoreState.isPresetsLoading = false
    providerStoreState.fetchProviders = vi.fn()
    providerStoreState.fetchPresets = vi.fn()
    providerStoreState.activateProvider = vi.fn()
    providerStoreState.activateOfficial = vi.fn()
    providerStoreState.testProvider = vi.fn()
    providerStoreState.createProvider = vi.fn()
    providerStoreState.updateProvider = vi.fn()
    providerStoreState.testConfig = vi.fn()

    useSettingsStore.setState({
      locale: 'en',
      theme: 'light',
      thinkingEnabled: true,
      skipWebFetchPreflight: true,
      desktopNotificationsEnabled: true,
      responseLanguage: '',
      uiZoom: 1,
      webSearch: { mode: 'auto', tavilyApiKey: '', braveApiKey: '' },
      h5Access: {
        enabled: false,
        tokenPreview: null,
        allowedOrigins: [],
        publicBaseUrl: null,
      },
      h5AccessError: null,
      setThinkingEnabled: vi.fn().mockImplementation(async (enabled: boolean) => {
        useSettingsStore.setState({ thinkingEnabled: enabled })
      }),
      setTheme: vi.fn().mockImplementation(async (theme: ThemeMode) => {
        useSettingsStore.setState({ theme })
      }),
      setSkipWebFetchPreflight: vi.fn().mockImplementation(async (enabled: boolean) => {
        useSettingsStore.setState({ skipWebFetchPreflight: enabled })
      }),
      setDesktopNotificationsEnabled: vi.fn().mockImplementation(async (enabled: boolean) => {
        useSettingsStore.setState({ desktopNotificationsEnabled: enabled })
      }),
      setResponseLanguage: vi.fn().mockImplementation(async (language: string) => {
        useSettingsStore.setState({ responseLanguage: language })
      }),
      setUiZoom: vi.fn().mockImplementation((uiZoom: number) => {
        useSettingsStore.setState({ uiZoom })
      }),
      setWebSearch: vi.fn().mockImplementation(async (webSearch) => {
        useSettingsStore.setState({ webSearch })
      }),
      enableH5Access: vi.fn().mockImplementation(async () => {
        const current = useSettingsStore.getState().h5Access
        useSettingsStore.setState({
          h5Access: {
            ...current,
            enabled: true,
            tokenPreview: 'h5_default_generated_token'.slice(0, 8),
          },
        })
        return 'h5_default_generated_token'
      }),
      disableH5Access: vi.fn().mockImplementation(async () => {
        const current = useSettingsStore.getState().h5Access
        useSettingsStore.setState({
          h5Access: {
            ...current,
            enabled: false,
            tokenPreview: null,
          },
        })
      }),
      regenerateH5AccessToken: vi.fn().mockImplementation(async () => {
        const current = useSettingsStore.getState().h5Access
        useSettingsStore.setState({
          h5Access: {
            ...current,
            enabled: true,
            tokenPreview: 'h5_default_regenerated_token'.slice(0, 8),
          },
        })
        return 'h5_default_regenerated_token'
      }),
      updateH5AccessSettings: vi.fn(),
    })

    useUIStore.setState({ pendingSettingsTab: null })
    useUpdateStore.setState({
      status: 'idle',
      availableVersion: null,
      releaseNotes: null,
      progressPercent: 0,
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
      checkedAt: null,
      shouldPrompt: false,
      initialize: vi.fn().mockResolvedValue(undefined),
      checkForUpdates: vi.fn().mockResolvedValue(null),
      installUpdate: vi.fn().mockResolvedValue(undefined),
      dismissPrompt: vi.fn(),
    })
  })

  it('shows WebFetch preflight toggle enabled by default', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    const toggle = screen.getByLabelText('Skip WebFetch domain preflight')
    expect(toggle).toBeChecked()
  })

  it('offers the pure white appearance theme', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    const pureWhite = screen.getByRole('button', { name: 'Pure White' })
    const warmClassic = screen.getByRole('button', { name: 'Warm Classic' })
    const dark = screen.getByRole('button', { name: 'Dark' })

    expect((pureWhite.compareDocumentPosition(warmClassic) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
    expect((warmClassic.compareDocumentPosition(dark) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Pure White' }))

    expect(useSettingsStore.getState().setTheme).toHaveBeenCalledWith('white')
  })

  it('marks the pure white appearance theme as selected', () => {
    useSettingsStore.setState({ theme: 'white' })
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    expect(screen.getByRole('button', { name: 'Pure White' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Warm Classic' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('keeps UI zoom below system notifications because it is a secondary setting', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    const notificationsHeading = screen.getByRole('heading', { name: 'System Notifications' })
    const uiZoomHeading = screen.getByRole('heading', { name: 'UI Zoom' })
    const webFetchHeading = screen.getByRole('heading', { name: 'WebFetch Preflight' })

    expect((notificationsHeading.compareDocumentPosition(uiZoomHeading) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
    expect((uiZoomHeading.compareDocumentPosition(webFetchHeading) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
  })

  it('previews UI zoom while dragging and applies it once on release', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    expect(screen.getByText('Shortcuts are faster:')).toBeInTheDocument()
    expect(screen.getByText('macOS')).toBeInTheDocument()
    expect(screen.getByText('Windows / Linux')).toBeInTheDocument()
    expect(screen.getByText('0 resets zoom to 100%.')).toBeInTheDocument()

    const slider = screen.getByLabelText('UI Zoom')
    expect(slider).toHaveAttribute('step', '0.01')

    fireEvent.pointerDown(slider, { pointerId: 1 })
    await act(async () => {
      fireEvent.change(slider, {
        target: { value: '1.25', valueAsNumber: 1.25 },
      })
    })

    expect(screen.getAllByText('125%')).toHaveLength(2)
    expect(useSettingsStore.getState().setUiZoom).not.toHaveBeenCalledWith(1.25)
    expect(useSettingsStore.getState().uiZoom).toBe(1)
    expect(slider).toHaveValue('1.25')
    expect(slider).toHaveClass('settings-zoom-range')
    expect(slider.closest('.settings-zoom-control')).toHaveClass('is-dragging')
    expect(slider.closest('.settings-zoom-control')).toHaveStyle({ '--settings-zoom-range-progress': '50%' })

    await act(async () => {
      fireEvent.pointerUp(slider, { pointerId: 1 })
    })

    expect(useSettingsStore.getState().setUiZoom).toHaveBeenCalledWith(1.25)
    expect(slider.closest('.settings-zoom-control')).not.toHaveClass('is-dragging')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reset UI zoom to 100%' }))
    })

    expect(useSettingsStore.getState().setUiZoom).toHaveBeenLastCalledWith(1)
  })

  it('updates the UI zoom slider when shortcut zoom changes the shared setting while Settings is open', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    const slider = screen.getByLabelText('UI Zoom')

    await act(async () => {
      useSettingsStore.setState({ uiZoom: 1.1 })
    })

    expect(slider).toHaveValue('1.1')
    expect(screen.getAllByText('110%')).toHaveLength(2)
    expect(slider.closest('.settings-zoom-control')).toHaveStyle({ '--settings-zoom-range-progress': '40%' })
  })

  it('opens the Token usage tab from Settings navigation above Diagnostics', () => {
    render(<Settings />)

    const usageTab = screen.getByText('Token usage')
    const diagnosticsTab = screen.getByText('Diagnostics')
    expect((usageTab.compareDocumentPosition(diagnosticsTab) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)

    fireEvent.click(usageTab)

    expect(screen.getByText('Activity Settings Mock')).toBeInTheDocument()
  })

  it('lets the user disable WebFetch preflight skipping', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    const toggle = screen.getByLabelText('Skip WebFetch domain preflight')
    fireEvent.click(toggle)

    expect(useSettingsStore.getState().setSkipWebFetchPreflight).toHaveBeenCalledWith(false)
  })

  it('lets the user disable thinking mode for new sessions', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    const toggle = screen.getByLabelText('Enable thinking mode')
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)

    expect(useSettingsStore.getState().setThinkingEnabled).toHaveBeenCalledWith(false)
  })

  it('uses the shared dropdown for response language', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    expect(screen.queryByRole('combobox', { name: 'Response Language' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Response Language' })).not.toBeInTheDocument()

    const trigger = screen.getByRole('button', { name: 'Response Language' })
    expect(trigger).toHaveTextContent('Default (English)')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: '中文 (Chinese)' }))

    expect(useSettingsStore.getState().setResponseLanguage).toHaveBeenCalledWith('chinese')
  })

  it('lets the user disable desktop system notifications', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    const toggle = screen.getByLabelText('Enable system notifications')
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)

    expect(useSettingsStore.getState().setDesktopNotificationsEnabled).toHaveBeenCalledWith(false)
    expect(desktopNotificationsMock.requestDesktopNotificationPermission).not.toHaveBeenCalled()
  })

  it('requests native notification permission when desktop notifications are enabled', async () => {
    useSettingsStore.setState({ desktopNotificationsEnabled: false })
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Enable system notifications'))
    })

    expect(useSettingsStore.getState().setDesktopNotificationsEnabled).toHaveBeenCalledWith(true)
    await vi.waitFor(() => {
      expect(desktopNotificationsMock.requestDesktopNotificationPermission).toHaveBeenCalledTimes(1)
    })
    expect(desktopNotificationsMock.notifyDesktop).toHaveBeenCalledWith({
      title: 'Claude Code Haha notifications are enabled',
      body: 'Permission prompts and completed agent replies will now use system notifications.',
    })
  })

  it('opens system settings when enabling notifications finds system denial', async () => {
    useSettingsStore.setState({ desktopNotificationsEnabled: false })
    desktopNotificationsMock.requestDesktopNotificationPermission.mockResolvedValue('denied')
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Enable system notifications'))
    })

    await vi.waitFor(() => {
      expect(desktopNotificationsMock.openDesktopNotificationSettings).toHaveBeenCalledTimes(1)
    })
  })

  it('moves H5 access out of General into its own Settings tab', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    expect(screen.queryByRole('region', { name: 'H5 Access' })).not.toBeInTheDocument()

    const generalTab = screen.getByText('General')
    const h5Tab = screen.getByText('H5 Access')
    expect((generalTab.compareDocumentPosition(h5Tab) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
    fireEvent.click(h5Tab)

    const section = screen.getByRole('region', { name: 'H5 Access' })
    expect(within(section).getByLabelText('Enable H5 access')).not.toBeChecked()
    expect(within(section).getByText('Disabled')).toBeInTheDocument()
    expect(within(section).queryByText('Token preview')).not.toBeInTheDocument()
    expect(within(section).queryByRole('button', { name: 'Regenerate token' })).not.toBeInTheDocument()
    expect(within(section).queryByLabelText('Allowed origins')).not.toBeInTheDocument()
  })

  it('confirms the LAN risk before enabling H5 access and renders a token QR link', async () => {
    useSettingsStore.setState({
      h5Access: {
        enabled: false,
        tokenPreview: null,
        allowedOrigins: [],
        publicBaseUrl: 'http://192.168.0.102:3456',
      },
    })
    render(<Settings />)

    fireEvent.click(screen.getByText('H5 Access'))
    const section = screen.getByRole('region', { name: 'H5 Access' })

    fireEvent.click(within(section).getByLabelText('Enable H5 access'))
    const dialog = screen.getByRole('dialog', { name: 'Enable LAN H5 access?' })
    expect(within(dialog).getByText(/desktop H5 app on your LAN address and port/i)).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Enable H5 access' }))
    })

    expect(useSettingsStore.getState().enableH5Access).toHaveBeenCalledTimes(1)
    expect(await within(section).findByAltText('H5 access QR code')).toBeInTheDocument()
    expect(within(section).getByText('http://192.168.0.102:3456/?serverUrl=http%3A%2F%2F192.168.0.102%3A3456&h5Token=h5_default_generated_token')).toBeInTheDocument()
  })

  it('copies the QR launch URL with the generated H5 token', async () => {
    useSettingsStore.setState({
      h5Access: {
        enabled: false,
        tokenPreview: null,
        allowedOrigins: [],
        publicBaseUrl: 'http://192.168.0.102:3456',
      },
    })
    render(<Settings />)

    fireEvent.click(screen.getByText('H5 Access'))
    const section = screen.getByRole('region', { name: 'H5 Access' })
    fireEvent.click(within(section).getByLabelText('Enable H5 access'))

    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog', { name: 'Enable LAN H5 access?' })).getByRole('button', { name: 'Enable H5 access' }))
    })

    await within(section).findByAltText('H5 access QR code')
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Copy QR link' }))
    })

    expect(clipboardMock.copyTextToClipboard).toHaveBeenCalledWith(
      'http://192.168.0.102:3456/?serverUrl=http%3A%2F%2F192.168.0.102%3A3456&h5Token=h5_default_generated_token',
    )
    expect(useUIStore.getState().toasts[useUIStore.getState().toasts.length - 1]).toMatchObject({
      type: 'success',
      message: 'QR link copied.',
    })
  })

  it('guides enabled H5 users to generate a token before the QR code exists', async () => {
    useSettingsStore.setState({
      h5Access: {
        enabled: true,
        tokenPreview: 'h5oldtok',
        allowedOrigins: [],
        publicBaseUrl: 'http://192.168.0.102:3456',
      },
    })
    render(<Settings />)

    fireEvent.click(screen.getByText('H5 Access'))
    const section = screen.getByRole('region', { name: 'H5 Access' })

    expect(within(section).getByText('Generate a token to create the QR code.')).toBeInTheDocument()
    expect(within(section).getByText('Click Generate token to create a QR link that can be scanned.')).toBeInTheDocument()
    expect(within(section).queryByAltText('H5 access QR code')).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Generate token' }))
    })

    expect(useSettingsStore.getState().regenerateH5AccessToken).toHaveBeenCalledTimes(1)
    expect(await within(section).findByAltText('H5 access QR code')).toBeInTheDocument()
  })

  it('shows the generated H5 token as a fallback when requested', async () => {
    useSettingsStore.setState({
      h5Access: {
        enabled: false,
        tokenPreview: null,
        allowedOrigins: [],
        publicBaseUrl: 'http://192.168.0.102:3456',
      },
    })
    render(<Settings />)

    fireEvent.click(screen.getByText('H5 Access'))
    const section = screen.getByRole('region', { name: 'H5 Access' })
    fireEvent.click(within(section).getByLabelText('Enable H5 access'))

    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog', { name: 'Enable LAN H5 access?' })).getByRole('button', { name: 'Enable H5 access' }))
    })

    fireEvent.click(within(section).getByRole('button', { name: 'Show token' }))

    expect(within(section).getByText('h5_default_generated_token')).toBeInTheDocument()
  })

  it('copies the H5 URL when available', async () => {
    useSettingsStore.setState({
      h5Access: {
        enabled: true,
        tokenPreview: 'h5url123',
        allowedOrigins: ['https://phone.example'],
        publicBaseUrl: 'https://phone.example/app',
      },
    })
    render(<Settings />)

    fireEvent.click(screen.getByText('H5 Access'))
    const section = screen.getByRole('region', { name: 'H5 Access' })

    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Copy H5 URL' }))
    })

    expect(clipboardMock.copyTextToClipboard).toHaveBeenCalledWith('https://phone.example/app')
    expect(useUIStore.getState().toasts[useUIStore.getState().toasts.length - 1]).toMatchObject({
      type: 'success',
      message: 'H5 URL copied.',
    })
  })

  it('shows the H5-specific store error when the H5 settings load failed', () => {
    useSettingsStore.setState({ h5AccessError: 'H5 unavailable' })
    render(<Settings />)

    fireEvent.click(screen.getByText('H5 Access'))

    const section = screen.getByRole('region', { name: 'H5 Access' })
    expect(within(section).getByText('H5 unavailable')).toBeInTheDocument()
  })

  it('updates H5 public URL from General settings', async () => {
    useSettingsStore.setState({
      h5Access: {
        enabled: false,
        tokenPreview: 'h5a1b2c3',
        allowedOrigins: ['https://old.example'],
        publicBaseUrl: null,
      },
    })
    render(<Settings />)

    fireEvent.click(screen.getByText('H5 Access'))

    const section = screen.getByRole('region', { name: 'H5 Access' })
    fireEvent.change(within(section).getByLabelText('Public URL'), {
      target: { value: 'https://phone.example/app' },
    })

    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Save H5 settings' }))
    })

    expect(useSettingsStore.getState().updateH5AccessSettings).toHaveBeenCalledWith({
      publicBaseUrl: 'https://phone.example/app',
    })
  })

  it('saves WebSearch fallback provider settings', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    fireEvent.click(screen.getByRole('button', { name: 'Tavily' }))
    fireEvent.change(screen.getByLabelText('Tavily API key'), {
      target: { value: 'tvly-test-key' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(useSettingsStore.getState().setWebSearch).toHaveBeenCalledWith({
      mode: 'tavily',
      tavilyApiKey: 'tvly-test-key',
      braveApiKey: '',
    })
  })

  it('links to WebSearch provider API key dashboards', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    expect(screen.getByRole('link', { name: 'Get Tavily API key' })).toHaveAttribute(
      'href',
      'https://app.tavily.com/home',
    )
    expect(screen.getByRole('link', { name: 'Get Brave Search API key' })).toHaveAttribute(
      'href',
      'https://api-dashboard.search.brave.com/app/keys',
    )
  })

  it('keeps extension tabs available alongside the terminal tab', () => {
    render(<Settings />)

    expect(screen.queryByText('Install')).not.toBeInTheDocument()
    expect(screen.getByText('Terminal')).toBeInTheDocument()
    expect(screen.getByText('MCP')).toBeInTheDocument()
    expect(screen.getByText('Plugins')).toBeInTheDocument()
  })
})

describe('Settings > Providers tab', () => {
  beforeEach(() => {
    MOCK_DELETE_PROVIDER.mockReset()
    MOCK_GET_SETTINGS.mockResolvedValue({})
    MOCK_UPDATE_SETTINGS.mockResolvedValue({})
    providerStoreState.providers = [
      {
        id: 'provider-1',
        name: 'MiniMax-M2.7-highspeed(openai)',
        presetId: 'custom',
        apiKey: '***',
        baseUrl: 'https://api.minimaxi.com',
        apiFormat: 'openai_chat',
        models: {
          main: 'MiniMax-M2.7-highspeed',
          haiku: '',
          sonnet: '',
          opus: '',
        },
        notes: '',
      },
    ]
    providerStoreState.activeId = null
    providerStoreState.hasLoadedProviders = true
  })

  it('does not query official OAuth status before providers finish loading', () => {
    providerStoreState.providers = []
    providerStoreState.activeId = null
    providerStoreState.hasLoadedProviders = false

    render(<Settings />)

    expect(screen.queryByTestId('claude-official-login')).not.toBeInTheDocument()
  })

  it('shows official OAuth status only after official provider is confirmed active', () => {
    providerStoreState.providers = []
    providerStoreState.activeId = null
    providerStoreState.hasLoadedProviders = true

    render(<Settings />)

    expect(screen.getByTestId('claude-official-login')).toBeInTheDocument()
  })

  it('requires confirmation before deleting a provider', async () => {
    render(<Settings />)

    await act(async () => {
      fireEvent.click(screen.getAllByText('Delete')[0]!)
      await Promise.resolve()
    })

    expect(MOCK_DELETE_PROVIDER).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Delete provider "MiniMax-M2.7-highspeed(openai)"? This cannot be undone.')).toBeInTheDocument()

    const dialog = screen.getByRole('dialog')
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
      await Promise.resolve()
    })

    expect(MOCK_DELETE_PROVIDER).toHaveBeenCalledWith('provider-1')
  })

  it('uses the shared dropdown for API format in the provider form', () => {
    providerStoreState.presets = [
      {
        id: 'custom',
        name: 'Custom',
        baseUrl: 'https://api.example.com/anthropic',
        apiFormat: 'anthropic',
        defaultModels: {
          main: 'custom-main',
          haiku: '',
          sonnet: '',
          opus: '',
        },
        needsApiKey: true,
        websiteUrl: '',
      },
    ]

    render(<Settings />)

    fireEvent.click(screen.getByRole('button', { name: /Add Provider/i }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: /Anthropic Messages \(native\)/i }))
    fireEvent.click(within(dialog).getByRole('button', { name: /OpenAI Responses API \(proxy\)/i }))

    expect(within(dialog).getByRole('button', { name: /OpenAI Responses API \(proxy\)/i })).toBeInTheDocument()
    expect(within(dialog).getByText('Requests will be translated via the local proxy')).toBeInTheDocument()
  })

  it('hides the API key by default and reveals it from the eye button', () => {
    providerStoreState.presets = [
      {
        id: 'custom',
        name: 'Custom',
        baseUrl: 'https://api.example.com/anthropic',
        apiFormat: 'anthropic',
        defaultModels: {
          main: 'custom-main',
          haiku: '',
          sonnet: '',
          opus: '',
        },
        needsApiKey: true,
        websiteUrl: '',
      },
    ]

    render(<Settings />)

    fireEvent.click(screen.getByRole('button', { name: /Add Provider/i }))

    const dialog = screen.getByRole('dialog')
    const apiKeyInput = within(dialog).getByPlaceholderText('sk-...')

    expect(apiKeyInput).toHaveAttribute('type', 'password')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Show API Key' }))

    expect(apiKeyInput).toHaveAttribute('type', 'text')
    expect(within(dialog).getByRole('button', { name: 'Hide API Key' })).toBeInTheDocument()
  })
})

describe('Settings > About tab', () => {
  beforeEach(() => {
    useUIStore.setState({ pendingSettingsTab: 'about' })
    useUpdateStore.setState({
      status: 'available',
      availableVersion: '0.1.5',
      releaseNotes: '# Claude Code Haha v0.1.5\n\n- Fixed updater rendering\n- Added markdown support',
      progressPercent: 0,
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
      checkedAt: null,
      shouldPrompt: true,
      initialize: vi.fn().mockResolvedValue(undefined),
      checkForUpdates: vi.fn().mockResolvedValue(null),
      installUpdate: vi.fn().mockResolvedValue(undefined),
      dismissPrompt: vi.fn(),
    })
  })

  it('renders release notes with markdown formatting', async () => {
    render(<Settings />)

    expect(await screen.findByRole('heading', { name: 'Claude Code Haha v0.1.5' })).toBeInTheDocument()
    expect(screen.getByText('Fixed updater rendering')).toBeInTheDocument()
    expect(screen.getByText('Added markdown support')).toBeInTheDocument()
  })

  it('shows downloaded bytes instead of a fake zero percent when total size is unknown', async () => {
    useUpdateStore.setState({
      status: 'downloading',
      availableVersion: '0.1.5',
      releaseNotes: '# Claude Code Haha v0.1.5',
      progressPercent: 0,
      downloadedBytes: 1536,
      totalBytes: null,
      error: null,
      checkedAt: null,
      shouldPrompt: true,
      initialize: vi.fn().mockResolvedValue(undefined),
      checkForUpdates: vi.fn().mockResolvedValue(null),
      installUpdate: vi.fn().mockResolvedValue(undefined),
      dismissPrompt: vi.fn(),
    })

    render(<Settings />)

    expect(await screen.findByText('Downloading update... 1.5 KB downloaded')).toBeInTheDocument()
    expect(screen.queryByText('Downloading update... 0%')).not.toBeInTheDocument()
  })
})
