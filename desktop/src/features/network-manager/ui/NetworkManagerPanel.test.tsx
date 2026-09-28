import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserHost } from '@/lib/desktopHost/browserHost'
import { useSettingsStore } from '@/stores/settingsStore'
import { createNetworkFixture } from '../testing/networkFixture'
import { NetworkManagerPanel } from './NetworkManagerPanel'

const host = { id: 'fixture-host', name: 'Fixture server', address: 'fixture.invalid', port: 2222, username: 'fixture', auth: { type: 'password' as const, credentialId: null }, tagIds: [], initialDirectory: null, applications: [], notes: '', revision: 1, createdAt: '', updatedAt: '' }

describe('network configuration workflow', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    window.desktopHost = { ...browserHost, hostManagement: { ...browserHost.hostManagement, listHosts: vi.fn(async () => ({ ok: true as const, data: [host] })) } }
  })
  it('passes proxy validation when an existing 10/8 DIRECT rule covers the container subnet', async () => {
    const fixture = createNetworkFixture()
    fixture.snapshot.proxy.bypassPrefixes = ['191.168.0.0/16', '10.0.0.0/8']
    render(<NetworkManagerPanel api={fixture.api} />)
    const validate = await screen.findByRole('button', { name: 'Validate proxy' })
    fireEvent.click(validate)
    await waitFor(() => expect(within(validate.closest('section')!).getByText('Validated')).toBeVisible())
  })
  afterEach(() => { cleanup(); delete window.desktopHost })
  it('keeps selecting work mode read-only and invalidates a preview on edits', async () => {
    const fixture = createNetworkFixture()
    render(<NetworkManagerPanel api={fixture.api} />)
    const profiles = await screen.findByRole('combobox', { name: 'Network profile' })
    fireEvent.change(profiles, { target: { value: 'work' } })
    expect(screen.queryByRole('button', { name: 'Open Windows VPN sign-in' })).toBeNull()
    expect(fixture.calls.filter(call => call.action !== 'vpnRouteOptions').map(call => call.action)).toEqual(['list', 'discoverProxy'])
    fireEvent.click(screen.getByRole('button', { name: 'Inspect and preview changes' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply this plan' })).not.toBeDisabled())
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Office ethernet' } })
    expect(screen.getByRole('button', { name: 'Apply this plan' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Inspect and preview changes' })).toBeDisabled()
    expect(fixture.calls.some(call => call.action === 'apply')).toBe(false)
  })
  it('uses left-side stage navigation and keeps validation actions independent', async () => {
    const fixture = createNetworkFixture()
    render(<div data-testid="network-scroll-host" style={{ height: 400, overflowY: 'auto' }}><NetworkManagerPanel api={fixture.api} /></div>)
    const navigation = await screen.findByRole('navigation', { name: 'Network configuration stages' })
    expect(navigation).toBeVisible()
    expect(within(navigation).queryByText('Check the interface, source address and next hop. Interface indexes are resolved during inspection.')).toBeNull()
    expect(within(navigation).queryByText(/If execution fails/)).toBeNull()
    expect(screen.getByTestId('network-stage-physical')).toHaveAttribute('aria-current', 'step')
    expect(screen.getByTestId('network-stage-plan')).toBeVisible()
    expect(screen.getByTestId('network-stage-verify')).toBeVisible()

    const scrollHost = screen.getByTestId('network-scroll-host')
    const scrollTo = vi.fn()
    Object.defineProperties(scrollHost, {
      scrollTop: { configurable: true, writable: true, value: 100 },
      scrollHeight: { configurable: true, value: 2000 },
      clientHeight: { configurable: true, value: 500 },
      scrollTo: { configurable: true, value: scrollTo },
    })
    const planButton = screen.getByTestId('network-stage-plan')
    const planSection = screen.getByRole('heading', { name: '5 · Preview and apply' }).closest('section')!
    Object.defineProperty(planButton, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 180 } as DOMRect) })
    Object.defineProperty(planSection, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 480 } as DOMRect) })

    fireEvent.click(planButton)
    expect(planButton).toHaveAttribute('aria-current', 'step')
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 400, behavior: 'smooth' })
    fireEvent.click(screen.getByTestId('network-stage-verify'))
    expect(screen.getByTestId('network-stage-verify')).toHaveAttribute('aria-current', 'step')
    fireEvent.click(screen.getByTestId('network-stage-physical'))

    fireEvent.click(screen.getByRole('button', { name: 'Validate physical network' }))
    await waitFor(() => expect(fixture.calls.filter(call => call.action === 'inspect')).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'Validate VPN' }))
    await waitFor(() => expect(fixture.calls.filter(call => call.action === 'inspect')).toHaveLength(2))

    fireEvent.click(screen.getByRole('button', { name: 'Validate proxy' }))
    await waitFor(() => expect(fixture.calls.filter(call => call.action === 'inspect')).toHaveLength(3))

    fireEvent.click(screen.getByRole('button', { name: 'Validate container network' }))
    await waitFor(() => expect(fixture.calls.filter(call => call.action === 'verify')).toHaveLength(1))
  })

  it('copies and saves a profile without changing the network, then applies only a reviewed plan id', async () => {
    const fixture = createNetworkFixture()
    render(<NetworkManagerPanel api={fixture.api} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Copy as new profile' }))
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Home hotspot' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    await screen.findByText('Profile saved; not applied.')
    expect(fixture.calls.filter(call => call.action === 'save')).toHaveLength(1)
    expect(fixture.calls.some(call => call.action === 'apply')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Inspect and preview changes' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply this plan' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: 'Apply this plan' }))
    await screen.findByRole('region', { name: 'Execution and rollback records' })
    expect(fixture.calls.find(call => call.action === 'apply')?.input).toBe('fixture-plan')
    expect(screen.queryByText('Verified')).toBeNull()
  })
  it('probes a managed host by id and clears old evidence when the selected host changes', async () => {
    const fixture = createNetworkFixture()
    render(<NetworkManagerPanel api={fixture.api} />)
    fireEvent.change(await screen.findByRole('combobox', { name: 'Choose a managed host' }), { target: { value: host.id } })
    fireEvent.click(screen.getByRole('button', { name: 'Test host TCP port' }))
    await screen.findByText('Verified')
    expect(fixture.calls.find(call => call.action === 'probeHost')?.input).toBe(host.id)
    expect(screen.getAllByText(/not SSH or application authentication/).length).toBeGreaterThan(0)
    fireEvent.change(screen.getByRole('combobox', { name: 'Choose a managed host' }), { target: { value: '' } })
    expect(screen.queryByText('Verified')).toBeNull()
  })
  it('distinguishes host-list errors from an empty library and recovers on refresh', async () => {
    const fixture = createNetworkFixture()
    const listHosts = vi.fn().mockResolvedValueOnce({ ok: false, error: { code: 'INTERNAL_ERROR' } }).mockResolvedValue({ ok: true, data: [host] })
    window.desktopHost!.hostManagement.listHosts = listHosts
    render(<NetworkManagerPanel api={fixture.api} />)
    await screen.findByText('Could not load hosts. Close and try again.')
    expect(screen.queryByText('No hosts available. Add one in Host management.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh hosts' }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Choose a managed host' })).not.toBeDisabled())
  })
  it('shows rollback conflicts and disables concurrent changes while an operation is pending', async () => {
    const fixture = createNetworkFixture()
    let release!: () => void
    fixture.api.plan = async () => {
      await new Promise<void>(resolve => { release = resolve })
      return { ok: true, data: { snapshot: fixture.snapshot, plan: fixture.plan } }
    }
    fixture.api.apply = async () => ({ ok: true, data: { planId: 'fixture-plan', status: 'rollback-conflict', completedChanges: ['vpn-split'], rollback: ['External modification preserved'], probes: [], issues: ['Manual recovery needed'] } })
    render(<NetworkManagerPanel api={fixture.api} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect and preview changes' }))
    expect(screen.getByLabelText('Profile name')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Start SakuraCat' })).toBeDisabled()
    release()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply this plan' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: 'Apply this plan' }))
    await screen.findByText('External modification preserved')
    expect(screen.getByText('Manual recovery needed')).toBeTruthy()
  })
  it('exposes recovery only for an unfinished operation and presents its result', async () => {
    const fixture = createNetworkFixture()
    fixture.snapshot.issues = ['RECOVERY_REQUIRED']
    render(<NetworkManagerPanel api={fixture.api} />)
    expect(screen.queryByRole('button', { name: 'Roll back these changes' })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect links' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Roll back these changes' }))
    await screen.findByText('vpn-split restored')
    expect(fixture.calls.some(call => call.action === 'recover')).toBe(true)
  })
  it('explains stale plans without treating the failed action as successful', async () => {
    const fixture = createNetworkFixture()
    fixture.api.apply = async () => ({ ok: false, error: { code: 'PLAN_STALE', message: 'PLAN_STALE' } })
    render(<NetworkManagerPanel api={fixture.api} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect and preview changes' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply this plan' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: 'Apply this plan' }))
    await screen.findByText('Network state or plan expired. Inspect and generate a new plan. (PLAN_STALE)')
    expect(screen.getByRole('button', { name: 'Apply this plan' })).toBeDisabled()
  })
})
