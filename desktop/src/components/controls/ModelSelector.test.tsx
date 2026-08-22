import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'

const { runtimeMocks } = vi.hoisted(() => ({
  runtimeMocks: { isMobileViewport: false, isDesktopRuntime: false },
}))

vi.mock('../../hooks/useMobileViewport', () => ({
  useMobileViewport: () => runtimeMocks.isMobileViewport,
}))

vi.mock('../../lib/desktopRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/desktopRuntime')>()
  return { ...actual, isDesktopRuntime: () => runtimeMocks.isDesktopRuntime }
})

import { ModelSelector } from './ModelSelector'
import { useChatStore } from '../../stores/chatStore'
import { useHahaOAuthStore } from '../../stores/hahaOAuthStore'
import { useHahaOpenAIOAuthStore } from '../../stores/hahaOpenAIOAuthStore'
import { useHahaGrokOAuthStore } from '../../stores/hahaGrokOAuthStore'
import { useProviderStore } from '../../stores/providerStore'
import { useSessionRuntimeStore } from '../../stores/sessionRuntimeStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore, SETTINGS_TAB_ID } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import { OPENAI_OFFICIAL_PROVIDER_ID } from '../../constants/openaiOfficialProvider'
import type { ModelInfo } from '../../types/settings'

const MODELS: ModelInfo[] = [
  { id: 'alpha', name: 'Alpha', description: 'Fast model', context: '128k' },
  { id: 'beta', name: 'Beta', description: 'Careful model', context: '200k' },
]

async function clickByRole(name: RegExp | string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
    await Promise.resolve()
  })
}

afterEach(() => {
  cleanup()
  Object.assign(runtimeMocks, { isMobileViewport: false, isDesktopRuntime: false })
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  useProviderStore.setState(useProviderStore.getInitialState(), true)
  useSessionRuntimeStore.setState(useSessionRuntimeStore.getInitialState(), true)
  useChatStore.setState(useChatStore.getInitialState(), true)
  useHahaOAuthStore.setState(useHahaOAuthStore.getInitialState(), true)
  useHahaOpenAIOAuthStore.setState(useHahaOpenAIOAuthStore.getInitialState(), true)
  useHahaGrokOAuthStore.setState(useHahaGrokOAuthStore.getInitialState(), true)
  useTabStore.setState(useTabStore.getInitialState(), true)
  useUIStore.setState(useUIStore.getInitialState(), true)
})

beforeEach(() => {
  useHahaOAuthStore.setState({ fetchStatus: async () => {} })
  useHahaOpenAIOAuthStore.setState({ fetchStatus: async () => {} })
  useHahaGrokOAuthStore.setState({ fetchStatus: async () => {} })
})

describe('ModelSelector', () => {
  it('keeps the current Claude Official catalog visible when the API returns legacy settings models', async () => {
    const legacyModels: ModelInfo[] = [
      { id: 'claude-opus-4-7', name: 'Opus 4.7', description: 'Legacy Opus', context: '1m' },
      { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', description: 'Legacy Sonnet', context: '200k' },
      { id: 'claude-haiku-4-5', name: 'Haiku 4.5', description: 'Legacy Haiku', context: '200k' },
    ]
    useHahaOAuthStore.setState({
      status: {
        loggedIn: true,
        expiresAt: null,
        scopes: [],
        subscriptionType: 'pro',
      },
      fetchStatus: async () => {},
    })
    useSettingsStore.setState({
      locale: 'en',
      availableModels: legacyModels,
      currentModel: legacyModels[0],
      activeProviderName: 'Claude Official',
    })
    useProviderStore.setState({
      providers: [],
      activeId: null,
      hasLoadedProviders: true,
      isLoading: false,
    })

    render(<ModelSelector runtimeKey="session-claude-legacy" />)

    await clickByRole(/Opus 4\.7/i)

    expect(screen.getByRole('button', { name: /Fable 5/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Opus 4\.8/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Sonnet 5/ })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Opus 4\.7/ }).length).toBeGreaterThan(0)
  })

  it('does not query official OAuth status when mounted', () => {
    const fetchClaudeStatus = vi.fn(async () => {})
    const fetchOpenAIStatus = vi.fn(async () => {})
    useHahaOAuthStore.setState({ fetchStatus: fetchClaudeStatus })
    useHahaOpenAIOAuthStore.setState({ fetchStatus: fetchOpenAIStatus })
    useSettingsStore.setState({
      locale: 'en',
      availableModels: MODELS,
      currentModel: MODELS[0],
      activeProviderName: 'Provider A',
    })
    useProviderStore.setState({
      providers: [],
      activeId: 'provider-a',
      hasLoadedProviders: true,
      isLoading: true,
    })

    render(<ModelSelector runtimeKey="session-no-keychain-prompt" />)

    expect(fetchClaudeStatus).not.toHaveBeenCalled()
    expect(fetchOpenAIStatus).not.toHaveBeenCalled()
  })

  it('queries official OAuth status once when the runtime dropdown is opened', async () => {
    const fetchClaudeStatus = vi.fn(async () => {})
    const fetchOpenAIStatus = vi.fn(async () => {})
    useHahaOAuthStore.setState({ fetchStatus: fetchClaudeStatus })
    useHahaOpenAIOAuthStore.setState({ fetchStatus: fetchOpenAIStatus })
    useSettingsStore.setState({
      locale: 'en',
      availableModels: MODELS,
      currentModel: MODELS[0],
      activeProviderName: 'Provider A',
    })
    useProviderStore.setState({
      providers: [{
        id: 'provider-a',
        presetId: 'custom',
        name: 'Provider A',
        apiKey: '***',
        baseUrl: 'https://api.example.com',
        apiFormat: 'anthropic',
        models: {
          main: 'provider-main',
          haiku: '',
          sonnet: '',
          opus: '',
        },
      }],
      activeId: 'provider-a',
      hasLoadedProviders: true,
      isLoading: true,
    })

    render(<ModelSelector runtimeKey="session-oauth-on-open" />)

    await clickByRole(/provider-main/i)
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
      await Promise.resolve()
    })
    await clickByRole(/provider-main/i)

    expect(fetchClaudeStatus).toHaveBeenCalledTimes(1)
    expect(fetchOpenAIStatus).toHaveBeenCalledTimes(1)
  })

  it('does not query official OAuth status for plain model dropdowns', async () => {
    const fetchClaudeStatus = vi.fn(async () => {})
    const fetchOpenAIStatus = vi.fn(async () => {})
    useHahaOAuthStore.setState({ fetchStatus: fetchClaudeStatus })
    useHahaOpenAIOAuthStore.setState({ fetchStatus: fetchOpenAIStatus })
    useSettingsStore.setState({
      locale: 'en',
      availableModels: MODELS,
      currentModel: MODELS[0],
    })

    render(<ModelSelector value="alpha" onChange={vi.fn()} />)

    await clickByRole(/alpha/i)

    expect(fetchClaudeStatus).not.toHaveBeenCalled()
    expect(fetchOpenAIStatus).not.toHaveBeenCalled()
  })

  it('routes an unconfigured runtime to provider settings instead of showing a fallback model', async () => {
    const fetchClaudeStatus = vi.fn(async () => {
      useHahaOAuthStore.setState({ status: { loggedIn: false } })
    })
    const fetchOpenAIStatus = vi.fn(async () => {
      useHahaOpenAIOAuthStore.setState({ status: { loggedIn: false } })
    })
    const fetchGrokStatus = vi.fn(async () => {
      useHahaGrokOAuthStore.setState({ status: { loggedIn: false } })
    })
    useHahaOAuthStore.setState({ fetchStatus: fetchClaudeStatus })
    useHahaOpenAIOAuthStore.setState({ fetchStatus: fetchOpenAIStatus })
    useHahaGrokOAuthStore.setState({ fetchStatus: fetchGrokStatus })
    useSettingsStore.setState({
      locale: 'en',
      availableModels: MODELS,
      currentModel: {
        id: 'claude-opus-4-8',
        name: 'Opus 4.8',
        description: 'Fallback model',
        context: '1m',
      },
      activeProviderName: null,
    })
    useProviderStore.setState({
      providers: [],
      activeId: null,
      hasLoadedProviders: true,
      isLoading: false,
    })

    render(<ModelSelector runtimeKey="unconfigured-session" />)

    expect(screen.queryByText('Opus 4.8')).not.toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Configure model provider' }))
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(useUIStore.getState().pendingSettingsTab).toBe('providers')
    })
    expect(fetchClaudeStatus).toHaveBeenCalledTimes(1)
    expect(fetchOpenAIStatus).toHaveBeenCalledTimes(1)
    expect(fetchGrokStatus).toHaveBeenCalledTimes(1)
    expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
    expect(screen.queryByTestId('model-selector-dropdown')).not.toBeInTheDocument()
  })

  it('routes directly to provider settings when every official login is already known to be unavailable', () => {
    const fetchClaudeStatus = vi.fn(async () => {})
    const fetchOpenAIStatus = vi.fn(async () => {})
    const fetchGrokStatus = vi.fn(async () => {})
    useHahaOAuthStore.setState({ status: { loggedIn: false }, fetchStatus: fetchClaudeStatus })
    useHahaOpenAIOAuthStore.setState({ status: { loggedIn: false }, fetchStatus: fetchOpenAIStatus })
    useHahaGrokOAuthStore.setState({ status: { loggedIn: false }, fetchStatus: fetchGrokStatus })
    useSettingsStore.setState({
      locale: 'en',
      currentModel: {
        id: 'claude-opus-4-8',
        name: 'Opus 4.8',
        description: 'Fallback model',
        context: '1m',
      },
    })
    useProviderStore.setState({
      providers: [],
      activeId: null,
      hasLoadedProviders: true,
      isLoading: false,
    })

    render(<ModelSelector runtimeKey="known-unconfigured-session" />)
    fireEvent.click(screen.getByRole('button', { name: 'Configure model provider' }))

    expect(fetchClaudeStatus).not.toHaveBeenCalled()
    expect(fetchOpenAIStatus).not.toHaveBeenCalled()
    expect(fetchGrokStatus).not.toHaveBeenCalled()
    expect(useUIStore.getState().pendingSettingsTab).toBe('providers')
    expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
  })

  it('opens Claude Official models when the configuration check finds a login', async () => {
    const fetchClaudeStatus = vi.fn(async () => {
      useHahaOAuthStore.setState({
        status: { loggedIn: true, expiresAt: null, scopes: [], subscriptionType: 'pro' },
      })
    })
    useHahaOAuthStore.setState({ fetchStatus: fetchClaudeStatus })
    useSettingsStore.setState({
      locale: 'en',
      availableModels: MODELS,
      currentModel: MODELS[0],
      activeProviderName: null,
    })
    useProviderStore.setState({
      providers: [],
      activeId: null,
      hasLoadedProviders: true,
      isLoading: false,
    })

    render(<ModelSelector runtimeKey="claude-login-session" />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Configure model provider' }))
      await Promise.resolve()
    })

    const dropdown = await screen.findByTestId('model-selector-dropdown')
    expect(within(dropdown).getByRole('button', { name: /Alpha/ })).toBeInTheDocument()
    expect(fetchClaudeStatus).toHaveBeenCalledTimes(1)
    expect(useUIStore.getState().pendingSettingsTab).toBeNull()
  })

  it('waits for saved providers before deciding that the runtime is unconfigured', async () => {
    const provider = {
      id: 'provider-late',
      presetId: 'custom',
      name: 'Late Provider',
      apiKey: '***',
      baseUrl: 'https://api.example.com',
      apiFormat: 'anthropic' as const,
      models: {
        main: 'late-main',
        haiku: '',
        sonnet: '',
        opus: '',
      },
    }
    const fetchProviders = vi.fn(async () => {
      useProviderStore.setState({
        providers: [provider],
        activeId: provider.id,
        hasLoadedProviders: true,
        isLoading: false,
      })
    })
    useHahaOAuthStore.setState({ status: { loggedIn: false } })
    useHahaOpenAIOAuthStore.setState({ status: { loggedIn: false } })
    useHahaGrokOAuthStore.setState({ status: { loggedIn: false } })
    useSettingsStore.setState({ locale: 'en', activeProviderName: null })
    useProviderStore.setState({
      providers: [],
      activeId: null,
      hasLoadedProviders: false,
      isLoading: true,
      fetchProviders,
    })

    render(<ModelSelector runtimeKey="provider-loading-session" />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Configure model provider' }))
      await Promise.resolve()
    })

    const dropdown = await screen.findByTestId('model-selector-dropdown')
    expect(within(dropdown).getByRole('button', { name: /late-main/ })).toBeInTheDocument()
    expect(fetchProviders).toHaveBeenCalledTimes(1)
    expect(useUIStore.getState().pendingSettingsTab).toBeNull()
  })

  it('uses controlled model selection without mutating settings directly', async () => {
    const onChange = vi.fn()
    useSettingsStore.setState({
      locale: 'en',
      availableModels: MODELS,
      currentModel: MODELS[0],
    })

    render(<ModelSelector value="alpha" onChange={onChange} />)

    await clickByRole(/alpha/i)
    await clickByRole(/Beta/)

    expect(onChange).toHaveBeenCalledWith('beta')
  })

  it('uses caller-supplied models in the reusable field appearance', async () => {
    const onChange = vi.fn()
    useSettingsStore.setState({
      locale: 'en',
      availableModels: MODELS,
      currentModel: MODELS[0],
    })
    const agentModels: ModelInfo[] = [
      { id: 'inherit', name: 'Inherit from parent', description: 'Use the parent model', context: '' },
      { id: 'provider-model', name: 'Provider Model', description: 'Configured model', context: '200k' },
    ]

    render(
      <ModelSelector
        value="inherit"
        onChange={onChange}
        models={agentModels}
        ariaLabel="Model"
        appearance="field"
      />,
    )

    const trigger = screen.getByRole('button', { name: 'Model' })
    expect(trigger.parentElement).toHaveClass('h-10', 'border-[var(--color-border)]')
    fireEvent.click(trigger)
    const dropdown = screen.getByTestId('model-selector-dropdown')
    expect(within(dropdown).queryByRole('button', { name: /Alpha/ })).not.toBeInTheDocument()
    fireEvent.click(within(dropdown).getByRole('button', { name: /Provider Model/ }))

    expect(onChange).toHaveBeenCalledWith('provider-model')
  })

  it('routes uncontrolled model changes through settings actions', async () => {
    const setModel = vi.fn(async () => {})
    useSettingsStore.setState({
      locale: 'en',
      availableModels: MODELS,
      currentModel: MODELS[0],
      effortLevel: 'max',
      setModel,
    })

    render(<ModelSelector />)

    await clickByRole(/alpha/i)
    await clickByRole(/Beta/)
    expect(setModel).toHaveBeenCalledWith('beta')
  })

  it('filters models by name or description and shows a clearable empty state', async () => {
    const onChange = vi.fn()
    useSettingsStore.setState({
      locale: 'en',
      availableModels: MODELS,
      currentModel: MODELS[0],
    })

    render(<ModelSelector value="alpha" onChange={onChange} />)

    await clickByRole(/alpha/i)
    const dropdown = screen.getByTestId('model-selector-dropdown')
    const search = within(dropdown).getByRole('searchbox', { name: 'Search models' })

    expect(search).toHaveFocus()
    // The header lives outside the scroll region: a sticky header inside
    // `overflow-y-auto` lets scrolled items paint through it on the desktop
    // shell, so the contract is a hard clip below the header instead.
    expect(search.closest('.overflow-y-auto')).toBeNull()
    expect(dropdown).toHaveClass('overflow-hidden')

    fireEvent.change(search, { target: { value: 'careful' } })
    expect(within(dropdown).queryByRole('button', { name: /Alpha/ })).not.toBeInTheDocument()
    expect(within(dropdown).getByRole('button', { name: /Beta/ })).toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'missing' } })
    expect(within(dropdown).getByRole('status')).toHaveTextContent('No matching models')

    fireEvent.click(within(dropdown).getByRole('button', { name: 'Clear model search' }))
    expect(within(dropdown).getByRole('button', { name: /Alpha/ })).toBeInTheDocument()
    expect(within(dropdown).getByRole('button', { name: /Beta/ })).toBeInTheDocument()
  })

  it('keeps the H5 search field in the fixed sheet header with a 44px touch target', async () => {
    Object.assign(runtimeMocks, { isMobileViewport: true, isDesktopRuntime: false })
    useSettingsStore.setState({
      locale: 'en',
      availableModels: MODELS,
      currentModel: MODELS[0],
    })

    render(<ModelSelector value="alpha" onChange={vi.fn()} />)

    await clickByRole(/alpha/i)
    const sheet = screen.getByTestId('model-selector-dropdown')
    const search = within(sheet).getByRole('searchbox', { name: 'Search models' })
    const scrollRegion = sheet.children[1]

    expect(search).toHaveClass('h-11')
    expect(sheet.children[0]?.contains(search)).toBe(true)
    expect(scrollRegion?.contains(search)).toBe(false)
  })

  it('selects provider-scoped runtime models and mirrors session selections', async () => {
    const setSessionRuntime = vi.fn()
    useSettingsStore.setState({
      locale: 'en',
      availableModels: MODELS,
      currentModel: MODELS[0],
      activeProviderName: 'Provider A',
      effortLevel: 'high',
    })
    useProviderStore.setState({
      providers: [{
        id: 'provider-a',
        presetId: 'custom',
        name: 'Provider A',
        apiKey: '***',
        baseUrl: 'https://api.example.com',
        apiFormat: 'anthropic',
        models: {
          main: 'provider-main',
          haiku: 'provider-fast',
          sonnet: 'provider-main',
          opus: '',
        },
      }],
      activeId: 'provider-a',
      hasLoadedProviders: true,
      isLoading: true,
    })
    useChatStore.setState({
      setSessionRuntime,
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    render(<ModelSelector runtimeKey="session-1" />)

    await clickByRole(/provider-main/i)
    const dropdown = screen.getByTestId('model-selector-dropdown')
    const search = within(dropdown).getByRole('searchbox', { name: 'Search models' })
    fireEvent.change(search, { target: { value: 'provider a' } })
    expect(within(dropdown).getByRole('button', { name: /provider-main/ })).toBeInTheDocument()
    expect(within(dropdown).getByRole('button', { name: /provider-fast/ })).toBeInTheDocument()

    fireEvent.change(search, {
      target: { value: 'fast' },
    })
    expect(within(dropdown).queryByRole('button', { name: /provider-main/ })).not.toBeInTheDocument()
    await act(async () => {
      fireEvent.click(within(dropdown).getByRole('button', { name: /provider-fast/ }))
      await Promise.resolve()
    })

    expect(useSessionRuntimeStore.getState().selections['session-1']).toEqual({
      providerId: 'provider-a',
      modelId: 'provider-fast',
      effortLevel: 'high',
    })
    expect(setSessionRuntime).toHaveBeenCalledWith('session-1', {
      providerId: 'provider-a',
      modelId: 'provider-fast',
      effortLevel: 'high',
    })
  })

  it('defaults blank provider-scoped runtime selections to the active provider main model', async () => {
    useSettingsStore.setState({
      locale: 'en',
      availableModels: [
        { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', description: 'Main Model · Haiku Model', context: '' },
        { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', description: 'Sonnet Model · Opus Model', context: '' },
      ],
      currentModel: { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', description: 'Sonnet Model · Opus Model', context: '' },
      activeProviderName: 'Custom-DeepSeek-OpenAI',
    })
    useProviderStore.setState({
      providers: [{
        id: 'deepseek-provider',
        presetId: 'custom',
        name: 'Custom-DeepSeek-OpenAI',
        apiKey: '***',
        baseUrl: 'https://api.deepseek.com',
        apiFormat: 'openai_chat',
        models: {
          main: 'deepseek-v4-flash',
          haiku: 'deepseek-v4-flash',
          sonnet: 'deepseek-v4-pro',
          opus: 'deepseek-v4-pro',
        },
      }],
      activeId: 'deepseek-provider',
      hasLoadedProviders: true,
      isLoading: true,
    })

    render(<ModelSelector runtimeKey="blank-session" />)

    const trigger = screen.getByRole('button', { name: /deepseek-v4-flash/i })
    await act(async () => {
      fireEvent.click(trigger)
      await Promise.resolve()
    })

    const flashOption = screen
      .getAllByRole('button', { name: /deepseek-v4-flash/i })
      .find((button) => button.textContent?.includes('Main Model'))
    expect(flashOption).toBeDefined()
    expect(flashOption?.className).toContain('border-[var(--color-model-option-selected-border)]')
  })

  it('closes the focus ring on both halves of the segmented control', () => {
    useHahaOAuthStore.setState({
      status: { loggedIn: true, expiresAt: null, scopes: [], subscriptionType: 'pro' },
      fetchStatus: async () => {},
    })
    useSettingsStore.setState({
      locale: 'en',
      availableModels: MODELS,
      currentModel: MODELS[0],
      activeProviderName: 'Provider A',
      effortLevel: 'max',
    })
    useProviderStore.setState({ hasLoadedProviders: true, isLoading: false })
    useSessionRuntimeStore.getState().setSelection('session-ring', {
      providerId: null,
      modelId: 'alpha',
      effortLevel: 'max',
    })

    const { container } = render(<ModelSelector runtimeKey="session-ring" />)
    const [modelHalf, effortHalf] = [...container.querySelectorAll('button')]

    // The ring traces `border-radius`. Each half is rounded on one side only,
    // so without this the focused half drew a box that was round down one edge
    // and square down the other.
    expect(modelHalf).toHaveClass('rounded-l-[var(--radius-md)]', 'focus-visible:rounded-[var(--radius-md)]')
    expect(effortHalf).toHaveClass('rounded-r-[var(--radius-md)]', 'focus-visible:rounded-[var(--radius-md)]')
  })

  // On the phone composer this control sits between two 44px buttons and opens
  // a bottom sheet. `compact` cannot drive the height: the desktop composer
  // also sets it, and there it narrows for the right panel, not for touch.
  it.each([
    ['browser H5', { isMobileViewport: true, isDesktopRuntime: false }, true],
    ['desktop compact composer', { isMobileViewport: false, isDesktopRuntime: false }, false],
    ['narrow Electron window', { isMobileViewport: true, isDesktopRuntime: true }, false],
  ])('stretches both halves to the 44px touch target only on %s', (_name, runtime, expected) => {
    Object.assign(runtimeMocks, runtime)
    useSettingsStore.setState({
      locale: 'en',
      availableModels: MODELS,
      currentModel: MODELS[0],
      activeProviderName: 'Provider A',
      effortLevel: 'max',
    })
    useProviderStore.setState({ hasLoadedProviders: true, isLoading: false })
    useSessionRuntimeStore.getState().setSelection('session-touch', {
      providerId: null,
      modelId: 'alpha',
      effortLevel: 'max',
    })

    const { container } = render(<ModelSelector runtimeKey="session-touch" compact />)
    const segmented = container.querySelector('[data-testid="model-selector-shell"] > div')

    expect(segmented).toHaveClass('items-stretch')
    expect(segmented?.classList.contains('min-h-11')).toBe(expected)
  })

  it('keeps every CLI effort stop scoped to the selected session', async () => {
    const setSessionRuntime = vi.fn()
    useSettingsStore.setState({
      locale: 'en',
      availableModels: MODELS,
      currentModel: MODELS[0],
      activeProviderName: 'Kimi',
      effortLevel: 'max',
    })
    useProviderStore.setState({
      providers: [{
        id: 'kimi-provider',
        presetId: 'kimi',
        name: 'Kimi',
        apiKey: '***',
        baseUrl: 'https://api.kimi.com/coding/',
        apiFormat: 'anthropic',
        models: {
          main: 'k3',
          haiku: 'k3',
          sonnet: 'k3',
          opus: 'k3',
        },
      }],
      activeId: 'kimi-provider',
      hasLoadedProviders: true,
      isLoading: true,
    })
    useSessionRuntimeStore.getState().setSelection('session-1', {
      providerId: 'kimi-provider',
      modelId: 'k3',
      effortLevel: 'max',
    })
    useSessionRuntimeStore.getState().setSelection('session-2', {
      providerId: 'kimi-provider',
      modelId: 'k3',
      effortLevel: 'max',
    })
    useChatStore.setState({
      setSessionRuntime,
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    render(<ModelSelector runtimeKey="session-1" />)

    await clickByRole('Effort: Max')
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Effort' }), { key: 'ArrowLeft' })

    expect(useSessionRuntimeStore.getState().selections['session-1']).toEqual({
      providerId: 'kimi-provider',
      modelId: 'k3',
      effortLevel: 'xhigh',
    })
    expect(useSessionRuntimeStore.getState().selections['session-2']).toEqual({
      providerId: 'kimi-provider',
      modelId: 'k3',
      effortLevel: 'max',
    })
    expect(setSessionRuntime).toHaveBeenCalledWith('session-1', {
      providerId: 'kimi-provider',
      modelId: 'k3',
      effortLevel: 'xhigh',
    })
    expect(useSettingsStore.getState().effortLevel).toBe('max')
  })

  it('keeps effort selectable for unlisted Claude models from compatible providers', async () => {
    const setSessionRuntime = vi.fn()
    useSettingsStore.setState({
      locale: 'en',
      availableModels: [],
      currentModel: null,
      activeProviderName: 'XuanShu API',
      effortLevel: 'high',
    })
    useProviderStore.setState({
      providers: [{
        id: 'xuanshuapi-provider',
        presetId: 'xuanshuapi',
        name: 'XuanShu API',
        apiKey: '***',
        baseUrl: 'https://www.xuanshuapi.com',
        apiFormat: 'anthropic',
        models: {
          main: 'claude-opus-5',
          haiku: 'claude-haiku-4-5',
          sonnet: 'claude-sonnet-5',
          opus: 'claude-opus-5',
        },
      }],
      activeId: 'xuanshuapi-provider',
      hasLoadedProviders: true,
      isLoading: false,
    })
    useSessionRuntimeStore.getState().setSelection('session-claude-future', {
      providerId: 'xuanshuapi-provider',
      modelId: 'claude-opus-5',
      effortLevel: 'high',
    })
    useChatStore.setState({
      setSessionRuntime,
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    render(<ModelSelector runtimeKey="session-claude-future" />)

    expect(screen.getByRole('button', { name: 'Effort: High' })).toBeInTheDocument()
    await clickByRole('Effort: High')
    expect(screen.getAllByTestId('reasoning-effort-stop')).toHaveLength(5)
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Effort' }), { key: 'ArrowRight' })

    const expectedSelection = {
      providerId: 'xuanshuapi-provider',
      modelId: 'claude-opus-5',
      effortLevel: 'xhigh',
    }
    expect(useSessionRuntimeStore.getState().selections['session-claude-future']).toEqual(
      expectedSelection,
    )
    expect(setSessionRuntime).toHaveBeenCalledWith('session-claude-future', expectedSelection)

    await clickByRole('claude-opus-5, XuanShu API')
    await clickByRole(/claude-sonnet-5/i)

    expect(screen.getByRole('button', { name: 'Effort: X-High' })).toBeInTheDocument()
    expect(useSessionRuntimeStore.getState().selections['session-claude-future']).toEqual({
      providerId: 'xuanshuapi-provider',
      modelId: 'claude-sonnet-5',
      effortLevel: 'xhigh',
    })
  })

  it('keeps effort selectable for OpenAI Responses models from compatible providers', async () => {
    useSettingsStore.setState({
      locale: 'en',
      availableModels: [],
      currentModel: null,
      activeProviderName: 'Sub2API-ChatGPT',
      effortLevel: 'high',
    })
    useProviderStore.setState({
      providers: [{
        id: 'sub2api-provider',
        presetId: 'custom',
        name: 'Sub2API-ChatGPT',
        apiKey: '***',
        baseUrl: 'https://api.example.com/v1',
        apiFormat: 'openai_responses',
        models: {
          main: 'gpt-5.6-sol',
          haiku: 'gpt-5.6-luna',
          sonnet: 'gpt-5.6-terra',
          opus: 'gpt-5.6-sol',
        },
      }],
      activeId: 'sub2api-provider',
      hasLoadedProviders: true,
      isLoading: false,
    })
    useSessionRuntimeStore.getState().setSelection('session-openai-compatible', {
      providerId: 'sub2api-provider',
      modelId: 'gpt-5.6-sol',
      effortLevel: 'high',
    })

    render(<ModelSelector runtimeKey="session-openai-compatible" />)

    expect(screen.getByRole('button', { name: 'Effort: High' })).toBeInTheDocument()
    await clickByRole('Effort: High')
    expect(screen.getAllByTestId('reasoning-effort-stop')).toHaveLength(5)
  })

  it('does not offer an effort control that a direct provider has explicitly disabled', () => {
    useSettingsStore.setState({
      locale: 'en',
      availableModels: [],
      currentModel: null,
      activeProviderName: 'Direct GPT Gateway',
      effortLevel: 'high',
    })
    useProviderStore.setState({
      providers: [{
        id: 'direct-gpt-provider',
        presetId: 'custom',
        name: 'Direct GPT Gateway',
        apiKey: '***',
        baseUrl: 'https://api.example.com',
        apiFormat: 'anthropic',
        disableExperimentalBetas: true,
        models: {
          main: 'gpt-5.6-sol',
          haiku: 'gpt-5.6-sol',
          sonnet: 'gpt-5.6-sol',
          opus: 'gpt-5.6-sol',
        },
      }],
      activeId: 'direct-gpt-provider',
      hasLoadedProviders: true,
      isLoading: false,
    })
    useSessionRuntimeStore.getState().setSelection('session-direct-disabled-effort', {
      providerId: 'direct-gpt-provider',
      modelId: 'gpt-5.6-sol',
      effortLevel: 'xhigh',
    })

    render(<ModelSelector runtimeKey="session-direct-disabled-effort" />)

    expect(screen.getByRole('button', { name: 'gpt-5.6-sol, Direct GPT Gateway' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Effort:/ })).not.toBeInTheDocument()
  })

  it('uses the ChatGPT Official catalog when that built-in provider is active', async () => {
    const openAIModels: ModelInfo[] = [
      {
        id: 'gpt-5.3-codex',
        name: 'GPT-5.3 Codex',
        description: 'Best for coding and agentic work',
        context: '',
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      },
      {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        description: 'Latest general-purpose model',
        context: '',
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      },
    ]
    const setSessionRuntime = vi.fn()
    useHahaOpenAIOAuthStore.setState({
      status: { loggedIn: true, expiresAt: null, email: null, accountId: null },
      fetchStatus: async () => {},
    })
    useSettingsStore.setState({
      locale: 'en',
      availableModels: openAIModels,
      currentModel: openAIModels[0],
      activeProviderName: 'ChatGPT Official',
    })
    useProviderStore.setState({
      providers: [],
      activeId: OPENAI_OFFICIAL_PROVIDER_ID,
      hasLoadedProviders: true,
      isLoading: true,
    })
    useChatStore.setState({
      setSessionRuntime,
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    render(<ModelSelector runtimeKey="session-openai" />)

    await clickByRole(/GPT-5\.3 Codex/i)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /GPT-5\.5/ }))
      await Promise.resolve()
    })

    expect(useSessionRuntimeStore.getState().selections['session-openai']).toEqual({
      providerId: OPENAI_OFFICIAL_PROVIDER_ID,
      modelId: 'gpt-5.5',
      effortLevel: 'medium',
    })
    expect(setSessionRuntime).toHaveBeenCalledWith('session-openai', {
      providerId: OPENAI_OFFICIAL_PROVIDER_ID,
      modelId: 'gpt-5.5',
      effortLevel: 'medium',
    })
  })

  it('uses each ChatGPT model reasoning catalog and resets unsupported effort to its default', async () => {
    const openAIModels: ModelInfo[] = [
      {
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6-Sol',
        description: 'Frontier model',
        context: '353400',
        defaultReasoningEffort: 'low',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        description: 'General model',
        context: '258400',
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      },
    ]
    useHahaOpenAIOAuthStore.setState({
      status: { loggedIn: true, expiresAt: null, email: null, accountId: null },
      fetchStatus: async () => {},
    })
    useSettingsStore.setState({
      locale: 'en',
      availableModels: openAIModels,
      currentModel: openAIModels[0],
      activeProviderName: 'ChatGPT Official',
      effortLevel: 'max',
    })
    useProviderStore.setState({
      providers: [],
      activeId: OPENAI_OFFICIAL_PROVIDER_ID,
      hasLoadedProviders: true,
      isLoading: true,
    })
    useSessionRuntimeStore.getState().setSelection('session-openai-effort', {
      providerId: OPENAI_OFFICIAL_PROVIDER_ID,
      modelId: 'gpt-5.6-sol',
      effortLevel: 'max',
    })

    render(<ModelSelector runtimeKey="session-openai-effort" />)

    expect(screen.getByRole('button', { name: 'GPT-5.6-Sol, ChatGPT Official' })).toHaveAttribute(
      'title',
      'ChatGPT Official · GPT-5.6-Sol',
    )
    expect(screen.queryByTestId('model-provider-badge')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Effort: Max' })).toBeInTheDocument()
    await clickByRole('Effort: Max')
    expect(screen.getByRole('slider', { name: 'Effort' })).toHaveAttribute('aria-valuemax', '4')
    expect(screen.getAllByTestId('reasoning-effort-stop')).toHaveLength(5)
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Effort' }), { key: 'Escape' })

    await clickByRole(/GPT-5\.6-Sol/i)
    await clickByRole(/GPT-5\.5/)

    expect(useSessionRuntimeStore.getState().selections['session-openai-effort']).toEqual({
      providerId: OPENAI_OFFICIAL_PROVIDER_ID,
      modelId: 'gpt-5.5',
      effortLevel: 'medium',
    })

    expect(screen.getByRole('button', { name: 'Effort: Medium' })).toBeInTheDocument()
    await clickByRole('Effort: Medium')
    expect(screen.getByRole('slider', { name: 'Effort' })).toHaveAttribute('aria-valuemax', '3')
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Effort' }), { key: 'End' })
    expect(screen.getByRole('slider', { name: 'Effort' })).toHaveAttribute('aria-valuetext', 'X-High')

    expect(useSessionRuntimeStore.getState().selections['session-openai-effort']).toEqual({
      providerId: OPENAI_OFFICIAL_PROVIDER_ID,
      modelId: 'gpt-5.5',
      effortLevel: 'xhigh',
    })
  })

  it('keeps xhigh when switching from GPT-5.6-Sol to a compatible Kimi provider', async () => {
    const solModel: ModelInfo = {
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6-Sol',
      description: 'Frontier model',
      context: '353400',
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    }
    const setSessionRuntime = vi.fn()
    useHahaOpenAIOAuthStore.setState({
      status: { loggedIn: true, expiresAt: null, email: null, accountId: null },
      fetchStatus: async () => {},
    })
    useSettingsStore.setState({
      locale: 'en',
      availableModels: [solModel],
      currentModel: solModel,
      activeProviderName: 'ChatGPT Official',
      effortLevel: 'max',
    })
    useProviderStore.setState({
      providers: [{
        id: 'kimi-provider',
        presetId: 'kimi',
        name: 'Kimi',
        apiKey: '***',
        baseUrl: 'https://api.kimi.com/coding/',
        apiFormat: 'anthropic',
        models: {
          main: 'k3',
          haiku: 'k3',
          sonnet: 'k3',
          opus: 'k3',
        },
      }],
      activeId: OPENAI_OFFICIAL_PROVIDER_ID,
      hasLoadedProviders: true,
      isLoading: true,
    })
    useSessionRuntimeStore.getState().setSelection('session-kimi-switch', {
      providerId: OPENAI_OFFICIAL_PROVIDER_ID,
      modelId: 'gpt-5.6-sol',
      effortLevel: 'xhigh',
    })
    useChatStore.setState({
      setSessionRuntime,
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    render(<ModelSelector runtimeKey="session-kimi-switch" />)

    await clickByRole(/GPT-5\.6-Sol/i)
    await clickByRole(/^k3/i)

    const expectedSelection = {
      providerId: 'kimi-provider',
      modelId: 'k3',
      effortLevel: 'xhigh',
    }
    expect(useSessionRuntimeStore.getState().selections['session-kimi-switch']).toEqual(
      expectedSelection,
    )
    expect(setSessionRuntime).toHaveBeenCalledWith('session-kimi-switch', expectedSelection)
    expect(screen.getByRole('button', { name: 'Effort: X-High' })).toBeInTheDocument()
  })

  it('selects Grok Official models for a logged-in runtime', async () => {
    const grokModels: ModelInfo[] = [{
      id: 'grok-4.5',
      name: 'Grok 4.5',
      description: 'Grok frontier text model',
      context: '',
      supportedReasoningEfforts: [],
    }]
    useHahaGrokOAuthStore.setState({
      status: { loggedIn: true, expiresAt: null, email: 'grok@example.com' },
      fetchStatus: async () => {},
    })
    useSettingsStore.setState({
      locale: 'en',
      availableModels: grokModels,
      currentModel: grokModels[0],
      activeProviderName: 'Grok Official',
    })
    useProviderStore.setState({
      providers: [],
      activeId: 'grok-official',
      hasLoadedProviders: true,
      isLoading: false,
    })

    render(<ModelSelector runtimeKey="session-grok" />)
    await clickByRole(/Grok 4\.5/i)
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Grok 4\.5/i })[1]!)
      await Promise.resolve()
    })

    expect(useSessionRuntimeStore.getState().selections['session-grok']).toMatchObject({
      providerId: 'grok-official',
      modelId: 'grok-4.5',
    })
    expect(screen.queryByRole('button', { name: /Effort:/i })).not.toBeInTheDocument()
  })

  it('replaces a stale Grok runtime model with the current official default', async () => {
    const grokModels: ModelInfo[] = [{
      id: 'grok-4.6',
      name: 'Grok 4.6',
      description: "SpaceXAI's latest frontier model",
      context: '500000',
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: ['xhigh', 'high', 'medium', 'low'],
    }]
    useHahaGrokOAuthStore.setState({
      status: { loggedIn: true, expiresAt: null, email: 'grok@example.com' },
      fetchStatus: async () => {},
    })
    useSettingsStore.setState({
      locale: 'en',
      availableModels: grokModels,
      currentModel: grokModels[0],
      activeProviderName: 'Grok Official',
      effortLevel: 'max',
    })
    useProviderStore.setState({
      providers: [],
      activeId: 'grok-official',
      hasLoadedProviders: true,
      isLoading: false,
    })
    useSessionRuntimeStore.getState().setSelection('session-stale-grok', {
      providerId: 'grok-official',
      modelId: 'grok-build',
      effortLevel: 'max',
    })
    render(<ModelSelector runtimeKey="session-stale-grok" />)

    expect(screen.queryByText('grok-build')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Grok 4.6, Grok Official' })).toBeInTheDocument()
    await waitFor(() => {
      expect(useSessionRuntimeStore.getState().selections['session-stale-grok']).toEqual({
        providerId: 'grok-official',
        modelId: 'grok-4.6',
        effortLevel: 'high',
      })
    })
  })

  it('hides official provider sections when OAuth is not logged in', async () => {
    useHahaOAuthStore.setState({ status: { loggedIn: false }, fetchStatus: async () => {} })
    useHahaOpenAIOAuthStore.setState({ status: { loggedIn: false }, fetchStatus: async () => {} })
    useHahaGrokOAuthStore.setState({ status: { loggedIn: false }, fetchStatus: async () => {} })
    useSettingsStore.setState({
      locale: 'en',
      availableModels: MODELS,
      currentModel: MODELS[0],
      activeProviderName: 'Provider A',
    })
    useProviderStore.setState({
      providers: [{
        id: 'provider-a',
        presetId: 'custom',
        name: 'Provider A',
        apiKey: '***',
        baseUrl: 'https://api.example.com',
        apiFormat: 'anthropic',
        models: {
          main: 'provider-main',
          haiku: '',
          sonnet: '',
          opus: '',
        },
      }],
      activeId: 'provider-a',
      hasLoadedProviders: true,
      isLoading: true,
    })

    render(<ModelSelector runtimeKey="session-hide" />)

    await clickByRole(/provider-main/i)

    const dropdown = screen.getByTestId('model-selector-dropdown')
    expect(dropdown.textContent).not.toContain('Claude Official')
    expect(dropdown.textContent).not.toContain('ChatGPT Official')
    expect(dropdown.textContent).toContain('Provider A')
  })

  it('portals the dropdown outside clipping containers and positions it below the trigger', async () => {
    useSettingsStore.setState({
      locale: 'en',
      availableModels: MODELS,
      currentModel: MODELS[0],
    })

    const { container } = render(
      <div data-testid="scroll-container" className="overflow-hidden">
        <ModelSelector value="alpha" onChange={vi.fn()} />
      </div>,
    )

    const trigger = screen.getByRole('button', { name: /alpha/i })
    Object.defineProperty(trigger.parentElement, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: 120,
        right: 520,
        bottom: 150,
        left: 240,
        width: 280,
        height: 30,
        x: 240,
        y: 120,
        toJSON: () => {},
      }),
    })

    await act(async () => {
      fireEvent.click(trigger)
      await Promise.resolve()
    })

    const dropdown = screen.getByTestId('model-selector-dropdown')
    expect(container.contains(dropdown)).toBe(false)
    expect(document.body.contains(dropdown)).toBe(true)
    expect(dropdown.className).toContain('fixed')
    expect(dropdown.style.top).toBe('158px')
    expect(dropdown.style.left).toBe('160px')
    expect(dropdown.style.width).toBe('360px')
  })
})
