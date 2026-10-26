import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PUBLIC_ACCESS_CONSENT_VERSION } from '@/lib/desktopHost/types'
import { PublicAccessSettings } from './PublicAccessSettings'
import { H5AccessSettings } from './H5AccessSettings'
import { useSettingsStore } from '@/stores/settingsStore'
const mocks = vi.hoisted(() => ({
  status: { state: 'unconfigured', hasCredential: false, publicUrl: null, error: null, autoStart: false, consentVersion: 0, mode: 'ngrok', customUrl: '', localPort: 17463, ngrokDomain: '', ngrokUrl: null },
  getStatus: vi.fn(), configure: vi.fn(), saveCredential: vi.fn(), start: vi.fn(), stop: vi.fn(), deleteCredential: vi.fn(), setAutoStart: vi.fn(),
  open: vi.fn(), get: vi.fn(), pairing: vi.fn(), approve: vi.fn(), reject: vi.fn(), revoke: vi.fn(), qr: vi.fn(),
}))
vi.mock('@/lib/desktopHost', () => ({ getDesktopHost: () => host }))
const host = { kind: 'electron', publicAccess: mocks, shell: { open: mocks.open } }
vi.mock('@/api/publicAccess', () => ({ publicAccessApi: mocks }))
vi.mock('qrcode', () => ({ default: { toDataURL: mocks.qr } }))
beforeEach(() => {
  vi.resetAllMocks()
  useSettingsStore.setState({ locale: 'en' })
  mocks.getStatus.mockImplementation(async () => mocks.status)
  mocks.get.mockResolvedValue({ enabled: false, port: null, publicUrl: null, pending: [], devices: [] })
  mocks.configure.mockImplementation(async (configuration) => {
    const next = { ...await mocks.getStatus(), ...configuration }
    mocks.getStatus.mockResolvedValue(next)
    return next
  })
  mocks.start.mockImplementation(async () => {
    const previous = await mocks.getStatus()
    const next = { ...previous, state: 'online', consentVersion: PUBLIC_ACCESS_CONSENT_VERSION,
      publicUrl: previous.mode === 'custom' ? previous.customUrl : 'https://test.ngrok-free.app' }
    mocks.getStatus.mockResolvedValue(next)
    mocks.get.mockResolvedValue({ enabled: true, port: next.localPort, publicUrl: next.publicUrl, pending: [], devices: [] })
    return next
  })
  mocks.pairing.mockResolvedValue({ secret: 'one-time', expiresAt: Date.now() + 300000 })
  mocks.qr.mockResolvedValue('data:image/png;base64,fake')
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks() })
it('requires privacy consent before saving a masked credential and starting', async () => {
  render(<PublicAccessSettings />)
  const input = screen.getByLabelText('ngrok Authtoken')
  expect(input).toHaveAttribute('type', 'password')
  fireEvent.change(input, { target: { value: 'private-token' } })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Enable public access' })).not.toBeDisabled())
  fireEvent.click(screen.getByRole('button', { name: 'Enable public access' }))
  const dialog = within(await screen.findByRole('dialog'))
  expect(dialog.getByText(/Standard HTTPS tunnels decrypt/)).toBeInTheDocument()
  expect(mocks.saveCredential).not.toHaveBeenCalled()
  fireEvent.click(dialog.getByRole('button', { name: 'Agree and enable public access' }))
  await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(PUBLIC_ACCESS_CONSENT_VERSION))
  expect(mocks.saveCredential).toHaveBeenCalledWith('private-token')
  expect(input).toHaveValue('')
  await screen.findByAltText('Scan to pair this phone')
  expect(mocks.qr).toHaveBeenCalledWith('https://test.ngrok-free.app/remote#pair=one-time', expect.any(Object))
  expect(mocks.setAutoStart).not.toHaveBeenCalled()
})

it('lets an existing HTTPS tunnel use the restricted gateway without an ngrok credential', async () => {
  render(<PublicAccessSettings />)
  const method = await screen.findByRole('combobox', { name: 'Connection method' })
  await waitFor(() => expect(method).not.toBeDisabled())
  fireEvent.change(method, { target: { value: 'custom' } })
  expect(screen.queryByLabelText('ngrok Authtoken')).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Public HTTPS address'), { target: { value: 'https://phone.example.com' } })
  expect(screen.getByText('http://127.0.0.1:17463')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Enable public access' }))
  const dialog = within(await screen.findByRole('dialog'))
  expect(dialog.getByText(/Your tunnel or reverse proxy operator/)).toBeInTheDocument()
  fireEvent.click(dialog.getByRole('button', { name: 'Agree and enable public access' }))
  await waitFor(() => expect(mocks.configure).toHaveBeenCalledWith({ mode: 'custom', customUrl: 'https://phone.example.com', localPort: 17463, ngrokDomain: '' }))
  await screen.findByAltText('Scan to pair this phone')
  expect(mocks.saveCredential).not.toHaveBeenCalled()
  expect(mocks.qr).toHaveBeenCalledWith('https://phone.example.com/remote#pair=one-time', expect.any(Object))
  expect(screen.getByText('Local gateway ready')).toBeInTheDocument()
  expect(screen.getByText(/This only confirms the local gateway/)).toBeInTheDocument()
})

it.each(['http://phone.example.com', 'https://phone.example.com/desktop/one', 'https://user:secret@phone.example.com', 'https://phone.example.com?token=secret'])(
  'rejects an unsupported public address before saving or starting: %s', async (url) => {
    render(<PublicAccessSettings />)
    const method = await screen.findByRole('combobox', { name: 'Connection method' })
    await waitFor(() => expect(method).not.toBeDisabled())
    fireEvent.change(method, { target: { value: 'custom' } })
    fireEvent.change(screen.getByLabelText('Public HTTPS address'), { target: { value: url } })
    expect(screen.getByRole('button', { name: 'Enable public access' })).toBeDisabled()
    expect(mocks.configure).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
  }
)

it('restores a saved custom gateway without requiring an ngrok account', async () => {
  mocks.getStatus.mockResolvedValue({ ...mocks.status, mode: 'custom', customUrl: 'https://phone.example.com', localPort: 18321, state: 'disabled', consentVersion: PUBLIC_ACCESS_CONSENT_VERSION })
  render(<PublicAccessSettings />)
  expect(await screen.findByLabelText('Public HTTPS address')).toHaveValue('https://phone.example.com')
  expect(screen.getByText('http://127.0.0.1:18321')).toBeInTheDocument()
  expect(screen.getByRole('switch', { name: 'Restore public access when the desktop starts' })).not.toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Enable public access' }))
  await screen.findByAltText('Scan to pair this phone')
  expect(mocks.configure).not.toHaveBeenCalled()
  expect(mocks.saveCredential).not.toHaveBeenCalled()
})
it('opens only the official account page', async () => {
  mocks.open.mockResolvedValue(undefined)
  render(<PublicAccessSettings />)
  fireEvent.click(screen.getByRole('button', { name: 'Get ngrok Authtoken' }))
  await waitFor(() => expect(mocks.open).toHaveBeenCalledWith('https://dashboard.ngrok.com/get-started/your-authtoken'))
})
it('shows quick public setup before the independent LAN form in the real settings entry', async () => {
  render(<H5AccessSettings />)
  const publicHeading = await screen.findByRole('heading', { name: 'Public access' })
  const lanHeading = screen.getByRole('heading', { name: 'Local network' })
  expect(publicHeading.compareDocumentPosition(lanHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByRole('combobox', { name: 'Connection method' })).toHaveValue('ngrok')
})

it('asks for confirmation when an existing custom address is changed', async () => {
  mocks.getStatus.mockResolvedValue({ ...mocks.status, mode: 'custom', customUrl: 'https://old.example.com', state: 'disabled', consentVersion: PUBLIC_ACCESS_CONSENT_VERSION })
  render(<PublicAccessSettings />)
  fireEvent.change(await screen.findByLabelText('Public HTTPS address'), { target: { value: 'https://new.example.com' } })
  fireEvent.click(screen.getByRole('button', { name: 'Enable public access' }))
  await screen.findByRole('dialog')
  expect(mocks.configure).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
})
it.each(['rejected', 'stale'] as const)('keeps the new address for retry and never starts after a %s configuration result', async result => {
  const previous = { ...mocks.status, mode: 'custom', customUrl: 'https://old.example.com', state: 'disabled', consentVersion: PUBLIC_ACCESS_CONSENT_VERSION }
  mocks.getStatus.mockResolvedValue(previous)
  if (result === 'rejected') mocks.configure.mockRejectedValueOnce(new Error('Public access configuration interrupted'))
  else mocks.configure.mockResolvedValueOnce(previous)
  render(<PublicAccessSettings />)
  const input = await screen.findByLabelText('Public HTTPS address')
  fireEvent.change(input, { target: { value: 'https://new.example.com' } })
  fireEvent.click(screen.getByRole('button', { name: 'Enable public access' }))
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Agree and enable public access' }))
  await screen.findByRole('alert')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(input).toHaveValue('https://new.example.com')
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.pairing).not.toHaveBeenCalled()
  expect(screen.queryByAltText('Scan to pair this phone')).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Enable public access' }))
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Agree and enable public access' }))
  await screen.findByAltText('Scan to pair this phone')
  expect(mocks.configure).toHaveBeenCalledTimes(2)
  expect(mocks.start).toHaveBeenCalledTimes(1)
  expect(mocks.qr).toHaveBeenCalledWith('https://new.example.com/remote#pair=one-time', expect.any(Object))
})
it('asks v1 users to confirm model configuration management before enabling again', async () => {
  mocks.getStatus.mockResolvedValue({ ...mocks.status, state: 'disabled', hasCredential: true, autoStart: true, consentVersion: 1 })
  render(<PublicAccessSettings />)
  await screen.findByText('Off')
  expect(screen.getByRole('switch', { name: 'Restore public access when the desktop starts' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Enable public access' }))
  const dialog = within(await screen.findByRole('dialog'))
  expect(dialog.getByText(/add, edit, delete and switch model provider configurations and API keys/)).toBeInTheDocument()
  expect(mocks.start).not.toHaveBeenCalled()
  fireEvent.click(dialog.getByRole('button', { name: 'Agree and enable public access' }))
  await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(PUBLIC_ACCESS_CONSENT_VERSION))
})
it('renders no credential controls in a browser', () => {
  host.kind = 'browser'
  const { container } = render(<PublicAccessSettings />)
  expect(container).toBeEmptyDOMElement()
  host.kind = 'electron'
})
it('uses an expiring fragment QR and revokes only the selected device', async () => {
  mocks.getStatus.mockResolvedValue({ state: 'online', hasCredential: true, publicUrl: 'https://test.ngrok-free.app', error: null, autoStart: false, consentVersion: PUBLIC_ACCESS_CONSENT_VERSION })
  mocks.get.mockResolvedValue({ enabled: true, port: 1234, publicUrl: 'https://test.ngrok-free.app', pending: [{ id: 'new-phone', name: 'New phone' }], devices: [{ id: 'old-phone', name: 'Old phone', createdAt: 1, expiresAt: Date.now() + 10000 }] })
  mocks.pairing.mockResolvedValue({ secret: 'one-time', expiresAt: Date.now() + 300000 })
  mocks.qr.mockResolvedValue('data:image/png;base64,fake')
  render(<PublicAccessSettings />)
  fireEvent.click(await screen.findByRole('button', { name: 'Connect a phone' }))
  await screen.findByAltText('Scan to pair this phone')
  expect(mocks.qr).toHaveBeenCalledWith('https://test.ngrok-free.app/remote#pair=one-time', expect.any(Object))
  expect(screen.queryByText(/one-time/)).not.toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Revoke' })).not.toBeDisabled())
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
  await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith('old-phone'))
  expect(mocks.stop).not.toHaveBeenCalled()
})
it('shows a retryable error without leaking upstream details', async () => {
  mocks.saveCredential.mockRejectedValueOnce(new Error('secret-private-token'))
  render(<PublicAccessSettings />)
  fireEvent.change(screen.getByLabelText('ngrok Authtoken'), { target: { value: 'private-token' } })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Enable public access' })).not.toBeDisabled())
  fireEvent.click(screen.getByRole('button', { name: 'Enable public access' }))
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Agree and enable public access' }))
  await screen.findByRole('alert')
  expect(screen.queryByText('secret-private-token')).not.toBeInTheDocument()
  expect(mocks.start).not.toHaveBeenCalled()
})

it('allows closing a tunnel while SDK start is pending', async () => {
  const connecting = { state: 'connecting', hasCredential: true, publicUrl: null, error: null, autoStart: false, consentVersion: PUBLIC_ACCESS_CONSENT_VERSION }
  const disabled = { ...connecting, state: 'disabled' }
  mocks.getStatus.mockResolvedValue(disabled)
  let finishStart!: () => void
  mocks.start.mockImplementation(() => {
    mocks.getStatus.mockResolvedValue(connecting)
    return new Promise<void>((resolve) => { finishStart = resolve })
  })
  mocks.stop.mockImplementation(async () => {
    mocks.getStatus.mockResolvedValue(disabled)
    return disabled
  })
  render(<PublicAccessSettings />)
  await screen.findByText('Off')
  fireEvent.click(screen.getByRole('button', { name: 'Enable public access' }))
  await waitFor(() => expect(mocks.start).toHaveBeenCalled())
  // The live host status refresh exposes the pending connection.
  await screen.findByText('Connecting…', {}, { timeout: 4000 })
  const stop = screen.getByRole('button', { name: 'Turn off' })
  expect(stop).not.toBeDisabled()
  fireEvent.click(stop)
  await waitFor(() => expect(mocks.stop).toHaveBeenCalledTimes(1))
  await screen.findByText('Off')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Enable public access' })).not.toBeDisabled())
  finishStart()
})


it('shows a QR once when the first connection recovers after a transient failure', async () => {
  const pollTimer = vi.spyOn(globalThis, 'setInterval')
  const disabled = { ...mocks.status, state: 'disabled', hasCredential: true, consentVersion: PUBLIC_ACCESS_CONSENT_VERSION }
  const reconnecting = { ...disabled, state: 'reconnecting' }
  const online = { ...disabled, state: 'online', publicUrl: 'https://test.ngrok-free.app' }
  mocks.getStatus.mockResolvedValue(disabled)
  mocks.start.mockImplementation(async () => {
    mocks.getStatus.mockResolvedValue(reconnecting)
    return reconnecting
  })
  render(<PublicAccessSettings />)
  await screen.findByText('Off')
  fireEvent.click(screen.getByRole('button', { name: 'Enable public access' }))
  await screen.findByText('Reconnecting…')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Turn off' })).not.toBeDisabled())
  expect(mocks.pairing).not.toHaveBeenCalled()
  mocks.getStatus.mockResolvedValue(online)
  const poll = pollTimer.mock.calls.find((call) => call[1] === 3000)![0] as () => void
  await act(async () => { poll() })
  await screen.findByAltText('Scan to pair this phone')
  await act(async () => { poll() })
  expect(mocks.pairing).toHaveBeenCalledTimes(1)
})

it('keeps the new QR when a connecting poll finishes after start has completed', async () => {
  const pollTimer = vi.spyOn(globalThis, 'setInterval')
  const disabled = { ...mocks.status, state: 'disabled', hasCredential: true, consentVersion: PUBLIC_ACCESS_CONSENT_VERSION }
  const connecting = { ...disabled, state: 'connecting' }
  const online = { ...disabled, state: 'online', publicUrl: 'https://test.ngrok-free.app' }
  mocks.getStatus.mockResolvedValue(disabled)
  let finishStart!: (status: typeof online) => void
  mocks.start.mockImplementation(() => {
    mocks.getStatus.mockResolvedValue(connecting)
    return new Promise((resolve) => { finishStart = resolve })
  })
  render(<PublicAccessSettings />)
  await screen.findByText('Off')
  fireEvent.click(screen.getByRole('button', { name: 'Enable public access' }))
  await waitFor(() => expect(mocks.start).toHaveBeenCalled())
  let finishPoll!: (details: unknown) => void
  mocks.get.mockImplementationOnce(() => new Promise((resolve) => { finishPoll = resolve }))
  const poll = pollTimer.mock.calls.find((call) => call[1] === 3000)![0] as () => void
  await act(async () => { poll() })
  mocks.getStatus.mockResolvedValue(online)
  await act(async () => { finishStart(online) })
  await screen.findByAltText('Scan to pair this phone')
  await act(async () => { finishPoll({ enabled: true, port: 17463, pending: [], devices: [] }) })
  expect(screen.getByAltText('Scan to pair this phone')).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('Online')
  expect(mocks.pairing).toHaveBeenCalledTimes(1)
})


it('saves an explicitly assigned ngrok domain before starting the tunnel', async () => {
  mocks.getStatus.mockResolvedValue({ ...mocks.status, state: 'disabled', hasCredential: true, consentVersion: PUBLIC_ACCESS_CONSENT_VERSION })
  render(<PublicAccessSettings />)
  await screen.findByText('Off')
  fireEvent.change(screen.getByLabelText('Assigned ngrok HTTPS address'), { target: { value: 'https://my-reserved.ngrok.app' } })
  fireEvent.click(screen.getByRole('button', { name: 'Enable public access' }))
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Agree and enable public access' }))
  await waitFor(() => expect(mocks.configure).toHaveBeenCalledWith({ mode: 'ngrok', customUrl: '', localPort: 17463, ngrokDomain: 'https://my-reserved.ngrok.app' }))
  await screen.findByAltText('Scan to pair this phone')
})
