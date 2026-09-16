import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PUBLIC_ACCESS_CONSENT_VERSION } from '@/lib/desktopHost/types'
import { PublicAccessSettings } from './PublicAccessSettings'
import { useSettingsStore } from '@/stores/settingsStore'
const mocks = vi.hoisted(() => ({
  status: { state: 'unconfigured', hasCredential: false, publicUrl: null, error: null, autoStart: false, consentVersion: 0 },
  getStatus: vi.fn(), saveCredential: vi.fn(), start: vi.fn(), stop: vi.fn(), deleteCredential: vi.fn(), setAutoStart: vi.fn(),
  open: vi.fn(), get: vi.fn(), pairing: vi.fn(), approve: vi.fn(), reject: vi.fn(), revoke: vi.fn(), qr: vi.fn(),
}))
vi.mock('@/lib/desktopHost', () => ({ getDesktopHost: () => host }))
const host = { kind: 'electron', publicAccess: mocks, shell: { open: mocks.open } }
vi.mock('@/api/publicAccess', () => ({ publicAccessApi: mocks }))
vi.mock('qrcode', () => ({ default: { toDataURL: mocks.qr } }))
beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  mocks.getStatus.mockImplementation(async () => mocks.status)
  mocks.get.mockResolvedValue({ enabled: false, port: null, publicUrl: null, pending: [], devices: [] })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })
it('requires privacy consent before saving a masked credential and starting', async () => {
  render(<PublicAccessSettings />)
  const input = screen.getByLabelText('ngrok Authtoken')
  expect(input).toHaveAttribute('type', 'password')
  fireEvent.change(input, { target: { value: 'private-token' } })
  fireEvent.click(screen.getByRole('button', { name: 'Enable public access' }))
  const dialog = within(await screen.findByRole('dialog'))
  expect(dialog.getByText(/Standard HTTPS tunnels decrypt/)).toBeInTheDocument()
  expect(mocks.saveCredential).not.toHaveBeenCalled()
  fireEvent.click(dialog.getByRole('button', { name: 'Agree and enable public access' }))
  await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(PUBLIC_ACCESS_CONSENT_VERSION))
  expect(mocks.saveCredential).toHaveBeenCalledWith('private-token')
  expect(input).toHaveValue('')
})
it('opens only the official account page', async () => {
  mocks.open.mockResolvedValue(undefined)
  render(<PublicAccessSettings />)
  fireEvent.click(screen.getByRole('button', { name: 'Get ngrok Authtoken' }))
  await waitFor(() => expect(mocks.open).toHaveBeenCalledWith('https://dashboard.ngrok.com/get-started/your-authtoken'))
})
it('asks v1 users to confirm model configuration management before enabling again', async () => {
  mocks.getStatus.mockResolvedValue({ ...mocks.status, state: 'disabled', hasCredential: true, autoStart: true, consentVersion: 1 })
  render(<PublicAccessSettings />)
  await screen.findByText('Off')
  expect(screen.getByRole('checkbox')).toBeDisabled()
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
