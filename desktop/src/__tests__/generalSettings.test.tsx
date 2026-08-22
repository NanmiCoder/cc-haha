import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'

import { Settings } from '../pages/Settings'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useUpdateStore } from '../stores/updateStore'
import type { ProviderModelsResult, SavedProvider } from '../types/provider'
import type { ProviderPreset } from '../types/providerPreset'
import type { AppMode, ChatSendBehavior, PermissionMode, ThemeMode, UpdateProxySettings } from '../types/settings'
import { browserHost } from '../lib/desktopHost/browserHost'
import { settingsApi } from '../api/settings'

const MOCK_DELETE_PROVIDER = vi.fn()
const MOCK_GET_SETTINGS = vi.fn()
const MOCK_UPDATE_SETTINGS = vi.fn()
const desktopNotificationsMock = vi.hoisted(() => ({
  getDesktopNotificationPermission: vi.fn(),
  getDesktopNotificationPlatform: vi.fn(),
  notifyDesktop: vi.fn(),
  requestDesktopNotificationPermission: vi.fn(),
  openDesktopNotificationSettings: vi.fn(),
}))
const clipboardMock = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(),
}))
const tauriCoreMock = vi.hoisted(() => ({
  invoke: vi.fn(),
}))
const tauriDialogMock = vi.hoisted(() => ({
  open: vi.fn(),
}))
const tauriProcessMock = vi.hoisted(() => ({
  relaunch: vi.fn(),
}))
const providerStoreState = {
  providers: [] as SavedProvider[],
  providerOrder: [] as string[],
  activeId: null as string | null,
  hasLoadedProviders: true,
  presets: [] as ProviderPreset[],
  isLoading: false,
  fetchProviders: vi.fn(),
  deleteProvider: MOCK_DELETE_PROVIDER,
  activateProvider: vi.fn(),
  activateOfficial: vi.fn(),
  testProvider: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  testConfig: vi.fn(),
  scanCcSwitch: vi.fn(),
  importCcSwitch: vi.fn(),
  fetchModels: vi.fn(),
}

const ZHIPU_REGIONAL_PRESET: ProviderPreset = {
  id: 'zhipuglm',
  name: 'Zhipu GLM',
  baseUrl: 'https://open.bigmodel.cn/api/anthropic',
  regionalEndpoints: [
    { region: 'cn_zh', baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
    { region: 'global_en', baseUrl: 'https://api.z.ai/api/anthropic' },
  ],
  apiFormat: 'anthropic',
  defaultModels: {
    main: 'glm-5.2[1m]',
    haiku: 'glm-4.7',
    sonnet: 'glm-5.2[1m]',
    opus: 'glm-5.2[1m]',
  },
  needsApiKey: true,
  websiteUrl: 'https://open.bigmodel.cn',
  apiKeyUrl: 'https://www.bigmodel.cn/api-keys',
  promoText: 'Mainland China promotion',
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
vi.mock('@/lib/clipboard', () => clipboardMock)
vi.mock('@tauri-apps/api/core', () => tauriCoreMock)
vi.mock('@tauri-apps/plugin-dialog', () => tauriDialogMock)
vi.mock('@tauri-apps/plugin-process', () => tauriProcessMock)
vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,h5qr'),
  },
}))

vi.mock('../components/settings/ClaudeOfficialLogin', () => ({
  ClaudeOfficialLogin: () => <div data-testid="claude-official-login" />,
}))

vi.mock('../components/settings/ChatGPTOfficialLogin', () => ({
  ChatGPTOfficialLogin: () => <div data-testid="chatgpt-official-login" />,
}))

vi.mock('../components/settings/GrokOfficialLogin', () => ({
  GrokOfficialLogin: () => <div data-testid="grok-official-login" />,
}))

vi.mock('../pages/AdapterSettings', () => ({
  AdapterSettings: () => <div>Adapter Settings Mock</div>,
}))

vi.mock('../pages/ActivitySettings', () => ({
  ActivitySettings: () => <div>Activity Settings Mock</div>,
}))

vi.mock('../pages/TraceList', () => ({
  TraceList: () => <div>Trace List Mock</div>,
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

function installElectronDesktopHost() {
  window.desktopHost = {
    ...browserHost,
    kind: 'electron',
    isDesktop: true,
    capabilities: {
      ...browserHost.capabilities,
      appMode: true,
      dialogs: true,
      notifications: true,
      shell: true,
      updates: true,
      zoom: true,
    },
    app: {
      ...browserHost.app,
      getVersion: vi.fn().mockResolvedValue('0.3.2'),
    },
    dialogs: {
      ...browserHost.dialogs,
      open: vi.fn((options) => tauriDialogMock.open(options)),
    },
    shell: {
      ...browserHost.shell,
      open: vi.fn().mockResolvedValue(undefined),
    },
    appMode: {
      ...browserHost.appMode,
      prepareRestart: vi.fn(() => tauriCoreMock.invoke('prepare_for_app_mode_restart')),
      restart: vi.fn(() => tauriProcessMock.relaunch()),
    },
  }
}

describe('Settings > General tab', () => {
  beforeEach(() => {
    vi.useRealTimers()
    MOCK_DELETE_PROVIDER.mockReset()
    desktopNotificationsMock.getDesktopNotificationPermission.mockReset()
    desktopNotificationsMock.getDesktopNotificationPlatform.mockReset()
    desktopNotificationsMock.notifyDesktop.mockReset()
    desktopNotificationsMock.requestDesktopNotificationPermission.mockReset()
    desktopNotificationsMock.openDesktopNotificationSettings.mockReset()
    desktopNotificationsMock.getDesktopNotificationPermission.mockResolvedValue('default')
    desktopNotificationsMock.getDesktopNotificationPlatform.mockReturnValue('darwin')
    desktopNotificationsMock.notifyDesktop.mockResolvedValue(true)
    desktopNotificationsMock.requestDesktopNotificationPermission.mockResolvedValue('granted')
    desktopNotificationsMock.openDesktopNotificationSettings.mockResolvedValue(true)
    clipboardMock.copyTextToClipboard.mockReset()
    clipboardMock.copyTextToClipboard.mockResolvedValue(true)
    tauriCoreMock.invoke.mockReset()
    tauriCoreMock.invoke.mockResolvedValue(undefined)
    tauriDialogMock.open.mockReset()
    tauriDialogMock.open.mockResolvedValue('/Users/test/cc-haha-data')
    tauriProcessMock.relaunch.mockReset()
    tauriProcessMock.relaunch.mockResolvedValue(undefined)
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__
    delete (window as unknown as { __TAURI__?: object }).__TAURI__
    installElectronDesktopHost()
    MOCK_GET_SETTINGS.mockResolvedValue({})
    MOCK_UPDATE_SETTINGS.mockResolvedValue({})
    providerStoreState.providers = []
    providerStoreState.providerOrder = []
    providerStoreState.activeId = null
    providerStoreState.hasLoadedProviders = true
    providerStoreState.presets = []
    providerStoreState.isLoading = false
    providerStoreState.fetchProviders = vi.fn()
    providerStoreState.activateProvider = vi.fn()
    providerStoreState.activateOfficial = vi.fn()
    providerStoreState.testProvider = vi.fn()
    providerStoreState.createProvider = vi.fn()
    providerStoreState.updateProvider = vi.fn()
    providerStoreState.testConfig = vi.fn()
    providerStoreState.scanCcSwitch = vi.fn()
    providerStoreState.importCcSwitch = vi.fn()
    providerStoreState.fetchModels = vi.fn()

    useSettingsStore.setState({
      locale: 'en',
      permissionMode: 'default',
      currentModel: {
        id: 'claude-opus-4-8',
        name: 'Opus 4.8',
        description: 'Highest capability for long-running tasks',
        context: '1m',
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      effortLevel: 'max',
      autoModeOptInAccepted: false,
      thinkingEnabled: true,
      workflowKeywordTriggerEnabled: true,
      autoDreamEnabled: false,
      skipWebFetchPreflight: true,
      desktopNotificationsEnabled: true,
      traceCapture: { enabled: true, storageDir: '/Users/test/.claude/cc-haha/traces' },
      chatSendBehavior: 'enter',
      responseLanguage: '',
      proxyManagedSettingsWarning: false,
      uiZoom: 1,
      webSearch: { mode: 'auto', tavilyApiKey: '', braveApiKey: '' },
      network: {
        aiRequestTimeoutMs: 120_000,
        proxy: { mode: 'direct', url: '' },
      },
      h5Access: {
        enabled: false,
        token: null,
        tokenPreview: null,
        allowedOrigins: [],
        publicBaseUrl: null,
        fixedPort: null,
        disconnectGraceSeconds: null,
      },
      h5AccessDiagnostics: null,
      h5AccessError: null,
      outputStyle: 'default',
      outputStyles: [
        {
          value: 'default',
          label: 'Default',
          description: 'Default response style',
          source: 'built-in',
        },
      ],
      outputStyleScope: 'userSettings',
      outputStyleWorkDir: null,
      outputStylesLoading: false,
      outputStyleError: null,
      fetchOutputStyles: vi.fn().mockResolvedValue(undefined),
      setOutputStyle: vi.fn().mockImplementation(async (outputStyle: string) => {
        useSettingsStore.setState({ outputStyle })
      }),
      setThinkingEnabled: vi.fn().mockImplementation(async (enabled: boolean) => {
        useSettingsStore.setState({ thinkingEnabled: enabled })
      }),
      setEffort: vi.fn().mockImplementation(async (effortLevel) => {
        useSettingsStore.setState({ effortLevel })
      }),
      setAutoDreamEnabled: vi.fn().mockImplementation(async (enabled: boolean) => {
        useSettingsStore.setState({ autoDreamEnabled: enabled })
      }),
      setTheme: vi.fn().mockImplementation(async (theme: ThemeMode) => {
        useUIStore.setState({ theme })
      }),
      setPermissionMode: vi.fn().mockImplementation(async (permissionMode: PermissionMode) => {
        useSettingsStore.setState({ permissionMode })
      }),
      acceptAutoModeOptIn: vi.fn().mockImplementation(async () => {
        useSettingsStore.setState({ autoModeOptInAccepted: true } as never)
      }),
      setSkipWebFetchPreflight: vi.fn().mockImplementation(async (enabled: boolean) => {
        useSettingsStore.setState({ skipWebFetchPreflight: enabled })
      }),
      setDesktopNotificationsEnabled: vi.fn().mockImplementation(async (enabled: boolean) => {
        useSettingsStore.setState({ desktopNotificationsEnabled: enabled })
      }),
      setTraceCaptureEnabled: vi.fn().mockImplementation(async (enabled: boolean) => {
        const current = useSettingsStore.getState().traceCapture
        useSettingsStore.setState({ traceCapture: { ...current, enabled } })
      }),
      setChatSendBehavior: vi.fn().mockImplementation(async (chatSendBehavior: ChatSendBehavior) => {
        useSettingsStore.setState({ chatSendBehavior })
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
      setNetwork: vi.fn().mockImplementation(async (network) => {
        useSettingsStore.setState({ network })
      }),
      appMode: {
        mode: 'default',
        portableDir: null,
        activeConfigDir: '/Users/test/.claude',
        configDirSource: 'system',
      },
      appModeRequiresRestart: false,
      fetchAppMode: vi.fn().mockResolvedValue(undefined),
      setAppMode: vi.fn().mockImplementation(async (mode: AppMode, portableDir?: string | null) => {
        useSettingsStore.setState({
          appMode: {
            mode,
            portableDir: mode === 'portable' ? portableDir ?? null : null,
            activeConfigDir: mode === 'portable' ? portableDir ?? null : '/Users/test/.claude',
            configDirSource: mode === 'portable' ? 'portable' : 'system',
          },
          appModeRequiresRestart: true,
        })
      }),
      enableH5Access: vi.fn().mockImplementation(async () => {
        const current = useSettingsStore.getState().h5Access
        useSettingsStore.setState({
          h5Access: {
            ...current,
            enabled: true,
            token: 'h5_default_generated_token',
            tokenPreview: 'h5_default_generated_token'.slice(0, 8),
          },
        })
        return 'h5_default_generated_token'
      }),
      disableH5Access: vi.fn().mockImplementation(async () => {
        // Mirrors the server: disabling keeps the stored token so a later
        // re-enable restores access for already-paired phones.
        const current = useSettingsStore.getState().h5Access
        useSettingsStore.setState({
          h5Access: {
            ...current,
            enabled: false,
          },
        })
      }),
      regenerateH5AccessToken: vi.fn().mockImplementation(async () => {
        const current = useSettingsStore.getState().h5Access
        useSettingsStore.setState({
          h5Access: {
            ...current,
            enabled: true,
            token: 'h5_default_regenerated_token',
            tokenPreview: 'h5_default_regenerated_token'.slice(0, 8),
          },
        })
        return 'h5_default_regenerated_token'
      }),
      updateH5AccessSettings: vi.fn(),
    })

    useUIStore.setState({
      activeSettingsTab: 'providers',
      pendingSettingsTab: null,
      toasts: [],
      // Fresh installs follow the system, which narrows the theme picker to
      // its light half. Tests that exercise the full picker opt out here and
      // the follow-the-system cases turn it back on.
      followSystemTheme: false,
      lightTheme: 'white',
    })
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

  it('keeps the selected settings tab when returning to Settings', () => {
    const { unmount } = render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    expect(screen.getByLabelText('Skip WebFetch domain preflight')).toBeInTheDocument()

    unmount()
    render(<Settings />)

    expect(screen.getByLabelText('Skip WebFetch domain preflight')).toBeInTheDocument()
  })

  it('offers all six palettes, paper grounds before ink ones', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    // The picker order is load-bearing: the four paper grounds come first, then
    // the two ink ones, so the list reads light-to-dark rather than shuffled.
    const order = ['Pure White', 'Paper', 'Warm Classic', 'Celadon', 'Ink Night', 'Ink Blue']
      .map((name) => screen.getByRole('button', { name }))

    for (const [index, chip] of order.slice(0, -1).entries()) {
      const next = order[index + 1]!
      expect(
        (chip.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        `${order[index + 1]} should follow ${order[index]}`,
      ).toBe(true)
    }

    fireEvent.click(screen.getByRole('button', { name: 'Pure White' }))
    expect(useSettingsStore.getState().setTheme).toHaveBeenCalledWith('white')

    fireEvent.click(screen.getByRole('button', { name: 'Ink Blue' }))
    expect(useSettingsStore.getState().setTheme).toHaveBeenCalledWith('ink-blue')
  })

  it('gives the settings rail the handoff width and a rounded selected item', () => {
    useUIStore.setState({ activeSettingsTab: 'general', pendingSettingsTab: null })
    render(<Settings />)

    const activeItem = screen.getByRole('button', { name: 'General' })
    // Selection is a rounded ground inside the rail, not a full-bleed band:
    // the rail is padded, so a square highlight would touch the divider.
    expect(activeItem.className).toContain('rounded-[var(--radius-md)]')
    expect(activeItem.className).toContain('bg-[var(--color-surface-hover)]')
    expect(activeItem).toHaveAttribute('aria-current', 'page')

    const rail = activeItem.parentElement?.parentElement
    expect(rail?.className).toContain('w-[195px]')
    expect(rail?.className).toContain('pl-3')
    expect(rail?.className).toContain('pr-1')
    expect(activeItem.className).toContain('pl-3')
    expect(activeItem.className).toContain('pr-2')
  })

  it('marks the pure white appearance theme as selected', () => {
    useUIStore.setState({ theme: 'white' })
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    expect(screen.getByRole('button', { name: 'Pure White' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Warm Classic' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('offers a switch for following the system appearance', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    const followSwitch = screen.getByRole('switch', { name: 'Follow the system' })
    expect(followSwitch).not.toBeChecked()

    fireEvent.click(followSwitch)

    expect(useUIStore.getState().followSystemTheme).toBe(true)
  })

  it('splits the picker into one row per ground while following the system', () => {
    // The OS picks the ground; what is left to choose is the palette on each
    // one, so both rows are offered rather than only the light half.
    useUIStore.setState({ followSystemTheme: true, lightTheme: 'celadon', darkTheme: 'ink-blue', theme: 'ink-blue' })
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    expect(screen.getByText('Use in light mode')).toBeInTheDocument()
    expect(screen.getByText('Use in dark mode')).toBeInTheDocument()
    for (const label of ['Pure White', 'Paper', 'Warm Classic', 'Celadon', 'Ink Night', 'Ink Blue']) {
      expect(screen.getByRole('button', { name: label }), label).toBeInTheDocument()
    }
  })

  it('marks each ground preference rather than the applied palette', () => {
    // Evening: the app is on ink-blue, but the light row is asking which
    // palette to return to in the morning — that is warm classic, not ink-blue.
    useUIStore.setState({ followSystemTheme: true, lightTheme: 'warm-classic', darkTheme: 'ink-blue', theme: 'ink-blue' })
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    expect(screen.getByRole('button', { name: 'Warm Classic' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Ink Blue' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Pure White' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Ink Night' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('hides the light-half hint when not following the system', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    expect(screen.queryByText('Use in light mode')).not.toBeInTheDocument()
  })

  it('highlights the theme on screen after the OS flipped it and the switch is released', () => {
    // Going through the real transition, not a hand-set state: the OS turned
    // dark during the session, then the user releases the switch to freeze it.
    // The picker must point at the palette that is actually rendered.
    useUIStore.setState({
      followSystemTheme: true,
      lightTheme: 'white',
      darkTheme: 'ink-blue',
      theme: 'white',
    })
    render(<Settings />)
    fireEvent.click(screen.getByText('General'))

    act(() => {
      // Stand in for the OS flip the media-query listener would deliver.
      useUIStore.setState({ theme: 'ink-blue' })
    })
    act(() => {
      useUIStore.getState().setFollowSystemTheme(false)
    })

    expect(screen.getByRole('button', { name: 'Ink Blue' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Pure White' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('keeps UI zoom below system notifications because it is a secondary setting', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    const notificationsHeading = screen.getByRole('heading', { name: 'System Notifications' })
    const uiZoomHeading = screen.getByRole('heading', { name: 'UI Zoom' })
    const networkHeading = screen.getByRole('heading', { name: 'Network' })
    const webFetchHeading = screen.getByRole('heading', { name: 'WebFetch Preflight' })

    expect((notificationsHeading.compareDocumentPosition(uiZoomHeading) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
    expect((uiZoomHeading.compareDocumentPosition(networkHeading) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
    expect((networkHeading.compareDocumentPosition(webFetchHeading) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
  })

  it('lets users choose Ctrl or Command Enter as the chat send shortcut', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    fireEvent.click(screen.getByRole('button', { name: /Ctrl\/Cmd\+Enter sends/i }))

    await waitFor(() => {
      expect(useSettingsStore.getState().setChatSendBehavior).toHaveBeenCalledWith('modifierEnter')
    })
    expect(screen.getByRole('button', { name: /Ctrl\/Cmd\+Enter sends/i })).toHaveAttribute('aria-pressed', 'true')
  })

  it('saves provider network timeout and manual proxy from General settings', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    expect(screen.getByRole('button', { name: /Direct connection/i })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /System proxy/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Manual proxy/i }))
    const proxyInput = screen.getByLabelText('Proxy URL')
    const saveButton = screen.getAllByRole('button', { name: 'Save' })[0]!

    expect(screen.getByText('Enter a proxy URL.')).toBeInTheDocument()
    expect(saveButton).toBeDisabled()

    fireEvent.change(proxyInput, { target: { value: 'socks5://127.0.0.1:7890' } })
    expect(screen.getByText('Enter an HTTP or HTTPS proxy URL.')).toBeInTheDocument()
    expect(saveButton).toBeDisabled()

    fireEvent.change(proxyInput, { target: { value: '  http://user:p%40ss@127.0.0.1:7890  ' } })
    expect(screen.getByText('HTTP and HTTPS proxy URLs are supported. For authenticated proxies, use http://user:password@127.0.0.1:7890; the URL is saved with network settings.')).toBeInTheDocument()
    const timeoutInput = screen.getByLabelText('AI request timeout')
    expect(timeoutInput).toHaveAttribute('type', 'number')
    expect(screen.queryByRole('slider', { name: 'AI request timeout' })).not.toBeInTheDocument()

    fireEvent.change(timeoutInput, { target: { value: '180' } })

    await act(async () => {
      fireEvent.click(saveButton)
    })

    expect(useSettingsStore.getState().setNetwork).toHaveBeenCalledWith({
      aiRequestTimeoutMs: 180_000,
      proxy: {
        mode: 'manual',
        url: 'http://user:p%40ss@127.0.0.1:7890',
      },
    })
    expect(useUIStore.getState().toasts[useUIStore.getState().toasts.length - 1]).toMatchObject({
      type: 'success',
      message: 'Network settings saved.',
    })
  })

  it('validates typed provider network timeout and supports precise step controls', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    const timeoutInput = screen.getByLabelText('AI request timeout')
    const saveButton = screen.getAllByRole('button', { name: 'Save' })[0]!

    fireEvent.change(timeoutInput, { target: { value: '2000' } })
    expect(screen.getByText('Enter a whole number from 30 to 1800 seconds.')).toBeInTheDocument()
    expect(saveButton).toBeDisabled()

    fireEvent.change(timeoutInput, { target: { value: '90' } })
    fireEvent.click(screen.getByRole('button', { name: 'Increase by 30 seconds' }))
    expect(timeoutInput).toHaveValue(120)

    fireEvent.click(screen.getByRole('button', { name: 'Decrease by 30 seconds' }))
    fireEvent.click(screen.getByRole('button', { name: 'Decrease by 30 seconds' }))
    expect(timeoutInput).toHaveValue(60)
    expect(saveButton).not.toBeDisabled()
  })

  it('keeps data storage at the bottom of General settings', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    const webSearchHeading = screen.getByRole('heading', { name: 'WebSearch' })
    const storageHeading = screen.getByRole('heading', { name: 'Data Storage Location' })

    expect((webSearchHeading.compareDocumentPosition(storageHeading) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
    expect(screen.getByText(/Windows, upgrades recover verified legacy app-adjacent data/)).toBeInTheDocument()
  })

  it('lets desktop users choose a custom data directory and relaunch immediately', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose Folder' }))

    await waitFor(() => {
      expect(screen.getByLabelText('Custom data directory')).toHaveValue('/Users/test/cc-haha-data')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Use This Folder and Restart' }))
    expect(screen.getByText('Switch data storage location?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save and Restart' }))

    await waitFor(() => {
      expect(useSettingsStore.getState().setAppMode).toHaveBeenCalledWith('portable', '/Users/test/cc-haha-data')
      expect(tauriCoreMock.invoke).toHaveBeenCalledWith('prepare_for_app_mode_restart')
      expect(tauriProcessMock.relaunch).toHaveBeenCalledTimes(1)
    })
  })

  it('switches back to ~/.claude without deleting custom data', async () => {
    useSettingsStore.setState({
      appMode: {
        mode: 'portable',
        portableDir: '/Users/test/cc-haha-data',
        activeConfigDir: '/Users/test/cc-haha-data',
        configDirSource: 'portable',
      },
    })

    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    fireEvent.click(screen.getByRole('button', { name: /Use system directory/ }))

    expect(screen.getByText(/Data in the custom directory is not deleted/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save and Restart' }))

    await waitFor(() => {
      expect(useSettingsStore.getState().setAppMode).toHaveBeenCalledWith('default', null)
      expect(tauriCoreMock.invoke).toHaveBeenCalledWith('prepare_for_app_mode_restart')
      expect(tauriProcessMock.relaunch).toHaveBeenCalledTimes(1)
    })
  })

  it('requires an explicit custom directory and exposes no third default-custom choice', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    const input = screen.getByLabelText('Custom data directory')

    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use This Folder and Restart' }))
    expect(screen.getByText('Choose or enter a custom data directory first.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /default.*data folder/i })).not.toBeInTheDocument()

    fireEvent.change(input, { target: { value: '/Users/test/custom-data' } })
    expect(input).toHaveValue('/Users/test/custom-data')
    expect(screen.queryByText('Choose or enter a custom data directory first.')).not.toBeInTheDocument()
  })

  it('shows folder picker failures as an inline storage error', async () => {
    tauriDialogMock.open.mockRejectedValueOnce(new Error('dialog unavailable'))

    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose Folder' }))

    expect(await screen.findByText('Could not open the folder picker. Paste the folder path manually.')).toBeInTheDocument()
  })

  it('treats external CLAUDE_CONFIG_DIR as the controlling data source', async () => {
    useSettingsStore.setState({
      appMode: {
        mode: 'portable',
        portableDir: '/env/claude-data',
        activeConfigDir: '/env/claude-data',
        configDirSource: 'environment',
      },
    })

    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    expect(screen.getByText(/The current directory is controlled by the CLAUDE_CONFIG_DIR environment variable/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Use system directory/ }))
    expect(screen.getByText(/Remove it from the launch environment before switching back/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Custom data directory'), { target: { value: '/other/data' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use This Folder and Restart' }))
    expect(screen.queryByText('Switch data storage location?')).not.toBeInTheDocument()
    expect(screen.getByText(/Remove it from the launch environment before switching back/)).toBeInTheDocument()
  })

  it('keeps mode switch confirmation cancelable before restart starts', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    fireEvent.change(screen.getByLabelText('Custom data directory'), { target: { value: '/Users/test/custom-data' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use This Folder and Restart' }))
    expect(screen.getByText('Switch data storage location?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => {
      expect(screen.queryByText('Switch data storage location?')).not.toBeInTheDocument()
    })
    expect(useSettingsStore.getState().setAppMode).not.toHaveBeenCalled()
  })

  it('shows restart preparation failures without relaunching', async () => {
    tauriCoreMock.invoke.mockRejectedValueOnce(new Error('restart preparation failed'))

    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    fireEvent.change(screen.getByLabelText('Custom data directory'), { target: { value: '/Users/test/custom-data' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use This Folder and Restart' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save and Restart' }))

    expect(await screen.findByText('restart preparation failed')).toBeInTheDocument()
    expect(tauriProcessMock.relaunch).not.toHaveBeenCalled()
  })

  it('shows the saved restart-required state inside the storage section', () => {
    useSettingsStore.setState({ appModeRequiresRestart: true })

    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    expect(screen.getByText('The storage change has been saved. Restart the app for the new data directory to take effect.')).toBeInTheDocument()
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

  it('opens the Trace tab from Settings navigation between Token usage and Diagnostics', () => {
    render(<Settings />)

    const usageTab = screen.getByText('Token usage')
    const traceTab = screen.getByText('Trace')
    const diagnosticsTab = screen.getByText('Diagnostics')
    expect((usageTab.compareDocumentPosition(traceTab) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
    expect((traceTab.compareDocumentPosition(diagnosticsTab) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)

    fireEvent.click(traceTab)

    expect(screen.getByText('Trace List Mock')).toBeInTheDocument()
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

  it('sets the new-session effort through the current model capability profile', async () => {
    useSettingsStore.setState({
      currentModel: {
        id: 'claude-sonnet-4-6',
        name: 'Sonnet 4.6',
        description: 'Balanced Claude model',
        context: '1m',
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: ['low', 'medium', 'high'],
      },
      // A default from another provider must not create a stop that this
      // model cannot actually use. The visible value falls back to the
      // model default until the user selects a supported level.
      effortLevel: 'max',
    })

    render(<Settings />)
    fireEvent.click(screen.getByText('General'))

    const trigger = screen.getByRole('button', { name: 'Default reasoning effort: Medium' })
    fireEvent.click(trigger)

    const slider = screen.getByRole('slider', { name: 'Default reasoning effort' })
    expect(slider).toHaveAttribute('aria-valuemax', '2')
    expect(slider).toHaveAttribute('aria-valuenow', '1')
    expect(screen.getAllByTestId('reasoning-effort-stop')).toHaveLength(3)

    fireEvent.keyDown(slider, { key: 'ArrowRight' })

    await waitFor(() => {
      expect(useSettingsStore.getState().setEffort).toHaveBeenCalledWith('high')
    })
    expect(useSettingsStore.getState().effortLevel).toBe('high')
  })

  it('lets the user disable and restore the Ultracode keyword trigger', async () => {
    const updateUser = vi.spyOn(settingsApi, 'updateUser').mockResolvedValue({ ok: true })

    try {
      render(<Settings />)

      fireEvent.click(screen.getByText('General'))

      const toggle = screen.getByRole('switch', { name: 'Enable Ultracode keyword trigger' })
      expect(toggle).toBeChecked()

      await act(async () => {
        fireEvent.click(toggle)
      })
      expect(toggle).not.toBeChecked()
      expect(updateUser).toHaveBeenLastCalledWith({ workflowKeywordTriggerEnabled: false })

      await act(async () => {
        fireEvent.click(toggle)
      })
      expect(toggle).toBeChecked()
      expect(updateUser).toHaveBeenLastCalledWith({ workflowKeywordTriggerEnabled: true })
    } finally {
      updateUser.mockRestore()
    }
  })

  it('lets the user choose a default permission mode for new sessions', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    await act(async () => {
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Ask permissions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Bypass permissions/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enable bypass' }))
      await Promise.resolve()
    })

    expect(useSettingsStore.getState().setPermissionMode).toHaveBeenCalledWith('bypassPermissions')
    expect(useSettingsStore.getState().permissionMode).toBe('bypassPermissions')
  })

  it('confirms first use before saving Auto as the new-session default', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    await act(async () => {
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Ask permissions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Auto mode/ }))

    expect(useSettingsStore.getState().setPermissionMode).not.toHaveBeenCalledWith('auto')
    const dialog = screen.getByRole('dialog', { name: 'Enable Auto mode?' })

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Enable Auto mode' }))
    })

    expect(useSettingsStore.getState().acceptAutoModeOptIn).toHaveBeenCalledOnce()
    expect(useSettingsStore.getState().setPermissionMode).toHaveBeenCalledWith('auto')
    expect(useSettingsStore.getState().permissionMode).toBe('auto')
  })

  it('keeps Auto-dream disabled by default and confirms before enabling it', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    const toggle = screen.getByLabelText('Enable Auto-dream')
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)

    expect(useSettingsStore.getState().setAutoDreamEnabled).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog', { name: 'Enable Auto-dream?' })
    expect(within(dialog).getByText(/Keep the desktop app running/i)).toBeInTheDocument()
    expect(within(dialog).getByText(/uses additional model tokens/i)).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Enable Auto-dream' }))
    })

    expect(useSettingsStore.getState().setAutoDreamEnabled).toHaveBeenCalledWith(true)
    expect(screen.getByLabelText('Enable Auto-dream')).toBeChecked()
  })

  it('lets the user disable Auto-dream without a confirmation dialog', async () => {
    useSettingsStore.setState({ autoDreamEnabled: true })
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Enable Auto-dream'))
    })

    expect(screen.queryByRole('dialog', { name: 'Enable Auto-dream?' })).not.toBeInTheDocument()
    expect(useSettingsStore.getState().setAutoDreamEnabled).toHaveBeenCalledWith(false)
  })

  it('keeps General checkbox inputs anchored inside their visible rows', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    for (const label of [
      'Enable thinking mode',
      'Enable Auto-dream',
      'Collect agent traces',
      'Enable system notifications',
      'Skip WebFetch domain preflight',
    ]) {
      const toggle = screen.getByLabelText(label)
      const row = toggle.closest('label') as HTMLElement | null
      expect(toggle).toHaveClass('settings-checkbox-input')
      expect(toggle).not.toHaveClass('sr-only')
      expect(row).not.toBeNull()
      expect(row!).toHaveClass('relative')
    }
  })

  it('lets the user disable Agent Trace collection without leaving General settings', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    expect(screen.getByLabelText('Collect agent traces')).toBeChecked()

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Collect agent traces'))
    })

    expect(useSettingsStore.getState().setTraceCaptureEnabled).toHaveBeenCalledWith(false)
    expect(screen.getByLabelText('Collect agent traces')).not.toBeChecked()
    expect(screen.getByText('Agent trace')).toBeInTheDocument()
    expect(screen.getByText('Message Sending')).toBeInTheDocument()
  })

  it('uses the shared dropdown for response language', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    expect(screen.queryByRole('combobox', { name: 'Response Language' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Response Language' })).not.toBeInTheDocument()

    const trigger = screen.getByRole('button', { name: 'Response Language' })
    expect(trigger).toHaveTextContent('Default (English)')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('option', { name: '中文 (Chinese)' }))

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

  it('does not fire the enable smoke notification on Windows Electron', async () => {
    useSettingsStore.setState({ desktopNotificationsEnabled: false })
    desktopNotificationsMock.getDesktopNotificationPlatform.mockReturnValue('win32')
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Enable system notifications'))
    })

    expect(useSettingsStore.getState().setDesktopNotificationsEnabled).toHaveBeenCalledWith(true)
    await vi.waitFor(() => {
      expect(desktopNotificationsMock.requestDesktopNotificationPermission).toHaveBeenCalledTimes(1)
    })
    expect(desktopNotificationsMock.notifyDesktop).not.toHaveBeenCalled()
    expect(desktopNotificationsMock.openDesktopNotificationSettings).not.toHaveBeenCalled()
  })

  it('shows the system settings action when enabling notifications finds system denial', async () => {
    useSettingsStore.setState({ desktopNotificationsEnabled: false })
    desktopNotificationsMock.requestDesktopNotificationPermission.mockResolvedValue('denied')
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Enable system notifications'))
    })

    await vi.waitFor(() => {
      expect(screen.getByText('Permission: Blocked by system settings')).toBeInTheDocument()
    })
    expect(desktopNotificationsMock.openDesktopNotificationSettings).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }))
    })

    expect(desktopNotificationsMock.openDesktopNotificationSettings).toHaveBeenCalledTimes(1)
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
        token: null,
        tokenPreview: null,
        allowedOrigins: [],
        publicBaseUrl: 'http://192.168.0.102:3456',
        fixedPort: null,
        disconnectGraceSeconds: null,
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
        token: null,
        tokenPreview: null,
        allowedOrigins: [],
        publicBaseUrl: 'http://192.168.0.102:3456',
        fixedPort: null,
        disconnectGraceSeconds: null,
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
        token: null,
        tokenPreview: 'h5oldtok',
        allowedOrigins: [],
        publicBaseUrl: 'http://192.168.0.102:3456',
        fixedPort: null,
        disconnectGraceSeconds: null,
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

  it('renders the QR code and token from persisted settings without any action (issue #767)', async () => {
    useSettingsStore.setState({
      h5Access: {
        enabled: true,
        token: 'h5_persisted_token',
        tokenPreview: 'h5_pers...oken',
        allowedOrigins: [],
        publicBaseUrl: 'http://192.168.0.102:3456',
        fixedPort: null,
        disconnectGraceSeconds: null,
      },
    })
    render(<Settings />)

    fireEvent.click(screen.getByText('H5 Access'))
    const section = screen.getByRole('region', { name: 'H5 Access' })

    // No enable/regenerate click this session: everything comes from the
    // persisted token, so a desktop restart no longer loses the QR code.
    expect(await within(section).findByAltText('H5 access QR code')).toBeInTheDocument()
    expect(within(section).getByText('http://192.168.0.102:3456/?serverUrl=http%3A%2F%2F192.168.0.102%3A3456&h5Token=h5_persisted_token')).toBeInTheDocument()

    fireEvent.click(within(section).getByRole('button', { name: 'Show token' }))
    expect(within(section).getByText('h5_persisted_token')).toBeInTheDocument()
  })

  it('saves a fixed port together with the host', async () => {
    useSettingsStore.setState({
      h5Access: {
        enabled: true,
        token: 'h5_persisted_token',
        tokenPreview: 'h5_pers...oken',
        allowedOrigins: [],
        publicBaseUrl: 'http://192.168.0.102:54064',
        fixedPort: null,
        disconnectGraceSeconds: null,
      },
    })
    render(<Settings />)

    fireEvent.click(screen.getByText('H5 Access'))
    const section = screen.getByRole('region', { name: 'H5 Access' })
    fireEvent.change(within(section).getByLabelText('Fixed port'), {
      target: { value: '28670' },
    })

    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Save H5 settings' }))
    })

    expect(useSettingsStore.getState().updateH5AccessSettings).toHaveBeenCalledWith({
      publicBaseUrl: 'http://192.168.0.102:54064',
      fixedPort: 28670,
      disconnectGraceSeconds: null,
    })
  })

  it('rejects an out-of-range fixed port before saving', () => {
    useSettingsStore.setState({
      h5Access: {
        enabled: true,
        token: 'h5_persisted_token',
        tokenPreview: 'h5_pers...oken',
        allowedOrigins: [],
        publicBaseUrl: 'http://192.168.0.102:54064',
        fixedPort: null,
        disconnectGraceSeconds: null,
      },
    })
    render(<Settings />)

    fireEvent.click(screen.getByText('H5 Access'))
    const section = screen.getByRole('region', { name: 'H5 Access' })
    fireEvent.change(within(section).getByLabelText('Fixed port'), {
      target: { value: '99' },
    })

    expect(within(section).getByText('Port must be a browser-safe integer between 1024 and 65535.')).toBeInTheDocument()
    expect(within(section).getByRole('button', { name: 'Save H5 settings' })).toBeDisabled()
    expect(useSettingsStore.getState().updateH5AccessSettings).not.toHaveBeenCalled()
  })

  it('rejects a browser-blocked fixed port before saving', () => {
    useSettingsStore.setState({
      h5Access: {
        enabled: true,
        token: 'h5_persisted_token',
        tokenPreview: 'h5_pers...oken',
        allowedOrigins: [],
        publicBaseUrl: 'http://192.168.0.102:54064',
        fixedPort: null,
        disconnectGraceSeconds: null,
      },
    })
    render(<Settings />)

    fireEvent.click(screen.getByText('H5 Access'))
    const section = screen.getByRole('region', { name: 'H5 Access' })
    fireEvent.change(within(section).getByLabelText('Fixed port'), {
      target: { value: '5061' },
    })

    expect(within(section).getByRole('button', { name: 'Save H5 settings' })).toBeDisabled()
    expect(useSettingsStore.getState().updateH5AccessSettings).not.toHaveBeenCalled()
  })

  it('saves a custom disconnect grace period (issue #764)', async () => {
    useSettingsStore.setState({
      h5Access: {
        enabled: true,
        token: 'h5_persisted_token',
        tokenPreview: 'h5_pers...oken',
        allowedOrigins: [],
        publicBaseUrl: 'http://192.168.0.102:54064',
        fixedPort: null,
        disconnectGraceSeconds: null,
      },
    })
    render(<Settings />)

    fireEvent.click(screen.getByText('H5 Access'))
    const section = screen.getByRole('region', { name: 'H5 Access' })
    fireEvent.change(within(section).getByLabelText('Disconnect grace (sec)'), {
      target: { value: '600' },
    })

    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Save H5 settings' }))
    })

    expect(useSettingsStore.getState().updateH5AccessSettings).toHaveBeenCalledWith({
      publicBaseUrl: 'http://192.168.0.102:54064',
      fixedPort: null,
      disconnectGraceSeconds: 600,
    })
  })

  it('rejects an out-of-range disconnect grace period before saving', () => {
    useSettingsStore.setState({
      h5Access: {
        enabled: true,
        token: 'h5_persisted_token',
        tokenPreview: 'h5_pers...oken',
        allowedOrigins: [],
        publicBaseUrl: 'http://192.168.0.102:54064',
        fixedPort: null,
        disconnectGraceSeconds: null,
      },
    })
    render(<Settings />)

    fireEvent.click(screen.getByText('H5 Access'))
    const section = screen.getByRole('region', { name: 'H5 Access' })
    fireEvent.change(within(section).getByLabelText('Disconnect grace (sec)'), {
      target: { value: '2' },
    })

    expect(within(section).getByText('Must be an integer between 5 and 86400 seconds.')).toBeInTheDocument()
    expect(within(section).getByRole('button', { name: 'Save H5 settings' })).toBeDisabled()
    expect(useSettingsStore.getState().updateH5AccessSettings).not.toHaveBeenCalled()
  })

  it('shows a restart note while the saved fixed port is not active yet', () => {
    useSettingsStore.setState({
      h5Access: {
        enabled: true,
        token: 'h5_persisted_token',
        tokenPreview: 'h5_pers...oken',
        allowedOrigins: [],
        publicBaseUrl: 'http://192.168.0.102:54064',
        fixedPort: 28670,
        disconnectGraceSeconds: null,
      },
      h5AccessDiagnostics: {
        storedHostStaleness: 'ok',
        storedPublicBaseUrl: 'http://192.168.0.102:54064',
        effectivePublicBaseUrl: 'http://192.168.0.102:54064',
        suggestedHost: null,
        localInterfaceHosts: ['192.168.0.102'],
        activePort: 54064,
      },
    })
    render(<Settings />)

    fireEvent.click(screen.getByText('H5 Access'))
    const section = screen.getByRole('region', { name: 'H5 Access' })

    const note = within(section).getByTestId('h5-access-fixed-port-restart-note')
    expect(note.textContent).toContain('28670')
    expect(note.textContent).toContain('54064')
  })

  it('shows the generated H5 token as a fallback when requested', async () => {
    useSettingsStore.setState({
      h5Access: {
        enabled: false,
        token: null,
        tokenPreview: null,
        allowedOrigins: [],
        publicBaseUrl: 'http://192.168.0.102:3456',
        fixedPort: null,
        disconnectGraceSeconds: null,
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
        token: null,
        tokenPreview: 'h5url123',
        allowedOrigins: ['https://phone.example'],
        publicBaseUrl: 'https://phone.example/app',
        fixedPort: null,
        disconnectGraceSeconds: null,
      },
    })
    render(<Settings />)

    fireEvent.click(screen.getByText('H5 Access'))
    const section = screen.getByRole('region', { name: 'H5 Access' })

    expect(within(section).getByLabelText('Access host / IP')).toHaveValue('https://phone.example/app')
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

  it('updates H5 host by reusing the current service port', async () => {
    useSettingsStore.setState({
      h5Access: {
        enabled: true,
        token: null,
        tokenPreview: 'h5a1b2c3',
        allowedOrigins: [],
        publicBaseUrl: 'http://172.20.16.1:54064',
        fixedPort: null,
        disconnectGraceSeconds: null,
      },
    })
    render(<Settings />)

    fireEvent.click(screen.getByText('H5 Access'))

    const section = screen.getByRole('region', { name: 'H5 Access' })
    expect(within(section).getByLabelText('Current port')).toHaveValue('54064')
    fireEvent.change(within(section).getByLabelText('Access host / IP'), {
      target: { value: '192.168.1.100' },
    })

    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Save H5 settings' }))
    })

    expect(useSettingsStore.getState().updateH5AccessSettings).toHaveBeenCalledWith({
      publicBaseUrl: 'http://192.168.1.100:54064',
      fixedPort: null,
      disconnectGraceSeconds: null,
    })
  })

  it('still accepts a full H5 public URL for reverse proxy setups', async () => {
    useSettingsStore.setState({
      h5Access: {
        enabled: false,
        token: null,
        tokenPreview: 'h5a1b2c3',
        allowedOrigins: ['https://old.example'],
        publicBaseUrl: null,
        fixedPort: null,
        disconnectGraceSeconds: null,
      },
    })
    render(<Settings />)

    fireEvent.click(screen.getByText('H5 Access'))

    const section = screen.getByRole('region', { name: 'H5 Access' })
    fireEvent.change(within(section).getByLabelText('Access host / IP'), {
      target: { value: 'https://phone.example/app' },
    })

    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Save H5 settings' }))
    })

    expect(useSettingsStore.getState().updateH5AccessSettings).toHaveBeenCalledWith({
      publicBaseUrl: 'https://phone.example/app',
      fixedPort: null,
      disconnectGraceSeconds: null,
    })
  })

  it('shows the stale-host banner and a one-click switch when the saved H5 host is unreachable', async () => {
    useSettingsStore.setState({
      h5Access: {
        enabled: true,
        token: null,
        tokenPreview: 'h5a1b2c3',
        allowedOrigins: [],
        publicBaseUrl: 'http://192.168.1.207:55379',
        fixedPort: null,
        disconnectGraceSeconds: null,
      },
      h5AccessDiagnostics: {
        storedHostStaleness: 'unreachable',
        storedPublicBaseUrl: 'http://192.168.1.207:55379',
        effectivePublicBaseUrl: 'http://192.168.0.105:55379',
        suggestedHost: '192.168.0.105',
        localInterfaceHosts: ['192.168.0.105'],
      },
    })
    render(<Settings />)
    fireEvent.click(screen.getByText('H5 Access'))

    const section = screen.getByRole('region', { name: 'H5 Access' })
    const banner = within(section).getByTestId('h5-access-stale-host-banner')
    expect(banner).toBeInTheDocument()
    expect(banner.textContent).toContain('192.168.1.207')
    expect(within(section).queryByTestId('h5-access-proxy-note')).toBeNull()

    await act(async () => {
      fireEvent.click(within(section).getByTestId('h5-access-stale-host-apply'))
    })

    expect(useSettingsStore.getState().updateH5AccessSettings).toHaveBeenCalledWith({
      publicBaseUrl: 'http://192.168.0.105:55379',
    })
  })

  it('shows the proxy note when the saved H5 URL is a reverse proxy', () => {
    useSettingsStore.setState({
      h5Access: {
        enabled: true,
        token: null,
        tokenPreview: 'h5a1b2c3',
        allowedOrigins: [],
        publicBaseUrl: 'https://h5.mydomain.com',
        fixedPort: null,
        disconnectGraceSeconds: null,
      },
      h5AccessDiagnostics: {
        storedHostStaleness: 'proxy',
        storedPublicBaseUrl: 'https://h5.mydomain.com',
        effectivePublicBaseUrl: 'https://h5.mydomain.com',
        suggestedHost: '192.168.0.105',
        localInterfaceHosts: ['192.168.0.105'],
      },
    })
    render(<Settings />)
    fireEvent.click(screen.getByText('H5 Access'))

    const section = screen.getByRole('region', { name: 'H5 Access' })
    expect(within(section).getByTestId('h5-access-proxy-note')).toBeInTheDocument()
    expect(within(section).queryByTestId('h5-access-stale-host-banner')).toBeNull()
  })

  it('shows the friendly backend reason when saving an H5 host that is not on any local interface', async () => {
    useSettingsStore.setState({
      h5Access: {
        enabled: true,
        token: null,
        tokenPreview: 'h5a1b2c3',
        allowedOrigins: [],
        publicBaseUrl: 'http://192.168.0.105:55379',
        fixedPort: null,
        disconnectGraceSeconds: null,
      },
      h5AccessDiagnostics: {
        storedHostStaleness: 'ok',
        storedPublicBaseUrl: 'http://192.168.0.105:55379',
        effectivePublicBaseUrl: 'http://192.168.0.105:55379',
        suggestedHost: '192.168.0.105',
        localInterfaceHosts: ['192.168.0.105'],
      },
      updateH5AccessSettings: vi.fn().mockImplementation(async () => {
        useSettingsStore.setState({
          h5AccessError: 'H5 host 10.255.255.254 is not bound to any local network interface on this machine. Available LAN IPv4: 192.168.0.105',
        })
        throw new Error('rejected')
      }),
    })
    render(<Settings />)
    fireEvent.click(screen.getByText('H5 Access'))

    const section = screen.getByRole('region', { name: 'H5 Access' })
    fireEvent.change(within(section).getByLabelText('Access host / IP'), {
      target: { value: '10.255.255.254' },
    })
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Save H5 settings' }))
    })

    expect(within(section).getByText(/10\.255\.255\.254/)).toBeInTheDocument()
  })

  it('saves WebSearch fallback provider settings', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    fireEvent.click(screen.getByRole('button', { name: 'Tavily' }))
    fireEvent.change(screen.getByLabelText('Tavily API key'), {
      target: { value: 'tvly-test-key' },
    })
    const saveButtons = screen.getAllByRole('button', { name: 'Save' })
    fireEvent.click(saveButtons[saveButtons.length - 1]!)

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

  it('warns when the user settings contain only a proxy-managed placeholder', async () => {
    useSettingsStore.setState({ proxyManagedSettingsWarning: true })

    render(<Settings />)
    fireEvent.click(screen.getByRole('button', { name: 'General' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your user settings contain only a PROXY_MANAGED proxy placeholder',
    )
  })
})

describe('Settings > Providers tab', () => {
  beforeEach(() => {
    MOCK_DELETE_PROVIDER.mockReset()
    MOCK_GET_SETTINGS.mockResolvedValue({})
    MOCK_UPDATE_SETTINGS.mockResolvedValue({})
    useUIStore.setState({ activeSettingsTab: 'providers', pendingSettingsTab: null, toasts: [] })
    useSettingsStore.setState({
      locale: 'en',
      fetchAll: vi.fn().mockResolvedValue(undefined),
    })
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
    providerStoreState.providerOrder = ['provider-1', 'claude-official', 'openai-official', 'grok-official']
    providerStoreState.activeId = null
    providerStoreState.hasLoadedProviders = true
  })

  it('outlines the default provider in terracotta rather than the focus color', () => {
    providerStoreState.activeId = 'provider-1'
    render(<Settings />)

    const card = screen.getByTestId('provider-provider-1')
    // 1.5px so the default row reads as chosen at a glance without the heavier
    // ring the focus border gave it, which collided with the real focus ring.
    expect(card.className).toContain('border-[1.5px]')
    expect(card.className).toContain('border-[var(--color-primary-fixed-dim)]')
    expect(card.className).not.toContain('border-[var(--color-border-focus)]')
  })

  it('does not query official OAuth status before providers finish loading', () => {
    providerStoreState.providers = []
    providerStoreState.activeId = null
    providerStoreState.hasLoadedProviders = false

    render(<Settings />)

    expect(screen.queryByTestId('claude-official-login')).not.toBeInTheDocument()
  })

  it('does not query ChatGPT OAuth status before providers finish loading', () => {
    providerStoreState.providers = []
    providerStoreState.activeId = 'openai-official'
    providerStoreState.hasLoadedProviders = false

    render(<Settings />)

    expect(screen.queryByTestId('chatgpt-official-login')).not.toBeInTheDocument()
  })

  it('shows official OAuth status only after official provider is confirmed active', () => {
    providerStoreState.providers = []
    providerStoreState.activeId = null
    providerStoreState.hasLoadedProviders = true

    render(<Settings />)

    expect(screen.getByTestId('claude-official-login')).toBeInTheDocument()
  })

  it('shows ChatGPT Official as the active built-in provider', () => {
    providerStoreState.providers = []
    providerStoreState.activeId = 'openai-official'
    providerStoreState.hasLoadedProviders = true

    render(<Settings />)

    const openAIProvider = screen.getByTestId('openai-official-provider')
    expect(within(openAIProvider).getByText('ChatGPT Official')).toBeInTheDocument()
    expect(within(openAIProvider).getByText('Default')).toBeInTheDocument()
    expect(screen.getByTestId('chatgpt-official-login')).toBeInTheDocument()
    expect(screen.queryByTestId('claude-official-login')).not.toBeInTheDocument()
  })

  it('shows Grok Official as the active built-in provider', () => {
    providerStoreState.providers = []
    providerStoreState.activeId = 'grok-official'

    render(<Settings />)

    const provider = screen.getByTestId('grok-official-provider')
    expect(within(provider).getByText('Grok Official')).toBeInTheDocument()
    expect(within(provider).getByText('Default')).toBeInTheDocument()
    expect(screen.getByTestId('grok-official-login')).toBeInTheDocument()
  })

  it('renders saved and official providers in the stored sortable order', () => {
    providerStoreState.providerOrder = ['provider-1', 'openai-official', 'claude-official']

    render(<Settings />)

    const rows = screen.getAllByRole('button', { name: 'Drag to reorder' })
      .map((handle) => handle.closest('[data-testid]')?.getAttribute('data-testid'))
    expect(rows).toEqual([
      'provider-provider-1',
      'openai-official-provider',
      'claude-official-provider',
      'grok-official-provider',
    ])
  })

  it('falls back to the default provider order when stored order is missing', () => {
    providerStoreState.providerOrder = undefined as unknown as string[]

    render(<Settings />)

    const rows = screen.getAllByRole('button', { name: 'Drag to reorder' })
      .map((handle) => handle.closest('[data-testid]')?.getAttribute('data-testid'))
    expect(rows).toEqual([
      'provider-provider-1',
      'claude-official-provider',
      'openai-official-provider',
      'grok-official-provider',
    ])
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

  it('keeps custom provider creation available when presets are unavailable', async () => {
    providerStoreState.presets = []

    render(<Settings />)

    const addButton = screen.getByRole('button', { name: /Add Provider/i })
    expect(addButton).toBeEnabled()

    fireEvent.click(addButton)

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText(/Name/i)).toHaveValue('Custom')
    expect(within(dialog).getByRole('textbox', { name: /Base URL/i })).toBeEnabled()

    const baseUrlInfo = within(dialog).getByRole('button', { name: 'Base URL help' })
    fireEvent.mouseEnter(baseUrlInfo)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Enter the endpoint before /v1. The remaining path is added automatically.')
  })

  it.each(['resolves', 'rejects'] as const)(
    'keeps the selected regional endpoint when settings loading %s late',
    async (outcome) => {
      let settleSettings: (() => void) | undefined
      MOCK_GET_SETTINGS.mockImplementationOnce(() => new Promise((resolve, reject) => {
        settleSettings = () => outcome === 'resolves'
          ? resolve({})
          : reject(new Error('settings unavailable'))
      }))
      providerStoreState.presets = [ZHIPU_REGIONAL_PRESET]

      render(<Settings />)
      fireEvent.click(screen.getByRole('button', { name: /Add Provider/i }))

      const dialog = screen.getByRole('dialog')
      await waitFor(() => expect(settleSettings).toBeTypeOf('function'))
      expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument()
      const regionTrigger = within(dialog).getByRole('button', { name: /China mainland/ })
      const baseUrlInput = within(dialog).getByRole('textbox', { name: /Base URL/i })
      expect(baseUrlInput).toHaveValue('https://open.bigmodel.cn/api/anthropic')
      expect(within(dialog).getByRole('button', { name: /Get API Key/i })).toBeInTheDocument()
      expect(within(dialog).getByText('Mainland China promotion')).toBeInTheDocument()

      fireEvent.click(regionTrigger)
      fireEvent.click(within(dialog).getByRole('option', { name: /Global/ }))

      expect(baseUrlInput).toHaveValue('https://api.z.ai/api/anthropic')
      expect(within(dialog).queryByRole('button', { name: /Get API Key/i })).not.toBeInTheDocument()
      expect(within(dialog).queryByText('Mainland China promotion')).not.toBeInTheDocument()
      await act(async () => settleSettings?.())
      await waitFor(() => {
        expect(dialog.querySelector('textarea')?.value).toContain(
          '"ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic"',
        )
      })
    },
  )

  it('preserves pasted regional settings when the initial settings load finishes late', async () => {
    let resolveSettings: (() => void) | undefined
    MOCK_GET_SETTINGS.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSettings = () => resolve({ fromDisk: true })
    }))
    providerStoreState.presets = [ZHIPU_REGIONAL_PRESET]

    render(<Settings />)
    fireEvent.click(screen.getByRole('button', { name: /Add Provider/i }))

    const dialog = screen.getByRole('dialog')
    await waitFor(() => expect(resolveSettings).toBeTypeOf('function'))
    const settingsTextarea = dialog.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(settingsTextarea, {
      target: {
        value: JSON.stringify({
          customSetting: 'keep-me',
          env: {
            ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
            ANTHROPIC_MODEL: 'glm-global',
          },
        }),
      },
    })

    expect(within(dialog).getByRole('button', { name: /Global/ })).toBeInTheDocument()
    expect(within(dialog).getByRole('textbox', { name: /Base URL/i })).toHaveValue('https://api.z.ai/api/anthropic')
    await act(async () => resolveSettings?.())
    await waitFor(() => {
      expect(JSON.parse(settingsTextarea.value)).toMatchObject({
        customSetting: 'keep-me',
        env: {
          ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
          ANTHROPIC_MODEL: 'glm-global',
        },
      })
    })
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
    fireEvent.click(within(dialog).getByRole('option', { name: /OpenAI Responses API \(proxy\)/i }))

    // The panel is closed now; this finds the trigger, which reflects the pick.
    expect(within(dialog).getByRole('button', { name: /OpenAI Responses API \(proxy\)/i })).toBeInTheDocument()
    expect(within(dialog).getByText('Requests will be translated via the local proxy')).toBeInTheDocument()
  })

  it('localizes the main model placeholder in the provider form', () => {
    useSettingsStore.setState({ locale: 'zh' })
    providerStoreState.presets = [
      {
        id: 'custom',
        name: 'Custom',
        baseUrl: 'https://api.example.com/anthropic',
        apiFormat: 'anthropic',
        defaultModels: {
          main: '',
          haiku: '',
          sonnet: '',
          opus: '',
        },
        needsApiKey: true,
        websiteUrl: '',
      },
    ]

    render(<Settings />)

    fireEvent.click(screen.getByRole('button', { name: /添加服务商/i }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByPlaceholderText('例如： deepseek-v4-flash')).toBeInTheDocument()
    expect(within(dialog).getByText('要填写 API Key 才能获取模型列表')).toBeInTheDocument()
    expect(within(dialog).queryByPlaceholderText('e.g. deepseek-v4-flash')).not.toBeInTheDocument()
  })

  it('normalizes blank model mappings to the main model when saving a provider', async () => {
    providerStoreState.createProvider = vi.fn().mockResolvedValue({
      id: 'provider-new',
      presetId: 'custom',
      name: 'Custom',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/anthropic',
      apiFormat: 'anthropic',
      models: {
        main: 'gpt-5.5',
        haiku: 'gpt-5.5',
        sonnet: 'gpt-5.5',
        opus: 'gpt-5.5',
      },
    })
    providerStoreState.presets = [
      {
        id: 'custom',
        name: 'Custom',
        baseUrl: 'https://api.example.com/anthropic',
        apiFormat: 'anthropic',
        defaultModels: {
          main: '',
          haiku: '',
          sonnet: '',
          opus: '',
        },
        needsApiKey: true,
        websiteUrl: '',
      },
    ]

    render(<Settings />)

    fireEvent.click(screen.getByRole('button', { name: /Add Provider|添加服务商/i }))
    const dialog = screen.getByRole('dialog')
    await waitFor(() => {
      const settingsTextarea = dialog.querySelector('textarea')
      expect(settingsTextarea?.value).toContain('"ANTHROPIC_MODEL"')
    })
    fireEvent.change(within(dialog).getByPlaceholderText('sk-...'), { target: { value: 'sk-test' } })
    fireEvent.change(within(dialog).getByLabelText(/Main Model|主模型/i), { target: { value: 'gpt-5.5' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /Save|Add|保存|添加/i }))

    await waitFor(() => {
      expect(providerStoreState.createProvider).toHaveBeenCalledWith(expect.objectContaining({
        models: {
          main: 'gpt-5.5',
          haiku: 'gpt-5.5',
          sonnet: 'gpt-5.5',
          opus: 'gpt-5.5',
        },
      }))
    })
  })

  it('uses request model env instead of cc-switch display model names when testing pasted settings JSON', async () => {
    providerStoreState.testConfig = vi.fn().mockResolvedValue({
      connectivity: {
        success: false,
        latencyMs: 3,
        error: '未配置供应商',
        modelUsed: 'claude-sonnet-4-6',
        httpStatus: 503,
      },
    })
    providerStoreState.presets = [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiFormat: 'anthropic',
        defaultModels: {
          main: 'deepseek-v4-pro',
          haiku: 'deepseek-v4-flash',
          sonnet: 'deepseek-v4-pro',
          opus: 'deepseek-v4-pro',
        },
        needsApiKey: true,
        websiteUrl: '',
      },
      {
        id: 'custom',
        name: 'Custom',
        baseUrl: '',
        apiFormat: 'anthropic',
        defaultModels: {
          main: '',
          haiku: '',
          sonnet: '',
          opus: '',
        },
        needsApiKey: true,
        websiteUrl: '',
      },
    ]

    render(<Settings />)

    fireEvent.click(screen.getByRole('button', { name: /Add Provider|添加服务商/i }))
    const dialog = screen.getByRole('dialog')
    const settingsTextarea = await waitFor(() => {
      const textarea = dialog.querySelector('textarea')
      expect(textarea?.value).toContain('"ANTHROPIC_MODEL"')
      return textarea as HTMLTextAreaElement
    })

    fireEvent.change(settingsTextarea, {
      target: {
        value: JSON.stringify({
          env: {
            ANTHROPIC_API_KEY: 'PROXY_MANAGED',
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
            ANTHROPIC_DEFAULT_FABLE_MODEL: 'Qwen3Coder',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
            ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'Qwen3Coder',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-8',
            ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'Qwen3Coder',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
            ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Qwen3Coder',
          },
        }, null, 2),
      },
    })

    await waitFor(() => {
      expect(within(dialog).getByLabelText(/Main Model|主模型/i)).toHaveValue('claude-sonnet-4-6')
      expect(within(dialog).getByLabelText(/Haiku Model/i)).toHaveValue('claude-haiku-4-5')
      expect(within(dialog).getByLabelText(/Opus Model/i)).toHaveValue('claude-opus-4-8')
    })

    fireEvent.click(within(dialog).getByRole('button', { name: /Test Connection/i }))

    await waitFor(() => {
      expect(providerStoreState.testConfig).toHaveBeenCalledWith(expect.objectContaining({
        baseUrl: 'http://127.0.0.1:15721',
        apiKey: 'PROXY_MANAGED',
        modelId: 'claude-sonnet-4-6',
        authStrategy: 'api_key',
        apiFormat: 'anthropic',
      }))
    })
    expect(providerStoreState.testConfig).not.toHaveBeenCalledWith(expect.objectContaining({
      modelId: 'Qwen3Coder',
    }))
    expect(providerStoreState.testConfig).not.toHaveBeenCalledWith(expect.objectContaining({
      modelId: 'deepseek-v4-pro',
    }))

    fireEvent.click(within(dialog).getByRole('button', { name: /Save|Add|保存|添加/i }))

    await waitFor(() => {
      expect(providerStoreState.createProvider).toHaveBeenCalledWith(expect.objectContaining({
        models: expect.objectContaining({
          fable: 'Qwen3Coder',
          main: 'claude-sonnet-4-6',
          haiku: 'claude-haiku-4-5',
          sonnet: 'claude-sonnet-4-6',
          opus: 'claude-opus-4-8',
        }),
      }))
    })
  })

  it('keeps the provider form locked while save is in flight', async () => {
    let resolveCreate!: (provider: SavedProvider) => void
    providerStoreState.createProvider = vi.fn().mockImplementation(() => new Promise<SavedProvider>((resolve) => {
      resolveCreate = resolve
    }))
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

    fireEvent.click(screen.getByRole('button', { name: /Add Provider|添加服务商/i }))
    const dialog = screen.getByRole('dialog')
    await waitFor(() => {
      const settingsTextarea = dialog.querySelector('textarea')
      expect(settingsTextarea?.value).toContain('"ANTHROPIC_MODEL"')
    })

    fireEvent.change(within(dialog).getByPlaceholderText('sk-...'), { target: { value: 'sk-test' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /Save|Add|保存|添加/i }))

    await waitFor(() => {
      expect(providerStoreState.createProvider).toHaveBeenCalledTimes(1)
    })

    const cancelButton = within(dialog).getByRole('button', { name: /Cancel|取消/i })
    expect(cancelButton).toBeDisabled()

    fireEvent.click(cancelButton)
    fireEvent.click(within(dialog).getByRole('button', { name: /Save|Add|保存|添加/i }))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(providerStoreState.createProvider).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveCreate({
        id: 'provider-new',
        presetId: 'custom',
        name: 'Custom',
        apiKey: 'sk-test',
        baseUrl: 'https://api.example.com/anthropic',
        apiFormat: 'anthropic',
        models: {
          main: 'custom-main',
          haiku: 'custom-main',
          sonnet: 'custom-main',
          opus: 'custom-main',
        },
      })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  it('defaults Tool Search off and requires confirmation before persisting an explicit enable', async () => {
    MOCK_GET_SETTINGS.mockResolvedValue({ env: { EXISTING_ENV: '1' } })
    providerStoreState.createProvider = vi.fn().mockResolvedValue({
      id: 'provider-new',
      presetId: 'custom',
      name: 'Custom',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/anthropic',
      apiFormat: 'anthropic',
      toolSearchEnabled: true,
      models: {
        main: 'custom-main',
        haiku: 'custom-main',
        sonnet: 'custom-main',
        opus: 'custom-main',
      },
    })
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
    const toolSearchCheckbox = within(dialog).getByRole('checkbox', { name: 'Enable Tool Search' })

    expect(toolSearchCheckbox).not.toBeChecked()
    await waitFor(() => {
      expect(within(dialog).getByDisplayValue((value) => (
        typeof value === 'string' && value.includes('"ENABLE_TOOL_SEARCH": "false"')
      ))).toBeInTheDocument()
    })

    fireEvent.click(toolSearchCheckbox)
    expect(toolSearchCheckbox).not.toBeChecked()

    const confirmDialog = screen.getByRole('dialog', { name: 'Enable Tool Search?' })
    expect(within(confirmDialog).getByText(/final LLM upstream or gateway explicitly supports/)).toBeInTheDocument()
    expect(within(confirmDialog).getByText(/may return HTTP 400/)).toBeInTheDocument()
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Enable anyway' }))

    expect(toolSearchCheckbox).toBeChecked()
    await waitFor(() => {
      expect(within(dialog).getByDisplayValue((value) => (
        typeof value === 'string' && value.includes('"ENABLE_TOOL_SEARCH": "true"')
      ))).toBeInTheDocument()
    })

    fireEvent.change(within(dialog).getByPlaceholderText('sk-...'), { target: { value: 'sk-test' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /Save|Add/i }))

    await waitFor(() => {
      expect(providerStoreState.createProvider).toHaveBeenCalledWith(expect.objectContaining({
        toolSearchEnabled: true,
      }))
    })
    expect(MOCK_UPDATE_SETTINGS).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({
        EXISTING_ENV: '1',
        ENABLE_TOOL_SEARCH: 'true',
      }),
    }))
  })

  it('defaults experimental beta headers on and persists a provider disable', async () => {
    MOCK_GET_SETTINGS.mockResolvedValue({ env: { EXISTING_ENV: '1' } })
    providerStoreState.createProvider = vi.fn().mockResolvedValue({
      id: 'provider-new',
      presetId: 'custom',
      name: 'Custom',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/anthropic',
      apiFormat: 'anthropic',
      disableExperimentalBetas: true,
      models: {
        main: 'custom-main',
        haiku: 'custom-main',
        sonnet: 'custom-main',
        opus: 'custom-main',
      },
    })
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
    const disableBetasCheckbox = within(dialog).getByRole('checkbox', { name: 'Disable experimental beta headers' })
    expect(within(dialog).getByText(/also disables reasoning effort forwarding/i)).toBeInTheDocument()
    const settingsTextarea = await waitFor(() => {
      const textarea = dialog.querySelector('textarea')
      expect(textarea?.value).toContain('"ANTHROPIC_MODEL"')
      return textarea as HTMLTextAreaElement
    })

    expect(disableBetasCheckbox).not.toBeChecked()
    expect(settingsTextarea.value).not.toContain('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS')

    fireEvent.click(disableBetasCheckbox)
    expect(disableBetasCheckbox).toBeChecked()
    await waitFor(() => {
      expect(settingsTextarea.value).toContain('"CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1"')
    })

    fireEvent.change(within(dialog).getByPlaceholderText('sk-...'), { target: { value: 'sk-test' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /Save|Add/i }))

    await waitFor(() => {
      expect(providerStoreState.createProvider).toHaveBeenCalledWith(expect.objectContaining({
        disableExperimentalBetas: true,
      }))
    })
    expect(MOCK_UPDATE_SETTINGS).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({
        EXISTING_ENV: '1',
        CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
      }),
    }))
  })

  it('saves 1M model declarations for the main and role mappings', async () => {
    providerStoreState.createProvider = vi.fn().mockResolvedValue({
      id: 'provider-new',
      presetId: 'custom',
      name: 'Custom',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/anthropic',
      apiFormat: 'anthropic',
      models: {
        main: 'claude-sonnet-4-6',
        haiku: 'claude-haiku-4-5',
        sonnet: 'claude-sonnet-4-6',
        opus: 'claude-opus-4-7',
      },
      model1mSupport: {
        main: true,
        haiku: false,
        sonnet: true,
        opus: false,
      },
    })
    providerStoreState.presets = [
      {
        id: 'custom',
        name: 'Custom',
        baseUrl: 'https://api.example.com/anthropic',
        apiFormat: 'anthropic',
        defaultModels: {
          main: 'claude-sonnet-4-6',
          haiku: 'claude-haiku-4-5',
          sonnet: 'claude-sonnet-4-6',
          opus: 'claude-opus-4-7',
        },
        needsApiKey: true,
        websiteUrl: '',
      },
    ]

    render(<Settings />)

    fireEvent.click(screen.getByRole('button', { name: /Add Provider|添加服务商/i }))
    const dialog = screen.getByRole('dialog')
    await waitFor(() => {
      const settingsTextarea = dialog.querySelector('textarea')
      expect(settingsTextarea?.value).toContain('"ANTHROPIC_MODEL"')
    })
    fireEvent.change(within(dialog).getByPlaceholderText('sk-...'), { target: { value: 'sk-test' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /1M support: main/i }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /1M support: sonnet/i }))
    await waitFor(() => {
      const settingsTextarea = dialog.querySelector('textarea')
      expect(settingsTextarea?.value).toContain('"ANTHROPIC_MODEL": "claude-sonnet-4-6[1m]"')
      expect(settingsTextarea?.value).toContain('"ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6[1m]"')
      expect(settingsTextarea?.value).toContain('"CLAUDE_CODE_MODEL_CONTEXT_WINDOWS"')
      expect(settingsTextarea?.value).toContain('\\"claude-sonnet-4-6\\":1000000')
    })
    fireEvent.click(within(dialog).getByRole('button', { name: /Save|Add|保存|添加/i }))

    await waitFor(() => {
      expect(providerStoreState.createProvider).toHaveBeenCalledWith(expect.objectContaining({
        model1mSupport: {
          main: true,
          haiku: false,
          sonnet: true,
          opus: false,
        },
        modelContextWindows: {
          'claude-sonnet-4-6': 1000000,
        },
      }))
    })
    expect(MOCK_UPDATE_SETTINGS).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({
        ANTHROPIC_MODEL: 'claude-sonnet-4-6[1m]',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6[1m]',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-7',
        CLAUDE_CODE_MODEL_CONTEXT_WINDOWS: '{"claude-sonnet-4-6":1000000}',
      }),
    }))
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

  function setCustomPreset() {
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
  }

  /** Opens the create form with a base URL and key already filled in. */
  async function openProviderForm() {
    setCustomPreset()

    render(<Settings />)

    fireEvent.click(screen.getByRole('button', { name: /Add Provider|添加服务商/i }))
    const dialog = screen.getByRole('dialog')
    await waitFor(() => {
      expect(dialog.querySelector('textarea')?.value).toContain('"ANTHROPIC_MODEL"')
    })
    fireEvent.change(within(dialog).getByPlaceholderText('sk-...'), { target: { value: 'sk-test' } })
    return dialog
  }

  async function openProviderFormWithModels(result: ProviderModelsResult) {
    providerStoreState.fetchModels = vi.fn().mockResolvedValue(result)
    return openProviderForm()
  }

  it('opens the cc-switch import dialog from the providers header', async () => {
    providerStoreState.scanCcSwitch = vi.fn().mockResolvedValue({
      available: false,
      reason: 'not-found',
      configDir: '/Users/tester/.cc-switch',
      candidates: [],
    })

    render(<Settings />)

    fireEvent.click(screen.getByRole('button', { name: /Import from cc-switch|从 cc-switch 导入/i }))

    await waitFor(() => {
      expect(providerStoreState.scanCcSwitch).toHaveBeenCalled()
    })
    expect(await screen.findByText(/No cc-switch configuration was found/i)).toBeInTheDocument()
  })

  it('explains that an API key is required before models can be fetched', () => {
    setCustomPreset()

    render(<Settings />)

    fireEvent.click(screen.getByRole('button', { name: /Add Provider|添加服务商/i }))
    const dialog = screen.getByRole('dialog')
    const fetchButton = within(dialog).getByRole('button', { name: /Fetch models|获取模型/i })

    expect(fetchButton).toBeDisabled()
    expect(within(dialog).getByText(/Enter an API key to fetch the model list/i)).toBeInTheDocument()

    fireEvent.change(within(dialog).getByPlaceholderText('sk-...'), { target: { value: 'sk-test' } })

    expect(fetchButton).toBeEnabled()
    expect(within(dialog).getByText(/only when the upstream provider publishes a model list endpoint/i)).toBeInTheDocument()
  })

  it('gives every model slot a picker once the model list is fetched', async () => {
    const dialog = await openProviderFormWithModels({
      ok: true,
      endpoint: 'https://api.example.com/v1/models',
      models: [
        { id: 'gpt-5-mini', ownedBy: 'openai' },
        { id: 'claude-sonnet-4-6', ownedBy: 'anthropic' },
      ],
    })

    fireEvent.click(within(dialog).getByRole('button', { name: /Fetch models|获取模型/i }))

    await waitFor(() => {
      expect(providerStoreState.fetchModels).toHaveBeenCalledWith({
        baseUrl: 'https://api.example.com/anthropic',
        apiKey: 'sk-test',
      })
    })
    expect(await within(dialog).findByText(/Model list loaded \(2\)/i)).toBeInTheDocument()
    expect(within(dialog).getAllByRole('button', { name: /from the fetched list/i })).toHaveLength(4)

    // The picker supplements the field; a model id that is not on the list must
    // still be typeable. Queried by role because the picker's own accessible
    // name also contains the slot label.
    const mainInput = within(dialog).getByRole('combobox', { name: /Main Model|主模型/i })
    fireEvent.change(mainInput, { target: { value: 'gpt-5-mini[1m]' } })
    expect(mainInput).toHaveValue('gpt-5-mini')
    expect(within(dialog).getByRole('option', { name: 'gpt-5-mini' })).toBeInTheDocument()
    expect(within(dialog).queryByText(/No matching models/i)).not.toBeInTheDocument()

    fireEvent.change(mainInput, { target: { value: 'typed-by-hand' } })
    expect(mainInput).toHaveValue('typed-by-hand')
    const noMatches = within(dialog).getByRole('option', { name: /No matching models/i })
    expect(noMatches).toHaveAttribute('aria-disabled', 'true')
  })

  it('toasts that the fetched list is now pickable from the dropdown', async () => {
    const dialog = await openProviderFormWithModels({
      ok: true,
      endpoint: 'https://api.example.com/v1/models',
      models: [
        { id: 'gpt-5-mini', ownedBy: 'openai' },
        { id: 'claude-sonnet-4-6', ownedBy: 'anthropic' },
      ],
    })

    fireEvent.click(within(dialog).getByRole('button', { name: /Fetch models|获取模型/i }))

    await waitFor(() => {
      expect(useUIStore.getState().toasts[useUIStore.getState().toasts.length - 1]).toMatchObject({
        type: 'success',
        message: 'Model list loaded. Pick a model from the dropdown now.',
      })
    })
  })

  it('does not toast when the fetched model list is empty', async () => {
    const dialog = await openProviderFormWithModels({
      ok: true,
      endpoint: 'https://api.example.com/v1/models',
      models: [],
    })

    fireEvent.click(within(dialog).getByRole('button', { name: /Fetch models|获取模型/i }))

    await waitFor(() => {
      expect(providerStoreState.fetchModels).toHaveBeenCalled()
    })
    expect(useUIStore.getState().toasts).toHaveLength(0)
  })

  it('routes a picked model through the shared model change handler', async () => {
    const dialog = await openProviderFormWithModels({
      ok: true,
      endpoint: 'https://api.example.com/v1/models',
      models: [
        { id: 'gpt-5-mini', ownedBy: 'openai' },
        { id: 'claude-sonnet-4-6', ownedBy: 'anthropic' },
      ],
    })

    fireEvent.click(within(dialog).getByRole('button', { name: /Fetch models|获取模型/i }))
    const mainCombobox = await within(dialog).findByRole('combobox', { name: /Main Model|主模型/i })
    const pickerButton = within(dialog).getByRole('button', { name: /Main Model.*fetched list/i })
    expect(pickerButton).toHaveAttribute('tabindex', '-1')

    fireEvent.click(mainCombobox)
    expect(mainCombobox).toHaveAttribute('aria-expanded', 'true')
    expect(within(dialog).getByRole('option', { name: /gpt-5-mini/i })).toHaveAttribute('tabindex', '-1')
    fireEvent.keyDown(mainCombobox, { key: 'ArrowDown' })
    fireEvent.keyDown(mainCombobox, { key: 'Enter' })

    expect(mainCombobox).toHaveValue('gpt-5-mini')
    expect(mainCombobox).toHaveAttribute('aria-expanded', 'false')
    // Going through handleModelChange is what keeps the settings JSON in sync —
    // a bare setState would leave the textarea on the old model id.
    await waitFor(() => {
      expect(dialog.querySelector('textarea')?.value).toContain('"ANTHROPIC_MODEL": "gpt-5-mini"')
    })
  })

  it('closes the previous model popup when keyboard focus moves to another field', async () => {
    const dialog = await openProviderFormWithModels({
      ok: true,
      endpoint: 'https://api.example.com/v1/models',
      models: [
        { id: 'gpt-5-mini', ownedBy: 'openai' },
        { id: 'claude-sonnet-4-6', ownedBy: 'anthropic' },
      ],
    })

    fireEvent.click(within(dialog).getByRole('button', { name: /Fetch models|获取模型/i }))
    const comboboxes = await within(dialog).findAllByRole('combobox')
    const mainCombobox = comboboxes[0]!
    const haikuCombobox = comboboxes[1]!

    fireEvent.focus(mainCombobox)
    expect(mainCombobox).toHaveAttribute('aria-expanded', 'true')
    expect(within(dialog).getAllByRole('listbox')).toHaveLength(1)

    fireEvent.blur(mainCombobox, { relatedTarget: haikuCombobox })
    fireEvent.focus(haikuCombobox)

    expect(mainCombobox).toHaveAttribute('aria-expanded', 'false')
    expect(haikuCombobox).toHaveAttribute('aria-expanded', 'true')
    expect(within(dialog).getAllByRole('listbox')).toHaveLength(1)
  })

  it('limits a large catalog until the user narrows the model input', async () => {
    const dialog = await openProviderFormWithModels({
      ok: true,
      endpoint: 'https://api.example.com/v1/models',
      models: Array.from({ length: 101 }, (_, index) => ({
        id: `model-${String(index).padStart(3, '0')}`,
        ownedBy: 'openai',
      })),
    })

    fireEvent.click(within(dialog).getByRole('button', { name: /Fetch models|获取模型/i }))
    const mainCombobox = await within(dialog).findByRole('combobox', { name: /Main Model|主模型/i })
    fireEvent.click(mainCombobox)

    expect(within(dialog).getAllByRole('option')).toHaveLength(100)
    expect(within(dialog).getByText(/More models are available/i)).toBeInTheDocument()

    fireEvent.change(mainCombobox, { target: { value: 'model-100' } })

    expect(within(dialog).getAllByRole('option')).toHaveLength(1)
    expect(within(dialog).getByRole('option', { name: 'model-100' })).toBeInTheDocument()
    expect(within(dialog).queryByText(/More models are available/i)).not.toBeInTheDocument()
  })

  it.each([
    ['auth-failed' as const, /API key was rejected/i],
    ['not-supported' as const, /does not publish a model list/i],
    ['endpoint-not-found' as const, /No model list endpoint/i],
    ['timeout' as const, /did not respond in time/i],
  ])('explains a failed model fetch for errorCode=%s', async (errorCode, expected) => {
    const dialog = await openProviderFormWithModels({
      ok: false,
      errorCode,
      // Free text that must never steer the headline — that still comes from
      // the code.
      message: 'upstream said no',
      endpointsTried: ['https://api.example.com/v1/models'],
    })

    fireEvent.click(within(dialog).getByRole('button', { name: /Fetch models|获取模型/i }))

    expect(await within(dialog).findByText(expected)).toBeInTheDocument()
    // Changed from asserting the upstream text is hidden. Dropping it made a
    // 200-cloaked auth failure read as "this provider has no model list"; the
    // code still picks the headline, the raw text only rides along under it.
    expect(within(dialog).getByText(/upstream said no/)).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /from the fetched list/i })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('surfaces the upstream message when a 200 response cloaks an auth failure', async () => {
    // 智谱 answers HTTP 200 with {"code":1000,"msg":"身份验证失败。"}, which the
    // server can only classify as `not-supported`. On the code alone the user is
    // told to type model ids by hand, when the actual fix is the rejected key.
    const dialog = await openProviderFormWithModels({
      ok: false,
      errorCode: 'not-supported',
      message: '身份验证失败。',
      httpStatus: 200,
      endpointsTried: ['https://open.bigmodel.cn/api/anthropic/v1/models'],
    })

    fireEvent.click(within(dialog).getByRole('button', { name: /Fetch models|获取模型/i }))

    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent(/does not publish a model list/i)
    expect(alert).toHaveTextContent('身份验证失败。')
  })

  it('renders the error on its own when the server sends no upstream message', async () => {
    const dialog = await openProviderFormWithModels({
      ok: false,
      errorCode: 'network',
      message: '   ',
      endpointsTried: [],
    })

    fireEvent.click(within(dialog).getByRole('button', { name: /Fetch models|获取模型/i }))

    const alert = await within(dialog).findByRole('alert')
    // No dangling "Provider response:" label with nothing behind it.
    expect(alert.textContent).toBe('Could not reach the provider. Check the base URL and your network.')
  })

  it('does not echo an upstream message that already matches the explanation', async () => {
    const dialog = await openProviderFormWithModels({
      ok: false,
      errorCode: 'timeout',
      message: 'The provider did not respond in time.',
      endpointsTried: ['https://api.example.com/v1/models'],
    })

    fireEvent.click(within(dialog).getByRole('button', { name: /Fetch models|获取模型/i }))

    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toBe('The provider did not respond in time.')
  })

  it('discards a model list that arrives after the base URL changed', async () => {
    let resolveFetch!: (result: ProviderModelsResult) => void
    providerStoreState.fetchModels = vi.fn().mockReturnValue(
      new Promise<ProviderModelsResult>((resolve) => {
        resolveFetch = resolve
      }),
    )
    const dialog = await openProviderForm()

    fireEvent.click(within(dialog).getByRole('button', { name: /Fetch models|获取模型/i }))
    await waitFor(() => {
      expect(providerStoreState.fetchModels).toHaveBeenCalledTimes(1)
    })

    fireEvent.change(within(dialog).getByRole('textbox', { name: /Base URL|接口地址/i }), {
      target: { value: 'https://other.example.com/anthropic' },
    })

    // The probe walks up to three candidate endpoints at 15s each, so landing
    // after the edit is the ordinary case rather than a corner one.
    await act(async () => {
      resolveFetch({
        ok: true,
        endpoint: 'https://api.example.com/v1/models',
        models: [{ id: 'gpt-5-mini', ownedBy: 'openai' }],
      })
    })

    // These models belong to the base URL the user just replaced.
    expect(within(dialog).queryByText(/Model list loaded/i)).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /from the fetched list/i })).not.toBeInTheDocument()
    // ...and the discarded response must not leave the button spinning either.
    expect(within(dialog).getByRole('button', { name: /Fetch models|获取模型/i })).toBeEnabled()
  })

  it('discards a failed model fetch that arrives after the base URL changed', async () => {
    let resolveFetch!: (result: ProviderModelsResult) => void
    providerStoreState.fetchModels = vi.fn().mockReturnValue(
      new Promise<ProviderModelsResult>((resolve) => {
        resolveFetch = resolve
      }),
    )
    const dialog = await openProviderForm()

    fireEvent.click(within(dialog).getByRole('button', { name: /Fetch models|获取模型/i }))
    await waitFor(() => {
      expect(providerStoreState.fetchModels).toHaveBeenCalledTimes(1)
    })

    fireEvent.change(within(dialog).getByRole('textbox', { name: /Base URL|接口地址/i }), {
      target: { value: 'https://other.example.com/anthropic' },
    })

    await act(async () => {
      resolveFetch({
        ok: false,
        errorCode: 'auth-failed',
        message: 'stale key rejected',
        endpointsTried: ['https://api.example.com/v1/models'],
      })
    })

    // Blaming the key the user is halfway through replacing is its own bug.
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /Fetch models|获取模型/i })).toBeEnabled()
  })

  it('treats an empty model list as a neutral result rather than an error', async () => {
    const dialog = await openProviderFormWithModels({
      ok: true,
      endpoint: 'https://api.example.com/v1/models',
      models: [],
    })

    fireEvent.click(within(dialog).getByRole('button', { name: /Fetch models|获取模型/i }))

    expect(await within(dialog).findByText(/No models found/i)).toBeInTheDocument()
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /from the fetched list/i })).not.toBeInTheDocument()
  })

  it('drops a fetched model list once the base URL changes', async () => {
    const dialog = await openProviderFormWithModels({
      ok: true,
      endpoint: 'https://api.example.com/v1/models',
      models: [{ id: 'gpt-5-mini', ownedBy: 'openai' }],
    })

    fireEvent.click(within(dialog).getByRole('button', { name: /Fetch models|获取模型/i }))
    expect(await within(dialog).findByText(/Model list loaded \(1\)/i)).toBeInTheDocument()

    fireEvent.change(within(dialog).getByRole('textbox', { name: /Base URL|接口地址/i }), {
      target: { value: 'https://other.example.com/anthropic' },
    })

    // A list fetched from a different endpoint would be a lie about this one.
    expect(within(dialog).queryByText(/Model list loaded/i)).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /from the fetched list/i })).not.toBeInTheDocument()
  })

  it('drops an open model list when the API key changes and does not reopen it after refetching', async () => {
    const dialog = await openProviderFormWithModels({
      ok: true,
      endpoint: 'https://api.example.com/v1/models',
      models: [{ id: 'gpt-5-mini', ownedBy: 'openai' }],
    })

    fireEvent.click(within(dialog).getByRole('button', { name: /Fetch models|获取模型/i }))
    expect(await within(dialog).findByText(/Model list loaded \(1\)/i)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('combobox', { name: /Main Model|主模型/i }))
    expect(within(dialog).getByRole('listbox')).toBeInTheDocument()

    fireEvent.change(within(dialog).getByPlaceholderText('sk-...'), { target: { value: 'sk-other' } })

    expect(within(dialog).queryByText(/Model list loaded/i)).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('listbox')).not.toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: /Fetch models|获取模型/i }))
    const mainCombobox = await within(dialog).findByRole('combobox', { name: /Main Model|主模型/i })
    expect(mainCombobox).toHaveAttribute('aria-expanded', 'false')
    expect(within(dialog).queryByRole('listbox')).not.toBeInTheDocument()
  })
})

describe('Settings > About tab', () => {
  beforeEach(() => {
    useUIStore.setState({ activeSettingsTab: 'providers', pendingSettingsTab: 'about' })
    useSettingsStore.setState({
      locale: 'en',
      updateProxy: { mode: 'system', url: '' },
      setUpdateProxy: vi.fn().mockImplementation(async (next: UpdateProxySettings) => {
        useSettingsStore.setState({ updateProxy: next })
      }),
    })
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

  it('does not show a fake fallback app version when desktop version IPC fails', async () => {
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        updates: true,
      },
      app: {
        ...browserHost.app,
        getVersion: vi.fn().mockRejectedValue(new Error('version IPC failed')),
      },
    }
    useUpdateStore.setState({
      status: 'up-to-date',
      availableVersion: null,
      releaseNotes: null,
      progressPercent: 0,
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
      checkedAt: Date.now(),
      shouldPrompt: false,
      initialize: vi.fn().mockResolvedValue(undefined),
      checkForUpdates: vi.fn().mockResolvedValue(null),
      installUpdate: vi.fn().mockResolvedValue(undefined),
      dismissPrompt: vi.fn(),
    })

    render(<Settings />)

    expect(await screen.findByText('Unknown')).toBeInTheDocument()
    expect(screen.queryByText('0.1.0')).not.toBeInTheDocument()
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

  it('saves a manual update proxy from the advanced update controls', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByRole('button', { name: /Advanced update proxy/i }))
    expect(screen.getByRole('button', { name: /System proxy/i })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('This only affects app update checks and downloads.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Manual proxy/i }))
    const proxyInput = screen.getByLabelText('Proxy URL')
    const saveButton = screen.getByRole('button', { name: 'Save' })

    expect(screen.getByText('Enter a proxy URL.')).toBeInTheDocument()
    expect(saveButton).toBeDisabled()

    fireEvent.change(proxyInput, { target: { value: 'socks5://127.0.0.1:7890' } })
    expect(screen.getByText('Enter an HTTP or HTTPS proxy URL.')).toBeInTheDocument()
    expect(saveButton).toBeDisabled()

    fireEvent.change(proxyInput, { target: { value: '  http://127.0.0.1:7890  ' } })
    expect(screen.getByText('HTTP and HTTPS proxy URLs are supported, for example http://127.0.0.1:7890.')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(saveButton)
    })

    expect(useSettingsStore.getState().setUpdateProxy).toHaveBeenCalledWith({
      mode: 'manual',
      url: 'http://127.0.0.1:7890',
    })
  })

  it('can switch update proxy settings back to system mode', async () => {
    useSettingsStore.setState({
      updateProxy: { mode: 'manual', url: 'http://127.0.0.1:7890' },
    })
    render(<Settings />)

    fireEvent.click(screen.getByRole('button', { name: /Advanced update proxy/i }))
    expect(screen.getByRole('button', { name: /Manual proxy/i })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: /System proxy/i }))
    const saveButton = screen.getByRole('button', { name: 'Save' })

    await act(async () => {
      fireEvent.click(saveButton)
    })

    expect(useSettingsStore.getState().setUpdateProxy).toHaveBeenCalledWith({
      mode: 'system',
      url: 'http://127.0.0.1:7890',
    })
  })
})
