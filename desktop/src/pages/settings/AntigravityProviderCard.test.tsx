import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computerUseApi } from '@/api/computerUse'
import { ANTIGRAVITY_ACP_LOGIN_COMMAND, ANTIGRAVITY_ACP_PROVIDER_ID } from '@/constants/antigravityAcp'
import { ANTIGRAVITY_ENABLED_STORAGE_KEY } from '@/lib/antigravityPreferences'
import { useProviderStore } from '@/stores/providerStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import type { AntigravityStatus } from '@/types/provider'
import type { PermissionMode } from '@/types/settings'
import { AntigravityProviderCard } from './AntigravityProviderCard'

function makeStatus(overrides: Partial<AntigravityStatus> = {}): AntigravityStatus {
  return {
    id: ANTIGRAVITY_ACP_PROVIDER_ID,
    kind: 'acp',
    status: 'ready',
    models: [
      { id: 'gemini-3.8-pro', name: 'Gemini 3.8 Pro', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'high' },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', supportedReasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' },
    ],
    currentModelId: 'gemini-3.8-pro',
    currentEffortLevel: 'high',
    version: '1.5.17',
    tier: { id: 'pro', name: 'Google AI Pro' },
    ...overrides,
  }
}

describe('AntigravityProviderCard', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
    useSettingsStore.setState({
      locale: 'en',
      permissionMode: 'default',
      setPermissionMode: vi.fn().mockImplementation(async (permissionMode: PermissionMode) => {
        useSettingsStore.setState({ permissionMode })
      }),
    })
    useProviderStore.setState(useProviderStore.getInitialState(), true)
    useUIStore.setState(useUIStore.getInitialState(), true)
    vi.spyOn(computerUseApi, 'getAuthorizedApps').mockResolvedValue({
      enabled: true,
      consentAcceptedAt: '2026-11-26T00:00:00.000Z',
    } as never)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
    window.localStorage.clear()
  })

  it('renders nothing when the server does not advertise antigravity status', () => {
    useProviderStore.setState({ antigravity: undefined })
    const { container } = render(<AntigravityProviderCard />)
    expect(container.firstChild).toBeNull()
  })

  it('shows ready status, version, tier, refresh action, enable switch, and Computer Use bridge status', async () => {
    const discover = vi.fn(async () => makeStatus())
    useProviderStore.setState({
      antigravity: makeStatus(),
      antigravityEnabled: true,
      discoverAntigravity: discover,
    })

    render(<AntigravityProviderCard />)

    expect(screen.getByText('Local agent runtimes')).toBeInTheDocument()
    expect(screen.getByText('Antigravity')).toBeInTheDocument()
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.getByText('1.5.17')).toBeInTheDocument()
    expect(screen.getByText('Google AI Pro')).toBeInTheDocument()
    expect(screen.getByText('Connected · 2 models available.')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText('Enabled')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }))
    await waitFor(() => {
      expect(discover).toHaveBeenCalledTimes(1)
    })

    const enableSwitch = screen.getByRole('switch', { name: 'Show Antigravity in new sessions' })
    expect(enableSwitch).toBeChecked()
    fireEvent.click(enableSwitch)
    expect(useProviderStore.getState().antigravityEnabled).toBe(false)
    expect(window.localStorage.getItem(ANTIGRAVITY_ENABLED_STORAGE_KEY)).toBe('0')

    fireEvent.click(screen.getByRole('button', { name: 'Computer Use settings' }))
    expect(useUIStore.getState().activeSettingsTab).toBe('computerUse')
  })

  it('shows agy acp --login instructions when authentication is required', () => {
    useProviderStore.setState({
      antigravity: makeStatus({ status: 'login_required', models: [] }),
    })

    render(<AntigravityProviderCard />)

    expect(screen.getByText('Sign in required')).toBeInTheDocument()
    expect(screen.getByText(ANTIGRAVITY_ACP_LOGIN_COMMAND)).toBeInTheDocument()
  })

  it('disables the enable switch when agy is not installed', () => {
    useProviderStore.setState({
      antigravity: makeStatus({ status: 'not_installed', models: [], version: undefined, tier: undefined }),
      antigravityEnabled: true,
    })

    render(<AntigravityProviderCard />)

    expect(screen.getByText('Not installed')).toBeInTheDocument()
    const enableSwitch = screen.getByRole('switch', { name: 'Show Antigravity in new sessions' })
    expect(enableSwitch).toBeDisabled()
    expect(enableSwitch).not.toBeChecked()
  })

  it('displays the universal default permission and syncs Auto and Turbo (bypassPermissions) updates to settingsStore', async () => {
    useProviderStore.setState({
      antigravity: makeStatus(),
      antigravityEnabled: true,
    })
    useSettingsStore.setState({ permissionMode: 'acceptEdits' })

    render(<AntigravityProviderCard />)

    const row = screen.getByTestId('antigravity-default-permission-row')
    expect(within(row).getByText('Default permission for new sessions')).toBeInTheDocument()
    const trigger = within(row).getByRole('button', { name: 'Auto accept' })

    // Selecting Auto skips the Claude-only Auto opt-in dialog and updates the universal default directly.
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /^Auto\b/ }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(useSettingsStore.getState().setPermissionMode).toHaveBeenCalledWith('auto')
    expect(useSettingsStore.getState().permissionMode).toBe('auto')

    // Selecting Turbo (bypassPermissions) requires confirmation and syncs back to settingsStore.
    fireEvent.click(within(row).getByRole('button', { name: 'Auto mode' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Turbo/ }))
    const dialog = screen.getByRole('dialog', { name: 'Enable bypass permissions?' })
    expect(within(dialog).getByText('Each new session workspace')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Enable bypass' }))
    await waitFor(() => {
      expect(useSettingsStore.getState().setPermissionMode).toHaveBeenCalledWith('bypassPermissions')
      expect(useSettingsStore.getState().permissionMode).toBe('bypassPermissions')
    })
    expect(within(row).getByRole('button', { name: 'Turbo' })).toBeInTheDocument()
  })
})
