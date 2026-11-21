import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'

import { ModelSelector } from './ModelSelector'
import { useHahaOAuthStore } from '../../stores/hahaOAuthStore'
import { useHahaOpenAIOAuthStore } from '../../stores/hahaOpenAIOAuthStore'
import { useHahaGrokOAuthStore } from '../../stores/hahaGrokOAuthStore'
import { useHahaDeepSeekOAuthStore } from '../../stores/hahaDeepSeekOAuthStore'
import { useProviderStore } from '../../stores/providerStore'
import { useSessionRuntimeStore } from '../../stores/sessionRuntimeStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'

beforeEach(() => {
  useHahaOAuthStore.setState({ status: { loggedIn: true } as never, fetchStatus: async () => {} })
  useHahaOpenAIOAuthStore.setState({ fetchStatus: async () => {} })
  useHahaGrokOAuthStore.setState({ fetchStatus: async () => {} })
  useHahaDeepSeekOAuthStore.setState({ fetchStatus: async () => {} })
  useProviderStore.setState({ activeId: null, hasLoadedProviders: true, isLoading: false, providers: [] })
})

afterEach(() => {
  cleanup()
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  useProviderStore.setState(useProviderStore.getInitialState(), true)
  useSessionRuntimeStore.setState(useSessionRuntimeStore.getInitialState(), true)
  useHahaOAuthStore.setState(useHahaOAuthStore.getInitialState(), true)
  useHahaOpenAIOAuthStore.setState(useHahaOpenAIOAuthStore.getInitialState(), true)
  useHahaGrokOAuthStore.setState(useHahaGrokOAuthStore.getInitialState(), true)
  useHahaDeepSeekOAuthStore.setState(useHahaDeepSeekOAuthStore.getInitialState(), true)
  useUIStore.setState(useUIStore.getInitialState(), true)
  vi.restoreAllMocks()
})

describe('ModelSelector Claude fast mode controls', () => {
  it('enables the composer Fast toggle and popover switch on a supported Claude model', async () => {
    const setFastMode = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ locale: 'en', fastMode: false, setFastMode })
    useSessionRuntimeStore.getState().setSelection('sess-fast', {
      providerId: null,
      modelId: 'claude-opus-5-5',
      effortLevel: 'high',
    })

    render(<ModelSelector runtimeKey="sess-fast" />)

    const toggle = screen.getByTestId('claude-fast-mode-toggle')
    expect(toggle).not.toBeDisabled()
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    await act(async () => {
      fireEvent.click(toggle)
      await Promise.resolve()
    })
    expect(setFastMode).toHaveBeenCalledWith(true)

    // Popover also exposes the Claude Fast mode switch
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Effort: High/ }))
      await Promise.resolve()
    })
    const popover = screen.getByTestId('reasoning-effort-popover')
    expect(within(popover).getByRole('switch', { name: 'Fast mode' })).not.toBeDisabled()
  })

  it('disables Fast controls and shows unsupported reason on an unsupported Claude model', async () => {
    useSettingsStore.setState({ locale: 'en', fastMode: true })
    useSessionRuntimeStore.getState().setSelection('sess-sonnet', {
      providerId: null,
      modelId: 'claude-sonnet-5-5',
      effortLevel: 'high',
    })

    render(<ModelSelector runtimeKey="sess-sonnet" />)

    const toggle = screen.getByTestId('claude-fast-mode-toggle')
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(toggle).toHaveAttribute('title', 'Current model does not support fast mode')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Effort: High/ }))
      await Promise.resolve()
    })
    const popover = screen.getByTestId('reasoning-effort-popover')
    expect(within(popover).getByRole('switch', { name: 'Fast mode' })).toBeDisabled()
    expect(within(popover).getByText('Current model does not support fast mode')).toBeInTheDocument()
  })

  it('notifies user of auto-degradation when switching from supported to unsupported model while fast mode is on', async () => {
    useSettingsStore.setState({ locale: 'en', fastMode: true })
    useSessionRuntimeStore.getState().setSelection('sess-switch', {
      providerId: null,
      modelId: 'claude-opus-5-5',
      effortLevel: 'high',
    })

    render(<ModelSelector runtimeKey="sess-switch" />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Opus 5.5, Claude Official' }))
      await Promise.resolve()
    })
    const dropdown = within(screen.getByTestId('model-selector-dropdown'))
    fireEvent.click(dropdown.getByRole('button', { name: /^Sonnet 5\.5/ }))

    expect(useUIStore.getState().toasts.at(-1)?.message).toContain('Sonnet 5.5 does not support fast mode')
  })

  it('hides Claude fast mode toggle in controlled pickers without runtimeKey (e.g. team member / delegation)', () => {
    useSettingsStore.setState({ locale: 'en', fastMode: true })

    render(
      <ModelSelector
        value="claude-opus-5-5"
        onChange={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('claude-fast-mode-toggle')).not.toBeInTheDocument()
  })

  it('shows disabled Fast toggle for custom Anthropic provider on unsupported Claude model and hides for non-Claude or experimental-betas-disabled providers', () => {
    useSettingsStore.setState({ locale: 'en', fastMode: false })
    useProviderStore.setState({
      activeId: 'anthropic-custom',
      hasLoadedProviders: true,
      isLoading: false,
      providers: [
        {
          id: 'anthropic-custom',
          name: 'Custom Anthropic',
          protocol: 'anthropic',
          authType: 'api-key',
          apiKey: 'sk-test',
          baseUrl: 'https://api.anthropic.com',
          defaultModel: 'claude-sonnet-5-5',
          models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'glm-5'],
        } as never,
        {
          id: 'anthropic-no-betas',
          name: 'No Betas Proxy',
          protocol: 'anthropic',
          authType: 'api-key',
          apiKey: 'sk-test',
          baseUrl: 'https://proxy.example.com',
          disableExperimentalBetas: true,
          defaultModel: 'claude-opus-5-5',
          models: ['claude-opus-5-5'],
        } as never,
      ],
    })
    useSessionRuntimeStore.getState().setSelection('sess-custom-sonnet', {
      providerId: 'anthropic-custom',
      modelId: 'claude-sonnet-5-5',
      effortLevel: 'high',
    })
    useSessionRuntimeStore.getState().setSelection('sess-custom-glm', {
      providerId: 'anthropic-custom',
      modelId: 'glm-5',
      effortLevel: 'high',
    })
    useSessionRuntimeStore.getState().setSelection('sess-no-betas', {
      providerId: 'anthropic-no-betas',
      modelId: 'claude-opus-5-5',
      effortLevel: 'high',
    })

    const { rerender } = render(<ModelSelector runtimeKey="sess-custom-sonnet" />)
    expect(screen.getByTestId('claude-fast-mode-toggle')).toBeDisabled()

    rerender(<ModelSelector runtimeKey="sess-custom-glm" />)
    expect(screen.queryByTestId('claude-fast-mode-toggle')).not.toBeInTheDocument()

    rerender(<ModelSelector runtimeKey="sess-no-betas" />)
    expect(screen.queryByTestId('claude-fast-mode-toggle')).not.toBeInTheDocument()
  })
})
