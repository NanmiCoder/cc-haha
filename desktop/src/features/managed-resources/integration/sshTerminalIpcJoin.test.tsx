import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { StrictMode } from 'react'
import { generateKeyPairSync } from 'node:crypto'
import { Server as SshServer } from 'ssh2'
import { createHostWorkbenchHarness } from '../../../test/hostWorkbenchHarness'
import { useHostSshStore } from '../stores/hostSshStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { SshConsole } from '../ui/hosts/SshConsole'
import { ELECTRON_IPC_CHANNELS } from '../../../../electron/ipc/channels'

const terminal = vi.hoisted(() => ({ output: [] as Uint8Array[], inputs: new Set<(data: string) => void>() }))
// Only the canvas terminal boundary is replaced in jsdom. The store,
// DesktopHost, IPC registration, SSH client and loopback server are real.
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  private listeners = new Set<(data: string) => void>()
  loadAddon() {}
  open(element: HTMLElement) {
    const input = document.createElement('textarea')
    input.setAttribute('aria-label', 'Fixture terminal keyboard')
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') for (const listener of this.listeners) listener('\r')
    })
    input.addEventListener('input', () => {
      for (const listener of this.listeners) listener(input.value)
      input.value = ''
    })
    element.appendChild(input)
  }
  focus() {}
  write(bytes: Uint8Array, callback?: () => void) { terminal.output.push(bytes); callback?.() }
  writeln() {}
  onData(listener: (data: string) => void) {
    this.listeners.add(listener)
    terminal.inputs.add(listener)
    return { dispose: () => { this.listeners.delete(listener); terminal.inputs.delete(listener) } }
  }
  onResize() { return { dispose() {} } }
  dispose() { for (const listener of this.listeners) terminal.inputs.delete(listener); this.listeners.clear() }
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))

let fixture: Awaited<ReturnType<typeof createHostWorkbenchHarness>>
let server: SshServer
const peers = new Set<import('ssh2').Connection>()
let received: Buffer[]
let port: number
function output() { return Buffer.concat(terminal.output.map(bytes => Buffer.from(bytes))).toString('utf8') }

beforeEach(async () => {
  terminal.output.length = 0
  terminal.inputs.clear()
  received = []
  useSettingsStore.setState({ locale: 'en' })
  useHostSshStore.getState().teardownAll()
  fixture = await createHostWorkbenchHarness()
  const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey
  server = new SshServer({ hostKeys: [key] }, client => {
    peers.add(client)
    client.on('error', () => {})
    client.on('close', () => peers.delete(client))
    client.on('authentication', context => {
      if (context.method === 'password' && context.username === 'fixture' && context.password === 'SSH_JOIN_FAKE_ONLY') context.accept()
      else context.reject(['password'])
    })
    client.on('ready', () => client.on('session', accept => {
      const session = accept()
      session.on('pty', acceptPty => acceptPty())
      session.on('window-change', acceptResize => acceptResize?.())
      session.on('shell', acceptShell => {
        const channel = acceptShell()
        channel.on('data', (bytes: Buffer) => { received.push(Buffer.from(bytes)); channel.write(bytes) })
      })
    }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve() })
  })
})

afterEach(async () => {
  cleanup()
  useHostSshStore.getState().teardownAll()
  await fixture?.dispose()
  for (const peer of peers) peer.end()
  peers.clear()
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
})

describe('SSH terminal DOM -> DesktopHost -> IPC -> loopback', () => {
  it('forwards each input and echo once, including identical commands and repeated starts', async () => {
    const created = await fixture.host.hostManagement.saveHost({
      name: 'Loopback terminal fixture', address: '127.0.0.1', port, username: 'fixture',
      auth: { type: 'password', credentialId: null }, tagIds: [], initialDirectory: '/', applications: [], notes: '',
      credential: { storage: 'vault', secret: { kind: 'ssh-password', password: 'SSH_JOIN_FAKE_ONLY' } },
    })
    if (!created.ok) throw new Error(`Fixture host creation failed: ${created.error.code}`)
    const host = created.data
    render(<StrictMode><SshConsole host={host} /></StrictMode>)
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }))
    const trust = await screen.findByRole('button', { name: /trust.*continue/i }, { timeout: 6000 })
    const challenge = useHostSshStore.getState().byHostId[host.id]!.challenge
    await act(async () => {
      await fixture.host.hostManagement.startConnection({ connectionId: useHostSshStore.getState().byHostId[host.id]!.connectionId! })
    })
    expect(useHostSshStore.getState().byHostId[host.id]!.challenge).toEqual(challenge)
    fireEvent.click(trust)
    await waitFor(() => expect(useHostSshStore.getState().byHostId[host.id]?.status).toBe('ready'), { timeout: 6000 })
    expect(terminal.inputs.size).toBe(1)
    const session = useHostSshStore.getState().byHostId[host.id]!

    // A retry of an already-active start is idempotent, including subscriptions.
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        expect((await fixture.host.hostManagement.startConnection({ connectionId: session.connectionId! })).ok).toBe(true)
      })
    }
    for (let count = 1; count <= 2; count++) {
      const keyboard = screen.getByRole('textbox', { name: 'Fixture terminal keyboard' })
      fireEvent.input(keyboard, { target: { value: 'll' } })
      fireEvent.keyDown(keyboard, { key: 'Enter' })
      await waitFor(() => expect(Buffer.concat(received).toString('utf8')).toBe('ll\r'.repeat(count)))
      await waitFor(() => expect(output()).toBe('ll\r'.repeat(count)))
      expect(fixture.calls.filter(channel => channel === ELECTRON_IPC_CHANNELS.mrWriteConnection)).toHaveLength(count * 2)
    }
    fireEvent.input(screen.getByRole('textbox', { name: 'Fixture terminal keyboard' }), { target: { value: '中文\u0003' } })
    await waitFor(() => expect(output()).toBe('ll\rll\r中文\u0003'))
    fireEvent.click(screen.getByRole('button', { name: /^disconnect$/i }))
    await waitFor(() => expect(useHostSshStore.getState().byHostId[host.id]?.status).toBe('closed'))
    expect(terminal.inputs.size).toBe(0)
  }, 15000)
})
