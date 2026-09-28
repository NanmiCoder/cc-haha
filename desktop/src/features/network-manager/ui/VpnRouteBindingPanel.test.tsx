import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { createDefaultNetworkProfiles } from '../networkTypes'
import { createNetworkFixture } from '../testing/networkFixture'
import { VpnRouteBindingPanel } from './VpnRouteBindingPanel'

beforeEach(() => useSettingsStore.setState({ locale: 'en' }))
afterEach(cleanup)

function setup() {
  const fixture = createNetworkFixture()
  render(<VpnRouteBindingPanel api={fixture.api} profile={createDefaultNetworkProfiles()[0]} disabled={false} defaultVpnName="124.114.142.77" defaultVpnScope="allUsers" />)
  const destinations = screen.getByRole('textbox', { name: 'Destination IPs or CIDR ranges' })
  const preview = screen.getByRole('button', { name: 'Preview VPN route' })
  const apply = screen.getByRole('button', { name: 'Apply reviewed route' })
  const verify = screen.getByRole('button', { name: 'Check actual route' })
  return { fixture, destinations, preview, apply, verify }
}

it('previews two IPs as one reviewed batch and applies only its plan id', async () => {
  const { fixture, destinations, preview, apply } = setup()
  await screen.findByRole('combobox', { name: 'Windows VPN' })
  fireEvent.change(destinations, { target: { value: '10.0.0.199\n10.0.0.200' } })
  fireEvent.click(preview)
  await waitFor(() => expect(apply).not.toBeDisabled())
  expect(fixture.calls.find(call => call.action === 'vpnRouteBatchPreview')?.input).toEqual({
    destinations: ['10.0.0.199', '10.0.0.200'], vpnName: '124.114.142.77', vpnScope: 'allUsers',
  })
  expect(screen.getByRole('group', { name: '10.0.0.199' })).toBeVisible()
  expect(screen.getByRole('group', { name: '10.0.0.200' })).toBeVisible()
  fireEvent.click(apply)
  await screen.findByText(/VPN route applied/)
  expect(fixture.calls.find(call => call.action === 'vpnRouteBatchApply')?.input).toBe('22222222-2222-4222-8222-222222222222')
  expect(apply).toBeDisabled()
})

it('accepts mixed IP and CIDR entries and invalidates the preview on edit or verification', async () => {
  const { fixture, destinations, preview, apply, verify } = setup()
  await screen.findByRole('combobox', { name: 'Windows VPN' })
  fireEvent.change(destinations, { target: { value: '10.0.0.199, 10.204.19.0/24' } })
  fireEvent.click(preview)
  await waitFor(() => expect(apply).not.toBeDisabled())
  expect(fixture.calls.find(call => call.action === 'vpnRouteBatchPreview')?.input).toMatchObject({
    destinations: ['10.0.0.199', '10.204.19.0/24'],
  })
  fireEvent.change(destinations, { target: { value: '10.0.0.199; 10.204.20.0/24' } })
  expect(apply).toBeDisabled()
  fireEvent.click(verify)
  await waitFor(() => expect(fixture.calls.some(call => call.action === 'vpnRouteBatchVerify')).toBe(true))
  expect(apply).toBeDisabled()
  expect(fixture.calls.some(call => call.action === 'vpnRouteBatchApply')).toBe(false)
})

it('blocks the entire batch when one destination conflicts and shows that item route', async () => {
  const { fixture, destinations, preview, apply } = setup()
  fixture.api.vpnRouteBatchPreview = async input => ({
    ok: true,
    data: {
      ...fixture.vpnRouteBatchPlan,
      canApply: false,
      items: [
        { ...fixture.vpnRoutePlan, destination: input.destinations[0]! },
        {
          ...fixture.vpnRoutePlan, destination: input.destinations[1]!, canApply: false,
          issues: ['VPN_ROUTE_CONFLICT'],
          conflicts: [{ prefix: '10.204.19.0/24', interfaceAlias: 'zjwj-arm62', store: 'active' }],
        },
      ],
    },
  })
  await screen.findByRole('combobox', { name: 'Windows VPN' })
  fireEvent.change(destinations, { target: { value: '10.0.0.199\n10.204.19.0/24' } })
  fireEvent.click(preview)
  const conflictingItem = await screen.findByRole('group', { name: '10.204.19.0/24' })
  const conflicts = within(conflictingItem).getByRole('group', { name: 'Competing or more-specific routes' })
  expect(within(conflicts).getByText(/zjwj-arm62/)).toBeVisible()
  expect(within(conflictingItem).getByText('Another Windows route overlaps this destination. Review the exact route before applying.')).toBeVisible()
  expect(apply).toBeDisabled()
})

it('rejects malformed or excessive lists before IPC and explains the field error', async () => {
  const { fixture, destinations, preview } = setup()
  await screen.findByRole('combobox', { name: 'Windows VPN' })
  fireEvent.change(destinations, { target: { value: '10.0.0.199\n10.0.0.bad' } })
  fireEvent.click(preview)
  expect(screen.getByRole('alert')).toHaveTextContent('Invalid IPv4 address or CIDR range: 10.0.0.bad')
  expect(fixture.calls.some(call => call.action === 'vpnRouteBatchPreview')).toBe(false)
  fireEvent.change(destinations, { target: { value: Array.from({ length: 33 }, (_, index) => `10.0.0.${index + 1}`).join('\n') } })
  await waitFor(() => expect(preview).not.toBeDisabled())
  fireEvent.click(preview)
  expect(await screen.findByRole('alert')).toHaveTextContent('Enter no more than 32 destinations.')
  expect(fixture.calls.some(call => call.action === 'vpnRouteBatchPreview')).toBe(false)
})

it('tests a concrete endpoint for a CIDR without treating the whole range as reachable', async () => {
  const { fixture, destinations } = setup()
  await screen.findByRole('combobox', { name: 'Windows VPN' })
  fireEvent.change(destinations, { target: { value: '10.204.19.0/24' } })
  expect(screen.getByRole('textbox', { name: 'Endpoint IP' })).toHaveValue('')
  fireEvent.change(screen.getByRole('textbox', { name: 'Endpoint IP' }), { target: { value: '10.204.19.81' } })
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Port' }), { target: { value: '8080' } })
  fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
  await waitFor(() => expect(fixture.calls.some(call => call.action === 'vpnRouteProbe')).toBe(true))
  expect(fixture.calls.find(call => call.action === 'vpnRouteProbe')?.input).toEqual({
    address: '10.204.19.81', port: 8080, protocol: 'http', vpnName: '124.114.142.77', vpnScope: 'allUsers',
  })
  expect(screen.getByTestId('vpn-route-probe-result')).toHaveTextContent('Endpoint responded')
  expect(screen.getByText('Windows selects the chosen VPN')).toBeVisible()
})

it('shows the chosen route and failure separately when the endpoint does not respond', async () => {
  const { fixture } = setup()
  fixture.api.vpnRouteProbe = async input => ({
    ok: true,
    data: {
      selected: { target: input.address, source: '162.168.1.2', interfaceAlias: 'Fixture VPN', prefix: '10.0.0.199/32' },
      viaVpn: true,
      probe: { target: input.address, port: input.port, kind: 'tcp', ok: false, checkedAt: '2026-09-26T00:00:00.000Z', latencyMs: 3000, detail: 'Timed out' },
      issues: [],
    },
  })
  await screen.findByRole('combobox', { name: 'Windows VPN' })
  fireEvent.change(screen.getByRole('textbox', { name: 'Endpoint IP' }), { target: { value: '10.0.0.199' } })
  fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
  expect(await screen.findByText('Windows selects the chosen VPN')).toBeVisible()
  expect(screen.getByTestId('vpn-route-probe-result')).toHaveTextContent('Endpoint did not respond')
  expect(screen.getByTestId('vpn-route-selection')).toHaveTextContent('Fixture VPN')
})

it('shows measured gateway and destination routes with separate SakuraCat DIRECT evidence and timestamps', async () => {
  const { fixture, destinations } = setup()
  fixture.api.inspect = async profile => {
    fixture.calls.push({ action: 'inspect', input: profile })
    return { ok: true, data: {
      ...fixture.snapshot,
      proxy: { ...fixture.snapshot.proxy, bypassPrefixes: ['10.0.0.0/8'] },
    } }
  }
  await screen.findByRole('combobox', { name: 'Windows VPN' })
  fireEvent.change(destinations, { target: { value: '10.0.0.199' } })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh measured paths' }))
  const measured = await screen.findByRole('group', { name: 'Current measured paths' })
  expect(within(measured).getByText(/Snapshot:.*Target check:/)).toBeVisible()
  expect(within(measured).getByRole('group', { name: 'Management gateway' })).toHaveTextContent('191.168.7.62')
  expect(within(measured).getByRole('group', { name: 'Management gateway' })).toHaveTextContent('Fixture Ethernet · 191.168.7.10')
  expect(within(measured).getByRole('group', { name: 'Entered destinations' })).toHaveTextContent('10.0.0.199')
  expect(within(measured).getByRole('group', { name: 'Entered destinations' })).toHaveTextContent('WLAN · 192.168.3.93')
  expect(within(measured).getByRole('group', { name: 'SakuraCat 10/8 rule' })).toHaveTextContent('DIRECT covers 10/8')
  expect(fixture.calls.some(call => call.action === 'inspect')).toBe(true)
  expect(fixture.calls.some(call => call.action === 'vpnRouteBatchVerify')).toBe(true)
})

it('shows a non-VPN selected target route without confusing proxy DIRECT with the OS route', async () => {
  const { fixture, destinations } = setup()
  fixture.api.inspect = async () => ({ ok: true, data: {
    ...fixture.snapshot,
    proxy: { ...fixture.snapshot.proxy, bypassPrefixes: ['10.0.0.0/8'] },
  } })
  fixture.api.vpnRouteBatchVerify = async input => ({ ok: true, data: {
    ...fixture.vpnRouteBatchPlan,
    canApply: false,
    items: input.destinations.map(destination => ({
      ...fixture.vpnRoutePlan,
      destination,
      canApply: false,
      selected: { target: destination, source: '192.168.31.2', interfaceAlias: 'WLAN', prefix: '0.0.0.0/0' },
    })),
  } })
  await screen.findByRole('combobox', { name: 'Windows VPN' })
  fireEvent.change(destinations, { target: { value: '10.0.0.199' } })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh measured paths' }))
  const measured = await screen.findByRole('group', { name: 'Current measured paths' })
  expect(within(measured).getByRole('group', { name: 'Entered destinations' })).toHaveTextContent('WLAN · 192.168.31.2')
  expect(within(measured).getByRole('group', { name: 'SakuraCat 10/8 rule' })).toHaveTextContent('DIRECT covers 10/8')
  expect(screen.getByRole('button', { name: 'Apply reviewed route' })).toBeDisabled()
})

it('refreshes the displayed VPN connection state with the measured paths', async () => {
  const fixture = createNetworkFixture()
  let reads = 0
  fixture.api.vpnRouteOptions = async () => ({ ok: true, data: { vpns: [{
    name: '124.114.142.77', scope: 'allUsers', connected: ++reads > 1, splitTunneling: true, routes: [],
  }] } })
  render(<VpnRouteBindingPanel api={fixture.api} disabled={false} profile={createDefaultNetworkProfiles()[0]}
    defaultVpnName="124.114.142.77" defaultVpnScope="allUsers" />)
  await screen.findByText(/Disconnected · Split tunneling on/)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh measured paths' }))
  await screen.findByText(/Connected · Split tunneling on/)
  expect(reads).toBe(2)
})

it('explains missing YAML configuration without claiming SakuraCat is stopped', async () => {
  const fixture = createNetworkFixture()
  fixture.api.inspect = async () => ({ ok: true, data: {
    ...fixture.snapshot, proxy: { ...fixture.snapshot.proxy, available: false },
  } })
  render(<VpnRouteBindingPanel api={fixture.api} disabled={false} profile={createDefaultNetworkProfiles()[0]}
    defaultVpnName="124.114.142.77" defaultVpnScope="allUsers" />)
  await screen.findByRole('combobox', { name: 'Windows VPN' })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh measured paths' }))
  expect(await screen.findByText(/Select SakuraCat's active YAML configuration to read its state/)).toBeVisible()
})
