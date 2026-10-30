import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PUBLIC_ACCESS_CONSENT_VERSION } from '@/lib/desktopHost/types'
import { PublicAccessSettings } from './PublicAccessSettings'
import { H5AccessSettings } from './H5AccessSettings'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'

const mocks = vi.hoisted(() => ({
  status: { state: 'disabled', publicUrl: null, error: null, autoStart: false, consentVersion: 0, mode: 'quick', customUrl: '', localPort: 17463, tokenSet: false, phase: null, migrationRequired: false },
  getStatus: vi.fn(), configure: vi.fn(), start: vi.fn(), stop: vi.fn(), setAutoStart: vi.fn(),
  open: vi.fn(), get: vi.fn(), pairing: vi.fn(), approve: vi.fn(), reject: vi.fn(), revoke: vi.fn(), qr: vi.fn(), copy: vi.fn(),
}))
vi.mock('@/lib/desktopHost', () => ({ getDesktopHost: () => host }))
const host = { kind: 'electron', publicAccess: mocks, shell: { open: mocks.open } }
vi.mock('@/api/publicAccess', () => ({ publicAccessApi: mocks }))
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: mocks.copy }))
vi.mock('qrcode', () => ({ default: { toDataURL: mocks.qr } }))
const quickAddress = 'https://computer-fixture.trycloudflare.com'
const fixedAddress = 'https://phone.example.com'
const savedStatus = (mode: 'quick' | 'named' = 'quick') => ({ ...mocks.status, mode, customUrl: mode === 'named' ? fixedAddress : '', tokenSet: mode === 'named', consentVersion: PUBLIC_ACCESS_CONSENT_VERSION })
const addressInput = () => screen.getByLabelText('Fixed HTTPS address')
const tokenInput = () => screen.getByLabelText('Tunnel Token')
const enableButton = () => screen.getByRole('button', { name: 'Enable connection' })
const chooseNamed = () => fireEvent.click(screen.getByRole('radio', { name: 'Fixed domain' }))
const confirm = async () => fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Agree and enable connection' }))
const copyPairingButton = () => screen.getByRole('button', { name: 'Copy pairing link' })
const qrImage = () => screen.queryByAltText('Scan to pair this phone')
const onlineStatus = () => ({ ...savedStatus(), state: 'online', publicUrl: quickAddress })
const mockOnline = () => {
  const online = onlineStatus()
  mocks.getStatus.mockResolvedValue(online)
  mocks.get.mockResolvedValue({ enabled: true, port: 17463, publicUrl: online.publicUrl, pending: [], devices: [] })
  return online
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetAllMocks()
  host.kind = 'electron'
  useSettingsStore.setState({ locale: 'en' })
  mocks.getStatus.mockImplementation(async () => mocks.status)
  mocks.get.mockResolvedValue({ enabled: false, port: null, publicUrl: null, pending: [], devices: [] })
  mocks.configure.mockImplementation(async ({ tunnelToken, ...configuration }) => {
    const previous = await mocks.getStatus()
    const next = { ...previous, ...configuration, state: 'disabled', error: null, phase: null, tokenSet: !!tunnelToken || previous.tokenSet, migrationRequired: false }
    mocks.getStatus.mockResolvedValue(next)
    return next
  })
  mocks.start.mockImplementation(async () => {
    const previous = await mocks.getStatus()
    const next = { ...previous, state: 'online', phase: null, consentVersion: PUBLIC_ACCESS_CONSENT_VERSION, publicUrl: previous.mode === 'named' ? previous.customUrl : quickAddress }
    mocks.getStatus.mockResolvedValue(next)
    mocks.get.mockResolvedValue({ enabled: true, port: next.localPort, publicUrl: next.publicUrl, pending: [], devices: [] })
    return next
  })
  mocks.stop.mockImplementation(async () => {
    const next = { ...await mocks.getStatus(), state: 'disabled', phase: null, publicUrl: null, error: null }
    mocks.getStatus.mockResolvedValue(next)
    return next
  })
  mocks.pairing.mockResolvedValue({ secret: 'one-time', expiresAt: Date.now() + 300000 })
  mocks.qr.mockResolvedValue('data:image/png;base64,fake')
  mocks.copy.mockResolvedValue(true)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks() })

it.each(['quick', 'named'] as const)('copies a complete %s pairing link that the mobile scanner can use', async mode => {
  const publicUrl = mode === 'quick' ? quickAddress : fixedAddress
  mocks.getStatus.mockResolvedValue({ ...savedStatus(mode), state: 'online', publicUrl })
  mocks.get.mockResolvedValue({ enabled: true, port: 17463, publicUrl, pending: [], devices: [] })
  mocks.pairing.mockResolvedValue({ secret: 'fixture+pair/encoded', expiresAt: Date.now() + 300000 })
  render(<PublicAccessSettings />)
  fireEvent.click(await screen.findByRole('button', { name: /^Copy (?:address|pairing link)$/ }))
  await waitFor(() => expect(mocks.copy).toHaveBeenCalledTimes(1))

  const copied = mocks.copy.mock.calls[0]![0] as string
  const parsed = new URL(copied)
  expect(parsed.origin).toBe(publicUrl)
  expect(parsed.pathname).toBe('/remote')
  expect(parsed.search).toBe('')
  expect([...new URLSearchParams(parsed.hash.slice(1))]).toEqual([['pair', 'fixture+pair/encoded']])
  expect(mocks.qr).toHaveBeenCalledWith(copied, expect.any(Object))
  expect(mocks.pairing).toHaveBeenCalledTimes(1)
  expect(document.body.textContent).not.toContain('fixture+pair/encoded')
})

it('replaces an earlier QR with the same fresh link written to the clipboard', async () => {
  mockOnline()
  render(<PublicAccessSettings />)
  fireEvent.click(await screen.findByRole('button', { name: 'Connect a phone' }))
  await screen.findByAltText('Scan to pair this phone')
  mocks.pairing.mockResolvedValue({ secret: 'fresh-after-consumption', expiresAt: Date.now() + 300000 })
  await waitFor(() => expect(copyPairingButton()).not.toBeDisabled())
  fireEvent.click(copyPairingButton())
  await waitFor(() => expect(mocks.copy).toHaveBeenCalledTimes(1))

  const expected = `${quickAddress}/remote#pair=fresh-after-consumption`
  expect(mocks.pairing).toHaveBeenCalledTimes(2)
  expect(mocks.qr).toHaveBeenLastCalledWith(expected, expect.any(Object))
  expect(mocks.copy).toHaveBeenCalledWith(expected)
  expect(qrImage()).toBeInTheDocument()
})

it('hides an expired QR and creates a fresh code when copying afterwards', async () => {
  vi.useFakeTimers()
  mockOnline()
  mocks.pairing.mockResolvedValue({ secret: 'expires-soon', expiresAt: Date.now() + 1000 })
  await act(async () => { render(<PublicAccessSettings />) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect a phone' })) })
  expect(qrImage()).toBeInTheDocument()
  await act(async () => { await vi.advanceTimersByTimeAsync(1001) })
  expect(qrImage()).not.toBeInTheDocument()

  mocks.pairing.mockResolvedValue({ secret: 'fresh-after-expiry', expiresAt: Date.now() + 300000 })
  await act(async () => { fireEvent.click(copyPairingButton()) })
  expect(mocks.copy).toHaveBeenCalledWith(`${quickAddress}/remote#pair=fresh-after-expiry`)
  expect(mocks.pairing).toHaveBeenCalledTimes(2)
  expect(qrImage()).toBeInTheDocument()
})

it.each(['request', 'encoding'] as const)('removes the old QR after a pairing %s failure and retries with a new code', async failure => {
  mockOnline()
  render(<PublicAccessSettings />)
  fireEvent.click(await screen.findByRole('button', { name: 'Connect a phone' }))
  await screen.findByAltText('Scan to pair this phone')
  await waitFor(() => expect(copyPairingButton()).not.toBeDisabled())
  if (failure === 'request') mocks.pairing.mockRejectedValueOnce(new Error('private pairing failure'))
  else mocks.qr.mockRejectedValueOnce(new Error('private encoding failure'))
  fireEvent.click(copyPairingButton())
  expect(qrImage()).not.toBeInTheDocument()
  await screen.findByRole('alert')
  expect(qrImage()).not.toBeInTheDocument()
  expect(mocks.copy).not.toHaveBeenCalled()
  expect(document.body.textContent).not.toContain('private')

  mocks.pairing.mockResolvedValue({ secret: 'retry-fresh', expiresAt: Date.now() + 300000 })
  await waitFor(() => expect(copyPairingButton()).not.toBeDisabled())
  fireEvent.click(copyPairingButton())
  await waitFor(() => expect(mocks.copy).toHaveBeenCalledWith(`${quickAddress}/remote#pair=retry-fresh`))
  expect(mocks.qr).toHaveBeenLastCalledWith(`${quickAddress}/remote#pair=retry-fresh`, expect.any(Object))
  expect(qrImage()).toBeInTheDocument()
})

it.each([
  ['request', 'stop'], ['request', 'origin'], ['request', 'unmount'],
  ['encoding', 'stop'], ['encoding', 'origin'], ['encoding', 'unmount'],
  ['status', 'stop'], ['status', 'origin'], ['status', 'unmount'],
] as const)('discards a late pairing %s result after %s without copying or showing its QR', async (phase, cancellation) => {
  const online = mockOnline()
  const pollTimer = vi.spyOn(globalThis, 'setInterval')
  const pair = deferred<{ secret: string, expiresAt: number }>()
  const image = deferred<string>()
  const verification = deferred<ReturnType<typeof onlineStatus>>()
  let checking = false
  if (phase === 'request') mocks.pairing.mockReturnValueOnce(pair.promise)
  if (phase === 'encoding') mocks.qr.mockReturnValueOnce(image.promise)
  if (phase === 'status') mocks.qr.mockImplementationOnce(async () => {
    mocks.getStatus.mockImplementationOnce(() => { checking = true; return verification.promise })
    return 'data:image/png;base64,pending'
  })
  const view = render(<PublicAccessSettings />)
  fireEvent.click(await screen.findByRole('button', { name: 'Copy pairing link' }))
  await waitFor(() => {
    if (phase === 'request') expect(mocks.pairing).toHaveBeenCalledTimes(1)
    else if (phase === 'encoding') expect(mocks.qr).toHaveBeenCalledTimes(1)
    else expect(checking).toBe(true)
  })

  if (cancellation === 'stop') {
    const stop = screen.getByRole('button', { name: 'Turn off' })
    expect(stop).not.toBeDisabled()
    fireEvent.click(stop)
    await screen.findByText('Off')
  } else if (cancellation === 'origin') {
    const changed = { ...online, publicUrl: fixedAddress }
    mocks.getStatus.mockResolvedValue(changed)
    mocks.get.mockResolvedValue({ enabled: true, port: 17463, publicUrl: fixedAddress, pending: [], devices: [] })
    const poll = pollTimer.mock.calls.find(call => call[1] === 1000)![0] as () => void
    await act(async () => { poll() })
    await screen.findByText(`${fixedAddress}/remote`)
  } else view.unmount()

  await act(async () => {
    if (phase === 'request') pair.resolve({ secret: 'late-code', expiresAt: Date.now() + 300000 })
    else if (phase === 'encoding') image.resolve('data:image/png;base64,late')
    else verification.resolve(online)
  })
  expect(mocks.copy).not.toHaveBeenCalled()
  expect(qrImage()).not.toBeInTheDocument()
  expect(mocks.qr).toHaveBeenCalledTimes(phase === 'request' ? 0 : 1)
})

it('checks the live gateway after encoding even before a changed origin reaches the status poll', async () => {
  const online = mockOnline()
  const image = deferred<string>()
  mocks.qr.mockReturnValueOnce(image.promise)
  render(<PublicAccessSettings />)
  fireEvent.click(await screen.findByRole('button', { name: 'Copy pairing link' }))
  await waitFor(() => expect(mocks.qr).toHaveBeenCalledTimes(1))
  mocks.getStatus.mockResolvedValue({ ...online, publicUrl: fixedAddress })
  await act(async () => { image.resolve('data:image/png;base64,old-origin') })
  await screen.findByText(`${fixedAddress}/remote`)
  expect(mocks.copy).not.toHaveBeenCalled()
  expect(qrImage()).not.toBeInTheDocument()
})

it.each(['connection', 'origin'] as const)('discards a code when the %s changes and restores the same address before encoding finishes', async change => {
  const online = mockOnline()
  const pollTimer = vi.spyOn(globalThis, 'setInterval')
  const image = deferred<string>()
  mocks.qr.mockReturnValueOnce(image.promise)
  render(<PublicAccessSettings />)
  fireEvent.click(await screen.findByRole('button', { name: 'Copy pairing link' }))
  await waitFor(() => expect(mocks.qr).toHaveBeenCalledTimes(1))
  const poll = pollTimer.mock.calls.find(call => call[1] === 1000)![0] as () => void
  mocks.getStatus.mockResolvedValue(change === 'origin'
    ? { ...online, publicUrl: fixedAddress }
    : { ...online, state: 'reconnecting', publicUrl: null })
  await act(async () => { poll() })
  expect(screen.queryByText(`${quickAddress}/remote`)).not.toBeInTheDocument()
  mocks.getStatus.mockResolvedValue(online)
  await act(async () => { poll() })
  expect(screen.getByText(`${quickAddress}/remote`)).toBeInTheDocument()

  await act(async () => { image.resolve('data:image/png;base64,old-connection') })
  expect(mocks.copy).not.toHaveBeenCalled()
  expect(qrImage()).not.toBeInTheDocument()
})

it('hides an existing QR as soon as shutdown starts, before the gateway confirms it', async () => {
  const online = mockOnline()
  const stopped = { ...online, state: 'disabled', publicUrl: null }
  const stop = deferred<typeof stopped>()
  render(<PublicAccessSettings />)
  fireEvent.click(await screen.findByRole('button', { name: 'Connect a phone' }))
  await screen.findByAltText('Scan to pair this phone')
  mocks.stop.mockReturnValueOnce(stop.promise)
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
  expect(qrImage()).not.toBeInTheDocument()
  expect(mocks.stop).toHaveBeenCalledTimes(1)
  await act(async () => { mocks.getStatus.mockResolvedValue(stopped); stop.resolve(stopped) })
  expect(screen.getByRole('status')).toHaveTextContent('Off')
})

it.each(['failed', 'disabled'] as const)('does not strand a %s shutdown when other connection controls are clicked', async outcome => {
  const online = { ...savedStatus('named'), state: 'online', publicUrl: fixedAddress }
  const result = { ...online, state: outcome, publicUrl: null, error: outcome === 'failed' ? 'stop' : null }
  const closing = deferred<typeof result>()
  mocks.getStatus.mockResolvedValue(online)
  mocks.get.mockResolvedValue({
    enabled: true, port: 17463, publicUrl: fixedAddress,
    pending: [{ id: 'new-phone', name: 'New phone' }],
    devices: [{ id: 'old-phone', name: 'Old phone', createdAt: 1, expiresAt: Date.now() + 10000 }],
  })
  mocks.stop.mockReturnValueOnce(closing.promise)
  render(<PublicAccessSettings />)
  await screen.findByText('Connection ready')
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
  for (const name of ['Open Cloudflare', 'Official setup guide', 'Copy service address', 'Copy pairing link', 'Connect a phone', 'Approve', 'Reject', 'Revoke']) {
    fireEvent.click(screen.getByRole('button', { name }))
  }
  act(() => { screen.getByRole('switch', { name: 'Restore connection when the desktop starts' }).click() })
  await act(async () => {
    mocks.getStatus.mockResolvedValue(result)
    closing.resolve(result)
  })

  if (outcome === 'failed') {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Turn off' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
  }
  await screen.findByText('Off')
  expect(mocks.copy).not.toHaveBeenCalled()
  expect(mocks.open).not.toHaveBeenCalled()
  expect(mocks.pairing).not.toHaveBeenCalled()
  expect(mocks.approve).not.toHaveBeenCalled()
  expect(mocks.reject).not.toHaveBeenCalled()
  expect(mocks.revoke).not.toHaveBeenCalled()
  expect(mocks.setAutoStart).not.toHaveBeenCalled()

  fireEvent.click(enableButton())
  await screen.findByAltText('Scan to pair this phone')
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
  await screen.findByText('Off')
  expect(mocks.start).toHaveBeenCalledTimes(1)
  expect(mocks.stop).toHaveBeenCalledTimes(outcome === 'failed' ? 3 : 2)
  expect(enableButton()).not.toBeDisabled()
})

it('starts a quick connection after consent, without an account, address, token or installation steps', async () => {
  render(<PublicAccessSettings />)
  await waitFor(() => expect(enableButton()).not.toBeDisabled())
  expect(screen.getByRole('radio', { name: 'Quick connection' })).toHaveAttribute('aria-checked', 'true')
  expect(screen.queryByLabelText('Fixed HTTPS address')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Tunnel Token')).not.toBeInTheDocument()
  expect(screen.queryByText(/Tailscale|ngrok|PowerShell/)).not.toBeInTheDocument()
  expect(screen.getByLabelText('Local gateway port')).not.toBeVisible()
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.qr).not.toHaveBeenCalled()
  fireEvent.click(enableButton())
  const dialog = within(await screen.findByRole('dialog'))
  expect(dialog.getByText(/Traffic passes through Cloudflare/)).toBeInTheDocument()
  expect(mocks.start).not.toHaveBeenCalled()
  fireEvent.click(dialog.getByRole('button', { name: 'Agree and enable connection' }))
  await screen.findByAltText('Scan to pair this phone')
  expect(mocks.configure).not.toHaveBeenCalled()
  expect(mocks.start).toHaveBeenCalledWith(PUBLIC_ACCESS_CONSENT_VERSION)
  expect(mocks.qr).toHaveBeenCalledWith(`${quickAddress}/remote#pair=one-time`, expect.any(Object))
  expect(screen.getByRole('status')).toHaveTextContent('Connection ready')
  expect(mocks.setAutoStart).not.toHaveBeenCalled()
})

it('guides fixed-domain setup, copies the exact gateway address, and saves a masked token once', async () => {
  render(<PublicAccessSettings />)
  await waitFor(() => expect(enableButton()).not.toBeDisabled())
  chooseNamed()
  expect(enableButton()).toBeDisabled()
  expect(screen.getByText(/Networking → Tunnels/)).toBeVisible()
  expect(screen.getByText(/Published application route/)).toBeVisible()
  expect(screen.getByText('http://127.0.0.1:17463')).toBeVisible()
  fireEvent.click(screen.getByText('Change local port'))
  fireEvent.change(screen.getByLabelText('Local gateway port'), { target: { value: '18321' } })
  expect(screen.getByText('http://127.0.0.1:18321')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Copy service address' }))
  await screen.findByRole('button', { name: 'Service address copied' })
  expect(mocks.copy).toHaveBeenCalledWith('http://127.0.0.1:18321')
  fireEvent.click(screen.getByRole('button', { name: 'Open Cloudflare' }))
  expect(mocks.open).toHaveBeenCalledWith('https://dash.cloudflare.com/?to=/:account/tunnels')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Official setup guide' })).not.toBeDisabled())
  fireEvent.click(screen.getByRole('button', { name: 'Official setup guide' }))
  expect(mocks.open).toHaveBeenCalledWith('https://developers.cloudflare.com/tunnel/get-started/')
  await waitFor(() => expect(addressInput()).not.toBeDisabled())
  fireEvent.change(addressInput(), { target: { value: fixedAddress } })
  expect(enableButton()).toBeDisabled()
  expect(tokenInput()).toHaveAttribute('type', 'password')
  fireEvent.change(tokenInput(), { target: { value: 'eyJhIjoiZmFrZS10dW5uZWwtdG9rZW4tZm9yLXRlc3RzIn0' } })
  fireEvent.click(enableButton())
  await confirm()
  await screen.findByAltText('Scan to pair this phone')
  expect(mocks.configure).toHaveBeenCalledWith({ mode: 'named', customUrl: fixedAddress, localPort: 18321, tunnelToken: 'eyJhIjoiZmFrZS10dW5uZWwtdG9rZW4tZm9yLXRlc3RzIn0' })
  expect(mocks.qr).toHaveBeenCalledWith(`${fixedAddress}/remote#pair=one-time`, expect.any(Object))
  expect(tokenInput()).toHaveValue('')
  expect(screen.queryByText('eyJhIjoiZmFrZS10dW5uZWwtdG9rZW4tZm9yLXRlc3RzIn0')).not.toBeInTheDocument()
})

it.each([
  'http://phone.example.com', 'https://phone.example.com/remote', 'https://phone.example.com#pair=secret',
  'https://user:secret@phone.example.com', 'https://phone.example.com?token=secret',
])('rejects an invalid fixed address before saving or starting: %s', async url => {
  render(<PublicAccessSettings />)
  await waitFor(() => expect(enableButton()).not.toBeDisabled())
  chooseNamed()
  fireEvent.change(addressInput(), { target: { value: url } })
  fireEvent.change(tokenInput(), { target: { value: 'eyJhIjoiZmFrZS10dW5uZWwtdG9rZW4tZm9yLXRlc3RzIn0' } })
  expect(enableButton()).toBeDisabled()
  expect(screen.getByRole('alert')).toHaveTextContent('Enter a full HTTPS address')
  expect(mocks.configure).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
})

it('reuses a saved fixed-domain token without returning it to the input or requiring another save', async () => {
  mocks.getStatus.mockResolvedValue(savedStatus('named'))
  render(<PublicAccessSettings />)
  await waitFor(() => expect(addressInput()).toHaveValue(fixedAddress))
  expect(tokenInput()).toHaveValue('')
  expect(screen.getByText(/A token is saved on this computer/)).toBeVisible()
  fireEvent.click(enableButton())
  await screen.findByAltText('Scan to pair this phone')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(mocks.configure).not.toHaveBeenCalled()
})

it('rejects a pasted installation command instead of treating it as a Tunnel Token', async () => {
  render(<PublicAccessSettings />)
  await waitFor(() => expect(enableButton()).not.toBeDisabled())
  chooseNamed()
  fireEvent.change(addressInput(), { target: { value: fixedAddress } })
  fireEvent.change(tokenInput(), { target: { value: 'cloudflared service install private-token' } })
  expect(screen.getByRole('alert')).toHaveTextContent('Paste a valid Tunnel Token')
  expect(enableButton()).toBeDisabled()
  expect(mocks.configure).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
})

it('preserves the fixed-domain draft when switching to quick mode and back', async () => {
  render(<PublicAccessSettings />)
  await waitFor(() => expect(enableButton()).not.toBeDisabled())
  chooseNamed()
  fireEvent.change(addressInput(), { target: { value: fixedAddress } })
  fireEvent.change(tokenInput(), { target: { value: 'draft-token' } })
  fireEvent.click(screen.getByRole('radio', { name: 'Quick connection' }))
  expect(screen.queryByLabelText('Fixed HTTPS address')).not.toBeInTheDocument()
  chooseNamed()
  expect(addressInput()).toHaveValue(fixedAddress)
  expect(tokenInput()).toHaveValue('draft-token')
  expect(mocks.configure).not.toHaveBeenCalled()
})

it('explains migrated settings while leaving the quick connection ready for explicit enablement', async () => {
  mocks.getStatus.mockResolvedValue({ ...mocks.status, migrationRequired: true })
  render(<PublicAccessSettings />)
  await screen.findByText(/Remote access now uses Cloudflare/)
  expect(enableButton()).not.toBeDisabled()
  expect(mocks.start).not.toHaveBeenCalled()
  expect(screen.queryByText(/Tailscale|ngrok/)).not.toBeInTheDocument()
})

it('explicitly saves the approved quick defaults when saved settings could not be read', async () => {
  mocks.getStatus.mockResolvedValue({ ...mocks.status, state: 'unconfigured', error: 'configuration' })
  render(<PublicAccessSettings />)
  await waitFor(() => expect(enableButton()).not.toBeDisabled())
  fireEvent.click(enableButton())
  expect(mocks.configure).not.toHaveBeenCalled()
  await confirm()
  await screen.findByAltText('Scan to pair this phone')
  expect(mocks.configure).toHaveBeenCalledWith({ mode: 'quick', customUrl: '', localPort: 17463 })
  expect(mocks.start).toHaveBeenCalledTimes(1)
})

it('enters phone connection on Quick and keeps the LAN path available without enabling either', async () => {
  render(<H5AccessSettings />)
  expect(screen.getByRole('tab', { name: 'Away from home' })).toHaveAttribute('aria-selected', 'true')
  await waitFor(() => expect(enableButton()).not.toBeDisabled())
  expect(screen.getByRole('heading', { name: 'Cloudflare remote connection' })).toBeVisible()
  expect(screen.getByRole('radio', { name: 'Quick connection' })).toHaveAttribute('aria-checked', 'true')
  chooseNamed()
  fireEvent.change(addressInput(), { target: { value: fixedAddress } })
  fireEvent.click(screen.getByRole('tab', { name: 'Same Wi-Fi' }))
  expect(screen.getByRole('heading', { name: 'Local network' })).toBeVisible()
  fireEvent.click(screen.getByRole('tab', { name: 'Away from home' }))
  expect(addressInput()).toHaveValue(fixedAddress)
  expect(mocks.start).not.toHaveBeenCalled()
})

it.each(['Away from home', 'Same Wi-Fi'])('prepares the phone before desktop connection controls for %s', async method => {
  render(<H5AccessSettings />)
  await waitFor(() => expect(enableButton()).not.toBeDisabled())
  fireEvent.click(screen.getByRole('tab', { name: method }))
  const installation = screen.getByRole('heading', { name: 'Get cc-haha on your phone' })
  const methods = screen.getByRole('tablist', { name: 'Connection method' })
  expect(installation.compareDocumentPosition(methods) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const desktop = screen.getByRole('heading', { name: 'Then set up this computer' })
  expect(installation.compareDocumentPosition(desktop) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(desktop.compareDocumentPosition(methods) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByRole('tab', { name: method })).toHaveAttribute('aria-selected', 'true')
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.configure).not.toHaveBeenCalled()
})

it('moves phone-browser users to LAN and focuses its tab without enabling access', async () => {
  render(<H5AccessSettings />)
  await waitFor(() => expect(enableButton()).not.toBeDisabled())
  const lan = screen.getByRole('tab', { name: 'Same Wi-Fi' })
  const methods = document.getElementById(screen.getByRole('button', { name: 'Use phone browser' }).getAttribute('aria-controls')!)!
  const scrollIntoView = vi.fn()
  methods.scrollIntoView = scrollIntoView
  expect(screen.getByRole('button', { name: 'Download Android APK' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Join TestFlight beta' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Use phone browser' }))
  expect(lan).toHaveAttribute('aria-selected', 'true')
  expect(lan).toHaveFocus()
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
  expect(screen.getByRole('switch', { name: 'Enable local connection' })).not.toBeChecked()
  expect(mocks.configure).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
})

it('asks for confirmation when a saved fixed-domain address changes', async () => {
  mocks.getStatus.mockResolvedValue(savedStatus('named'))
  render(<PublicAccessSettings />)
  await waitFor(() => expect(addressInput()).toHaveValue(fixedAddress))
  fireEvent.change(addressInput(), { target: { value: 'https://new.example.com' } })
  expect(screen.getByRole('switch', { name: 'Restore connection when the desktop starts' })).toBeDisabled()
  fireEvent.click(enableButton())
  await screen.findByRole('dialog')
  expect(mocks.configure).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
})

it.each(['rejected', 'stale'] as const)('retains the fixed-domain draft and never starts after a %s configuration result', async result => {
  const previous = savedStatus('named')
  mocks.getStatus.mockResolvedValue(previous)
  if (result === 'rejected') mocks.configure.mockRejectedValueOnce(new Error('private upstream details'))
  else mocks.configure.mockResolvedValueOnce(previous)
  render(<PublicAccessSettings />)
  await waitFor(() => expect(addressInput()).toHaveValue(fixedAddress))
  fireEvent.change(addressInput(), { target: { value: 'https://new.example.com' } })
  fireEvent.click(enableButton())
  await confirm()
  await screen.findByRole('alert')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(addressInput()).toHaveValue('https://new.example.com')
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.pairing).not.toHaveBeenCalled()
  expect(screen.queryByText('private upstream details')).not.toBeInTheDocument()
  fireEvent.click(enableButton())
  await confirm()
  await screen.findByAltText('Scan to pair this phone')
  expect(mocks.configure).toHaveBeenCalledTimes(2)
  expect(mocks.start).toHaveBeenCalledTimes(1)
})

it('renders no connection controls in a browser', () => {
  host.kind = 'browser'
  const { container } = render(<PublicAccessSettings />)
  expect(container).toBeEmptyDOMElement()
})

it('keeps browser phone settings on the available LAN entry instead of an empty remote pane', () => {
  host.kind = 'browser'
  render(<H5AccessSettings />)
  expect(screen.getByRole('tab', { name: 'Same Wi-Fi' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('heading', { name: 'Local network' })).toBeVisible()
  expect(screen.getByRole('switch', { name: 'Enable local connection' })).not.toBeChecked()
  expect(mocks.start).not.toHaveBeenCalled()
})

it('uses an expiring fragment QR and approves, rejects or revokes only the selected phone', async () => {
  mocks.getStatus.mockResolvedValue({ ...savedStatus(), state: 'online', publicUrl: quickAddress })
  mocks.get.mockResolvedValue({ enabled: true, port: 17463, publicUrl: quickAddress, pending: [{ id: 'new-phone', name: 'New phone' }], devices: [{ id: 'old-phone', name: 'Old phone', createdAt: 1, expiresAt: Date.now() + 10000 }] })
  render(<PublicAccessSettings />)
  fireEvent.click(await screen.findByRole('button', { name: 'Connect a phone' }))
  await screen.findByAltText('Scan to pair this phone')
  expect(mocks.qr).toHaveBeenCalledWith(`${quickAddress}/remote#pair=one-time`, expect.any(Object))
  expect(document.body.textContent).not.toContain('#pair=one-time')
  for (const [label, action, id] of [['Approve', mocks.approve, 'new-phone'], ['Reject', mocks.reject, 'new-phone'], ['Revoke', mocks.revoke, 'old-phone']] as const) {
    await waitFor(() => expect(screen.getByRole('button', { name: label })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: label }))
    await waitFor(() => expect(action).toHaveBeenCalledWith(id))
  }
  expect(mocks.stop).not.toHaveBeenCalled()
})

it('shows a retryable startup failure without a QR or private upstream details', async () => {
  mocks.getStatus.mockResolvedValue(savedStatus())
  mocks.start.mockRejectedValueOnce(new Error('private upstream details'))
  render(<PublicAccessSettings />)
  await screen.findByText('Off')
  fireEvent.click(enableButton())
  await screen.findByRole('alert')
  expect(screen.queryByText('private upstream details')).not.toBeInTheDocument()
  expect(mocks.pairing).not.toHaveBeenCalled()
  await waitFor(() => expect(enableButton()).not.toBeDisabled())
  fireEvent.click(enableButton())
  await screen.findByAltText('Scan to pair this phone')
})

it('keeps settings frozen and permits another close attempt when shutdown is unconfirmed', async () => {
  const online = { ...savedStatus('named'), state: 'online', publicUrl: fixedAddress }
  mocks.getStatus.mockResolvedValue(online)
  mocks.get.mockResolvedValue({ enabled: true, port: 17463, publicUrl: fixedAddress, pending: [], devices: [] })
  mocks.stop.mockImplementationOnce(async () => {
    const failed = { ...online, state: 'failed', error: 'stop' }
    mocks.getStatus.mockResolvedValue(failed)
    return failed
  })
  render(<PublicAccessSettings />)
  await screen.findByText('Connection ready')
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Phones may still have access')
  expect(addressInput()).toBeDisabled()
  expect(tokenInput()).toBeDisabled()
  expect(screen.getByLabelText('Local gateway port')).toBeDisabled()
  expect(enableButton()).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Turn off' })).not.toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
  await screen.findByText('Off')
  expect(mocks.stop).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(addressInput()).not.toBeDisabled()
})

it('shows tunnel preparation and public verification without offering an early QR', async () => {
  const pollTimer = vi.spyOn(globalThis, 'setInterval')
  const disabled = savedStatus()
  const checking = { ...disabled, state: 'connecting', phase: 'checking' }
  mocks.getStatus.mockResolvedValue(disabled)
  let finishStart!: (value: unknown) => void
  mocks.start.mockImplementation(() => new Promise(resolve => { finishStart = resolve }))
  render(<PublicAccessSettings />)
  await screen.findByText('Off')
  fireEvent.click(enableButton())
  await screen.findByText('Preparing connection…')
  expect(screen.queryByAltText('Scan to pair this phone')).not.toBeInTheDocument()
  mocks.getStatus.mockResolvedValue(checking)
  const poll = pollTimer.mock.calls.find(call => call[1] === 1000)![0] as () => void
  await act(async () => { poll() })
  await screen.findByText('Checking phone access…')
  expect(mocks.pairing).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
  await screen.findByText('Off')
  await act(async () => { finishStart({ ...disabled, state: 'online', phase: null, publicUrl: quickAddress }) })
  expect(screen.getByRole('status')).toHaveTextContent('Off')
  expect(mocks.pairing).not.toHaveBeenCalled()
})

it('keeps the QR when a stale connecting poll finishes after startup', async () => {
  const pollTimer = vi.spyOn(globalThis, 'setInterval')
  const disabled = savedStatus()
  const online = { ...disabled, state: 'online', publicUrl: quickAddress }
  mocks.getStatus.mockResolvedValue(disabled)
  let finishStart!: (value: unknown) => void
  mocks.start.mockImplementation(() => new Promise(resolve => { finishStart = resolve }))
  render(<PublicAccessSettings />)
  await screen.findByText('Off')
  fireEvent.click(enableButton())
  await waitFor(() => expect(mocks.start).toHaveBeenCalled())
  let finishPoll!: (details: unknown) => void
  mocks.get.mockImplementationOnce(() => new Promise(resolve => { finishPoll = resolve }))
  const poll = pollTimer.mock.calls.find(call => call[1] === 1000)![0] as () => void
  await act(async () => { poll() })
  mocks.getStatus.mockResolvedValue(online)
  await act(async () => { finishStart(online) })
  await screen.findByAltText('Scan to pair this phone')
  await act(async () => { finishPoll({ enabled: true, port: 17463, pending: [], devices: [] }) })
  expect(screen.getByAltText('Scan to pair this phone')).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('Connection ready')
})

it('explains a proxy failure and links to the existing network settings', async () => {
  const openSettings = vi.spyOn(useUIStore.getState(), 'setActiveSettingsTab')
  mocks.getStatus.mockResolvedValue({ ...savedStatus(), state: 'failed', error: 'proxy' })
  render(<PublicAccessSettings />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not connect through the proxy')
  fireEvent.click(screen.getByRole('button', { name: 'Network proxy settings' }))
  expect(openSettings).toHaveBeenCalledWith('general')
  expect(mocks.start).not.toHaveBeenCalled()
})
