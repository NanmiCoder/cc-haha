import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserHost } from '@/lib/desktopHost/browserHost'
import { useSettingsStore } from '@/stores/settingsStore'
import { createNetworkFixture } from '../testing/networkFixture'
import { createDefaultNetworkProfiles, type SakuraDiscovery } from '../networkTypes'
import { effectiveNetworkProfile, profileParameterReference, safeReferenceValue } from '../executionReference'
import { useSakuraDiscovery } from '../useSakuraDiscovery'
import { NetworkManagerPanel } from './NetworkManagerPanel'
import { NetworkExecutionReference } from './NetworkExecutionReference'

function running(port = 7897): SakuraDiscovery {
  const selected = { pid: 102, startedAt: '2026-09-27T01:00:00Z', executablePath: 'C:\\Fixture\\com.vortex.helper.exe', clientExecutable: 'C:\\Fixture\\SakuraCat.exe', configPath: 'C:\\Fixture\\running.yaml', controller: '127.0.0.1:39798', listeningPorts: [port, 39798], configSource: 'process-argument' as const }
  return { status: 'detected', running: true, checkedAt: selected.startedAt, proxyPort: port, selected, candidates: [selected], issues: [] }
}
beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  window.desktopHost = { ...browserHost, hostManagement: { ...browserHost.hostManagement, listHosts: vi.fn(async () => ({ ok: true as const, data: [] })) } }
})
afterEach(() => { cleanup(); delete window.desktopHost })

describe('Sakura automatic fields and execution reference', () => {
  it('displays running paths read-only, needs no save, and checks using discovered values', async () => {
    const fixture = createNetworkFixture()
    Object.assign(fixture.discovery, running())
    render(<NetworkManagerPanel api={fixture.api} />)
    await screen.findByText('Running instance identified')
    const paths = screen.getByTestId('sakura-runtime-fields')
    expect(within(paths).getByDisplayValue('C:\\Fixture\\running.yaml')).toHaveAttribute('readonly')
    expect(within(paths).getByDisplayValue('C:\\Fixture\\SakuraCat.exe')).toHaveAttribute('readonly')
    expect(within(paths).getAllByRole('button')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Choose config file' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Start SakuraCat' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Validate proxy' }))
    await waitFor(() => expect(fixture.calls.find(call => call.action === 'inspect')?.input).toMatchObject({ proxyConfigPath: 'C:\\Fixture\\running.yaml', sakuraExecutable: 'C:\\Fixture\\SakuraCat.exe' }))
    fireEvent.click(screen.getByRole('button', { name: 'Inspect and preview changes' }))
    await waitFor(() => expect(fixture.calls.find(call => call.action === 'plan')?.input).toMatchObject({ proxyConfigPath: 'C:\\Fixture\\running.yaml' }))
    expect(fixture.calls.some(call => ['save', 'login', 'apply'].includes(call.action))).toBe(false)
  })

  it('preserves manual fallback on incomplete discovery without claiming the app is stopped', async () => {
    const fixture = createNetworkFixture()
    Object.assign(fixture.discovery, { ...running(), status: 'incomplete', selected: null, issues: ['SAKURA_CONFIG_UNCONFIRMED'] })
    render(<NetworkManagerPanel api={fixture.api} />)
    await screen.findByText('Running; paths need verification')
    expect(screen.getByRole('button', { name: 'Start SakuraCat' })).toBeDisabled()
    const pathInputs = within(screen.getByTestId('sakura-runtime-fields')).getAllByRole('textbox')
    expect(pathInputs).toHaveLength(2)
    expect(pathInputs.every(input => !input.hasAttribute('readonly'))).toBe(true)
  })

  it('loads reference only on expansion and never calls apply/inspect/login', async () => {
    const fixture = createNetworkFixture()
    const profile = createDefaultNetworkProfiles()[0]
    render(<NetworkExecutionReference api={fixture.api} stage="physical" profile={profile} />)
    expect(fixture.calls).toHaveLength(0)
    fireEvent.click(screen.getByText('Parameters and execution reference'))
    await screen.findByText('Isolated fixture executor')
    const reference = screen.getByTestId('network-reference-physical')
    expect(within(reference).getByText('gatewayAddress')).toBeVisible()
    expect(within(reference).getByText('191.168.7.62')).toBeVisible()
    fireEvent.click(within(reference).getByText('snapshot · Read only'))
    expect(within(reference).getByText('Get-NetIPInterface # fixture only')).toBeVisible()
    expect(fixture.calls.map(call => call.action)).toEqual(['executionCatalog'])
  })

  it('covers every profile field and redacts URLs/credentials in diagnostic JSON', () => {
    const profile = createDefaultNetworkProfiles()[0]
    expect(Object.keys(profileParameterReference).sort()).toEqual(Object.keys(profile).sort())
    expect(safeReferenceValue({ url: 'https://user:password@example.test/path?token=SECRET#PRIVATE', secret: 'SECRET', commandLine: '-secret SECRET' })).not.toMatch(/SECRET|PRIVATE|user:password/)
    expect(effectiveNetworkProfile(profile, running(7898))).toBe(profile)
    expect(effectiveNetworkProfile(profile, running()).proxyConfigPath).toBe('C:\\Fixture\\running.yaml')
    expect(profile.proxyConfigPath).toBe('')
  })

  it('ignores stale detection after editing the proxy port', async () => {
    const fixture = createNetworkFixture()
    let release!: (value: { ok: true; data: SakuraDiscovery }) => void
    fixture.api.discoverProxy = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve })).mockResolvedValue({ ok: true, data: running(7898) })
    const { result, rerender } = renderHook(({ port }) => useSakuraDiscovery(fixture.api, port), { initialProps: { port: 7897 } })
    rerender({ port: 7898 })
    await waitFor(() => expect(result.current.discovery?.proxyPort).toBe(7898))
    await act(async () => { release({ ok: true, data: running(7897) }) })
    expect(result.current.discovery?.proxyPort).toBe(7898)
  })
})
