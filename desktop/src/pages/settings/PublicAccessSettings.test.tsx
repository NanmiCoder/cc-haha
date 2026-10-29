import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PUBLIC_ACCESS_CONSENT_VERSION } from '@/lib/desktopHost/types'
import { PublicAccessSettings } from './PublicAccessSettings'
import { H5AccessSettings } from './H5AccessSettings'
import { useSettingsStore } from '@/stores/settingsStore'

const mocks = vi.hoisted(() => ({
  status: { state: 'unconfigured', publicUrl: null, error: null, autoStart: false, consentVersion: 0, mode: 'tailscale', customUrl: '', localPort: 17463, migrationRequired: false },
  getStatus: vi.fn(), configure: vi.fn(), start: vi.fn(), stop: vi.fn(), setAutoStart: vi.fn(),
  open: vi.fn(), get: vi.fn(), pairing: vi.fn(), approve: vi.fn(), reject: vi.fn(), revoke: vi.fn(), qr: vi.fn(), copy: vi.fn(),
}))
vi.mock('@/lib/desktopHost', () => ({ getDesktopHost: () => host }))
const host = { kind: 'electron', publicAccess: mocks, shell: { open: mocks.open } }
vi.mock('@/api/publicAccess', () => ({ publicAccessApi: mocks }))
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: mocks.copy }))
vi.mock('qrcode', () => ({ default: { toDataURL: mocks.qr } }))
const address = 'https://computer.fixture.ts.net'
const savedStatus = () => ({ ...mocks.status, state: 'disabled', customUrl: address, consentVersion: PUBLIC_ACCESS_CONSENT_VERSION })
const addressInput = () => screen.getByLabelText('Tailscale HTTPS address')
const enableButton = () => screen.getByRole('button', { name: 'Enable connection' })
const confirm = async () => fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Agree and enable connection' }))

beforeEach(() => {
  vi.resetAllMocks()
  useSettingsStore.setState({ locale: 'en' })
  mocks.getStatus.mockImplementation(async () => mocks.status)
  mocks.get.mockResolvedValue({ enabled: false, port: null, publicUrl: null, pending: [], devices: [] })
  mocks.configure.mockImplementation(async (configuration) => {
    const next = { ...await mocks.getStatus(), ...configuration, migrationRequired: false }
    mocks.getStatus.mockResolvedValue(next)
    return next
  })
  mocks.start.mockImplementation(async () => {
    const previous = await mocks.getStatus()
    const next = { ...previous, state: 'online', consentVersion: PUBLIC_ACCESS_CONSENT_VERSION, publicUrl: previous.customUrl }
    mocks.getStatus.mockResolvedValue(next)
    mocks.get.mockResolvedValue({ enabled: true, port: next.localPort, publicUrl: next.publicUrl, pending: [], devices: [] })
    return next
  })
  mocks.stop.mockImplementation(async () => {
    const next = { ...await mocks.getStatus(), state: 'disabled', publicUrl: null, error: null }
    mocks.getStatus.mockResolvedValue(next)
    return next
  })
  mocks.pairing.mockResolvedValue({ secret: 'one-time', expiresAt: Date.now() + 300000 })
  mocks.qr.mockResolvedValue('data:image/png;base64,fake')
  mocks.copy.mockResolvedValue(true)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks() })

it('configures the Tailscale entry and pairs only after consent, without tunnel credentials', async () => {
  render(<PublicAccessSettings />)
  await waitFor(() => expect(addressInput()).not.toBeDisabled())
  expect(screen.queryByRole('combobox', { name: 'Connection method' })).not.toBeInTheDocument()
  expect(screen.queryByLabelText('ngrok Authtoken')).not.toBeInTheDocument()
  fireEvent.change(addressInput(), { target: { value: address } })
  fireEvent.click(enableButton())
  const dialog = within(await screen.findByRole('dialog'))
  expect(dialog.getByText(/Tailscale encrypts device-to-device traffic/)).toBeInTheDocument()
  expect(mocks.configure).not.toHaveBeenCalled()
  fireEvent.click(dialog.getByRole('button', { name: 'Agree and enable connection' }))
  await screen.findByAltText('Scan to pair this phone')
  expect(mocks.configure).toHaveBeenCalledWith({ mode: 'tailscale', customUrl: address, localPort: 17463 })
  expect(mocks.start).toHaveBeenCalledWith(PUBLIC_ACCESS_CONSENT_VERSION)
  expect(mocks.qr).toHaveBeenCalledWith(`${address}/remote#pair=one-time`, expect.any(Object))
  expect(screen.getByText('Local entry ready')).toBeInTheDocument()
  expect(screen.getByText(/This only confirms the local entry/)).toBeInTheDocument()
  expect(screen.getByAltText('Scan to pair this phone').compareDocumentPosition(screen.getByRole('switch', { name: 'Restore the entry when the desktop starts' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(mocks.setAutoStart).not.toHaveBeenCalled()
})

it.each([
  'http://100.101.102.103:17463', 'https://phone.example.com', 'https://computer.fixture.ts.net/desktop/one',
  'https://user:secret@computer.fixture.ts.net', 'https://computer.fixture.ts.net?token=secret',
  'https://computer.fixture.ts.net.evil.invalid',
])('rejects unsupported addresses before saving or starting: %s', async url => {
  render(<PublicAccessSettings />)
  await waitFor(() => expect(addressInput()).not.toBeDisabled())
  fireEvent.change(addressInput(), { target: { value: url } })
  expect(enableButton()).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Copy command' })).toBeDisabled()
  expect(screen.getByRole('alert')).toHaveTextContent('Enter a Tailscale HTTPS address')
  expect(mocks.configure).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
})

it('copies a matching Serve command for a separate HTTPS port and local gateway port', async () => {
  render(<PublicAccessSettings />)
  await waitFor(() => expect(addressInput()).not.toBeDisabled())
  expect(screen.getByText('tailscale serve --bg http://127.0.0.1:17463')).toBeInTheDocument()
  expect(screen.getByText(/Run tailscale serve status first/)).toBeInTheDocument()
  fireEvent.change(addressInput(), { target: { value: `${address}:8443` } })
  fireEvent.change(screen.getByLabelText('Local gateway port'), { target: { value: '18321' } })
  const command = 'tailscale serve --bg --https=8443 http://127.0.0.1:18321'
  expect(screen.getByText(command)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Copy command' }))
  await screen.findByRole('button', { name: 'Command copied' })
  expect(mocks.copy).toHaveBeenCalledWith(command)
  expect(mocks.configure).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Local gateway port'), { target: { value: '80' } })
  expect(screen.getByRole('button', { name: 'Copy command' })).toBeDisabled()
  expect(enableButton()).toBeDisabled()
})

it('restores the saved Tailscale address without another consent or configuration write', async () => {
  mocks.getStatus.mockResolvedValue({ ...savedStatus(), localPort: 18321 })
  render(<PublicAccessSettings />)
  await waitFor(() => expect(addressInput()).toHaveValue(address))
  expect(screen.getByText('tailscale serve --bg http://127.0.0.1:18321')).toBeInTheDocument()
  expect(screen.getByRole('switch', { name: 'Restore the entry when the desktop starts' })).not.toBeDisabled()
  fireEvent.click(enableButton())
  await screen.findByAltText('Scan to pair this phone')
  expect(mocks.configure).not.toHaveBeenCalled()
})

it('explains migrated settings without automatically starting or exposing an old credential', async () => {
  mocks.getStatus.mockResolvedValue({ ...mocks.status, migrationRequired: true })
  render(<PublicAccessSettings />)
  await screen.findByText(/Your old connection will not start automatically/)
  expect(addressInput()).toHaveValue('')
  expect(enableButton()).toBeDisabled()
  expect(mocks.start).not.toHaveBeenCalled()
  expect(screen.queryByLabelText('ngrok Authtoken')).not.toBeInTheDocument()
})

it.each([
  ['macOS (.pkg)', 'https://pkgs.tailscale.com/stable/Tailscale-latest-macos.pkg'],
  ['Windows (.exe)', 'https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe'],
  ['Android (APK)', 'https://pkgs.tailscale.com/stable/tailscale-android-universal-latest.apk'],
  ['Google Play', 'https://play.google.com/store/apps/details?id=com.tailscale.ipn'],
  ['iPhone / iPad (App Store)', 'https://apps.apple.com/us/app/tailscale/id1470499037?ls=1'],
  ['Other systems / official website', 'https://tailscale.com/download'],
  ['Connection guide', 'https://cchaha.ai/desktop/remote'],
])('opens the official %s entry without configuring or starting remote access', async (name, url) => {
  render(<PublicAccessSettings />)
  await waitFor(() => expect(addressInput()).not.toBeDisabled())
  fireEvent.click(screen.getByRole('button', { name }))
  await waitFor(() => expect(mocks.open).toHaveBeenCalledWith(url))
  expect(mocks.configure).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.pairing).not.toHaveBeenCalled()
})

it('offers phone installation QR codes on demand, separately from connection pairing', async () => {
  mocks.qr.mockImplementation(async (url: string) => `data:image/png;base64,${url.includes('.apk') ? 'android' : 'ios'}`)
  render(<PublicAccessSettings />)
  await waitFor(() => expect(addressInput()).not.toBeDisabled())
  expect(mocks.qr).not.toHaveBeenCalled()
  const toggle = screen.getByRole('button', { name: 'Scan to install on your phone' })
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(await screen.findByAltText('Download Tailscale for Android')).toHaveAttribute('src', 'data:image/png;base64,android')
  expect(await screen.findByAltText('Install Tailscale from the App Store')).toHaveAttribute('src', 'data:image/png;base64,ios')
  expect(mocks.qr.mock.calls.map(call => call[0])).toEqual([
    'https://pkgs.tailscale.com/stable/tailscale-android-universal-latest.apk',
    'https://apps.apple.com/us/app/tailscale/id1470499037?ls=1',
  ])
  expect(screen.queryByAltText('Scan to pair this phone')).not.toBeInTheDocument()
  expect(mocks.open).not.toHaveBeenCalled()
  expect(mocks.pairing).not.toHaveBeenCalled()
  fireEvent.click(toggle)
  expect(screen.queryByAltText('Download Tailscale for Android')).not.toBeInTheDocument()
})

it('keeps phone installation failures local and lets the user retry', async () => {
  mocks.qr.mockRejectedValueOnce(new Error('private upstream details'))
  render(<PublicAccessSettings />)
  const toggle = screen.getByRole('button', { name: 'Scan to install on your phone' })
  fireEvent.click(toggle)
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not create installation QR codes')
  expect(screen.queryByText('private upstream details')).not.toBeInTheDocument()
  fireEvent.click(toggle)
  fireEvent.click(toggle)
  await screen.findByAltText('Download Tailscale for Android')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(mocks.configure).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
})

it('keeps each connection method focused and preserves a remote draft when switching methods', async () => {
  render(<H5AccessSettings />)
  expect(screen.getByRole('tab', { name: 'Same Wi-Fi' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('heading', { name: 'Local network' })).toBeVisible()
  expect(screen.queryByRole('heading', { name: 'Tailscale remote access' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('tab', { name: 'Away from home' }))
  expect(await screen.findByRole('heading', { name: 'Tailscale remote access' })).toBeVisible()
  await waitFor(() => expect(addressInput()).not.toBeDisabled())
  fireEvent.change(addressInput(), { target: { value: address } })
  fireEvent.click(screen.getByRole('tab', { name: 'Same Wi-Fi' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Away from home' }))
  expect(addressInput()).toHaveValue(address)
  expect(screen.queryByLabelText('ngrok Authtoken')).not.toBeInTheDocument()
})

it('starts with cc-haha installation and moves browser users to LAN without enabling either connection', async () => {
  render(<H5AccessSettings />)
  const installation = screen.getByRole('heading', { name: 'Get cc-haha on your phone' })
  const lan = screen.getByRole('tab', { name: 'Same Wi-Fi' })
  expect(installation.compareDocumentPosition(lan) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Download Android APK' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Join TestFlight beta' })).toBeDisabled()
  fireEvent.click(screen.getByRole('tab', { name: 'Away from home' }))
  await waitFor(() => expect(addressInput()).not.toBeDisabled())
  fireEvent.change(addressInput(), { target: { value: address } })
  fireEvent.click(screen.getByRole('button', { name: 'Use phone browser' }))
  expect(lan).toHaveAttribute('aria-selected', 'true')
  expect(lan).toHaveFocus()
  expect(screen.getByRole('switch', { name: 'Enable local connection' })).not.toBeChecked()
  expect(mocks.configure).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('tab', { name: 'Away from home' }))
  expect(addressInput()).toHaveValue(address)
})

it('presents installation, the runnable command, its returned address and pairing in order', async () => {
  render(<PublicAccessSettings />)
  const install = screen.getByRole('heading', { name: 'Install on both devices' })
  const configure = screen.getByRole('heading', { name: 'Set up this computer' })
  const pair = screen.getByRole('heading', { name: 'Scan and confirm' })
  const command = screen.getByText('tailscale serve --bg http://127.0.0.1:17463')
  const orderedPairs: [HTMLElement, HTMLElement][] = [[install, configure], [configure, command], [command, addressInput()], [addressInput(), pair]]
  for (const [first, second] of orderedPairs) {
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  }
  expect(screen.getByText('Paste the HTTPS address returned by the command above.')).toBeVisible()
  expect(screen.getByText(/First run tailscale serve status/)).toBeVisible()
  expect(screen.getByText(/search for Terminal with Command/)).toBeVisible()
  expect(screen.getByText(/Settings → CLI integration/)).toBeVisible()
  expect(screen.getByText(/Enable the entry to show a QR code/)).toBeVisible()
  expect(screen.getByText('Port already in use or command not found?').closest('details')).not.toHaveAttribute('open')
  await waitFor(() => expect(addressInput()).not.toBeDisabled())
})

it('asks for confirmation when the saved address changes and disables auto-start until it is saved', async () => {
  mocks.getStatus.mockResolvedValue(savedStatus())
  render(<PublicAccessSettings />)
  await waitFor(() => expect(addressInput()).toHaveValue(address))
  fireEvent.change(addressInput(), { target: { value: 'https://new.fixture.ts.net' } })
  expect(screen.getByRole('switch', { name: 'Restore the entry when the desktop starts' })).toBeDisabled()
  fireEvent.click(enableButton())
  await screen.findByRole('dialog')
  expect(mocks.configure).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
})

it.each(['rejected', 'stale'] as const)('retains the edited address and never starts after a %s configuration result', async result => {
  const previous = savedStatus()
  mocks.getStatus.mockResolvedValue(previous)
  if (result === 'rejected') mocks.configure.mockRejectedValueOnce(new Error('private upstream details'))
  else mocks.configure.mockResolvedValueOnce(previous)
  render(<PublicAccessSettings />)
  await waitFor(() => expect(addressInput()).toHaveValue(address))
  fireEvent.change(addressInput(), { target: { value: 'https://new.fixture.ts.net' } })
  fireEvent.click(enableButton())
  await confirm()
  await screen.findByRole('alert')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(addressInput()).toHaveValue('https://new.fixture.ts.net')
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.pairing).not.toHaveBeenCalled()
  expect(screen.queryByText('private upstream details')).not.toBeInTheDocument()
  fireEvent.click(enableButton())
  await confirm()
  await screen.findByAltText('Scan to pair this phone')
  expect(mocks.configure).toHaveBeenCalledTimes(2)
  expect(mocks.start).toHaveBeenCalledTimes(1)
})

it('requires the current consent for a migrated Serve address', async () => {
  mocks.getStatus.mockResolvedValue({ ...savedStatus(), consentVersion: 2 })
  render(<PublicAccessSettings />)
  await screen.findByText('Off')
  expect(screen.getByRole('switch', { name: 'Restore the entry when the desktop starts' })).toBeDisabled()
  fireEvent.click(enableButton())
  const dialog = within(await screen.findByRole('dialog'))
  expect(dialog.getByText(/manage model provider configurations and API keys/)).toBeInTheDocument()
  expect(mocks.start).not.toHaveBeenCalled()
  fireEvent.click(dialog.getByRole('button', { name: 'Agree and enable connection' }))
  await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(PUBLIC_ACCESS_CONSENT_VERSION))
})

it('renders no connection controls in a browser', () => {
  host.kind = 'browser'
  const { container } = render(<PublicAccessSettings />)
  expect(container).toBeEmptyDOMElement()
  host.kind = 'electron'
})

it('uses an expiring fragment QR and approves, rejects or revokes only the selected phone', async () => {
  mocks.getStatus.mockResolvedValue({ ...savedStatus(), state: 'online', publicUrl: address })
  mocks.get.mockResolvedValue({ enabled: true, port: 17463, publicUrl: address, pending: [{ id: 'new-phone', name: 'New phone' }], devices: [{ id: 'old-phone', name: 'Old phone', createdAt: 1, expiresAt: Date.now() + 10000 }] })
  render(<PublicAccessSettings />)
  fireEvent.click(await screen.findByRole('button', { name: 'Connect a phone' }))
  await screen.findByAltText('Scan to pair this phone')
  expect(mocks.qr).toHaveBeenCalledWith(`${address}/remote#pair=one-time`, expect.any(Object))
  expect(screen.queryByText(/one-time/)).not.toBeInTheDocument()
  for (const [label, action, id] of [['Approve', mocks.approve, 'new-phone'], ['Reject', mocks.reject, 'new-phone'], ['Revoke', mocks.revoke, 'old-phone']] as const) {
    await waitFor(() => expect(screen.getByRole('button', { name: label })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: label }))
    await waitFor(() => expect(action).toHaveBeenCalledWith(id))
  }
  expect(mocks.stop).not.toHaveBeenCalled()
})

it('shows a retryable gateway error without a QR or leaking upstream details', async () => {
  mocks.getStatus.mockResolvedValue(savedStatus())
  mocks.start.mockRejectedValueOnce(new Error('private upstream details'))
  render(<PublicAccessSettings />)
  await screen.findByText('Off')
  fireEvent.click(enableButton())
  await screen.findByRole('alert')
  expect(screen.queryByText('private upstream details')).not.toBeInTheDocument()
  expect(mocks.pairing).not.toHaveBeenCalled()
  expect(enableButton()).not.toBeDisabled()
  fireEvent.click(enableButton())
  await screen.findByAltText('Scan to pair this phone')
})

it('keeps configuration frozen and allows another close attempt when shutdown is unconfirmed', async () => {
  const online = { ...savedStatus(), state: 'online', publicUrl: address }
  mocks.getStatus.mockResolvedValue(online)
  mocks.get.mockResolvedValue({ enabled: true, port: 17463, publicUrl: address, pending: [], devices: [] })
  mocks.stop.mockImplementationOnce(async () => {
    const failed = { ...online, state: 'failed', error: 'stop' }
    mocks.getStatus.mockResolvedValue(failed)
    return failed
  })
  render(<PublicAccessSettings />)
  await screen.findByText('Local entry ready')
  expect(screen.getByText(/This only confirms the local entry/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Phones may still have access')
  expect(screen.queryByText(/This only confirms the local entry/)).not.toBeInTheDocument()
  expect(screen.queryByText('Off')).not.toBeInTheDocument()
  expect(addressInput()).toBeDisabled()
  expect(screen.getByLabelText('Local gateway port')).toBeDisabled()
  expect(enableButton()).toBeDisabled()
  expect(screen.getByRole('switch', { name: 'Restore the entry when the desktop starts' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Turn off' })).not.toBeDisabled()
  expect(mocks.configure).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
  await screen.findByText('Off')
  expect(mocks.stop).toHaveBeenCalledTimes(2)
  expect(screen.queryByText(/This only confirms the local entry/)).not.toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(addressInput()).not.toBeDisabled()
  expect(enableButton()).not.toBeDisabled()
})

it('allows stopping while gateway startup is pending and ignores the late result', async () => {
  const pollTimer = vi.spyOn(globalThis, 'setInterval')
  const disabled = savedStatus()
  const connecting = { ...disabled, state: 'connecting' }
  mocks.getStatus.mockResolvedValue(disabled)
  let finishStart!: (value: unknown) => void
  mocks.start.mockImplementation(() => {
    mocks.getStatus.mockResolvedValue(connecting)
    return new Promise(resolve => { finishStart = resolve })
  })
  render(<PublicAccessSettings />)
  await screen.findByText('Off')
  fireEvent.click(enableButton())
  await waitFor(() => expect(mocks.start).toHaveBeenCalled())
  const poll = pollTimer.mock.calls.find(call => call[1] === 3000)![0] as () => void
  await act(async () => { poll() })
  await screen.findByText('Connecting…')
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
  await screen.findByText('Off')
  await act(async () => { finishStart({ ...disabled, state: 'online', publicUrl: address }) })
  expect(screen.getByRole('status')).toHaveTextContent('Off')
  expect(mocks.pairing).not.toHaveBeenCalled()
})

it('keeps the QR when a connecting poll finishes after startup has completed', async () => {
  const pollTimer = vi.spyOn(globalThis, 'setInterval')
  const disabled = savedStatus()
  const connecting = { ...disabled, state: 'connecting' }
  const online = { ...disabled, state: 'online', publicUrl: address }
  mocks.getStatus.mockResolvedValue(disabled)
  let finishStart!: (value: unknown) => void
  mocks.start.mockImplementation(() => {
    mocks.getStatus.mockResolvedValue(connecting)
    return new Promise(resolve => { finishStart = resolve })
  })
  render(<PublicAccessSettings />)
  await screen.findByText('Off')
  fireEvent.click(enableButton())
  await waitFor(() => expect(mocks.start).toHaveBeenCalled())
  let finishPoll!: (details: unknown) => void
  mocks.get.mockImplementationOnce(() => new Promise(resolve => { finishPoll = resolve }))
  const poll = pollTimer.mock.calls.find(call => call[1] === 3000)![0] as () => void
  await act(async () => { poll() })
  mocks.getStatus.mockResolvedValue(online)
  await act(async () => { finishStart(online) })
  await screen.findByAltText('Scan to pair this phone')
  await act(async () => { finishPoll({ enabled: true, port: 17463, pending: [], devices: [] }) })
  expect(screen.getByAltText('Scan to pair this phone')).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('Local entry ready')
  expect(mocks.pairing).toHaveBeenCalledTimes(1)
})
