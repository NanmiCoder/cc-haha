import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import '@testing-library/jest-dom'

const terminalState = vi.hoisted(() => ({
  constructed: 0,
  opened: 0,
  disposed: 0,
  writes: [] as unknown[],
  lines: [] as string[],
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class FakeTerminal {
    constructor() { terminalState.constructed += 1 }
    loadAddon() {}
    open() { terminalState.opened += 1 }
    write(value: unknown, callback?: () => void) { terminalState.writes.push(value); callback?.() }
    writeln(value: string) { terminalState.lines.push(value) }
    onData() { return { dispose() {} } }
    onResize() { return { dispose() {} } }
    dispose() { terminalState.disposed += 1 }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class FakeFitAddon { fit() {} },
}))

import { browserHost } from '../../../../lib/desktopHost/browserHost'
import { useSettingsStore } from '../../../../stores/settingsStore'
import { useHostSshStore } from '../../stores/hostSshStore'
import type { Host, HostManagementEvent } from '../../types/resourceTypes'
import { SshConsole } from './SshConsole'

const host: Host = {
  id: '11111111-1111-4111-8111-111111111111',
  revision: 1,
  createdAt: '2026-09-13T00:00:00.000Z',
  updatedAt: '2026-09-13T00:00:00.000Z',
  name: 'Fixture SSH host',
  address: '127.0.0.1',
  port: 22,
  username: 'fixture',
  auth: { type: 'password', credentialId: null },
  tagIds: [],
  initialDirectory: '/',
  applications: [],
  notes: '',
}

function installHostFixture(options: { failFirstGeneration?: boolean; deferTerminalSubscription?: boolean } = {}) {
  const listeners = new Set<(event: HostManagementEvent) => void>()
  const pendingSubscriptions: Array<() => void> = []
  let subscriptions = 0
  let startCalls = 0
  let createCalls = 0
  let disconnectCalls = 0
  const ackCalls: Array<{ connectionId: string; generation: number; bytesAcked: number }> = []
  const connectionId = '22222222-2222-4222-8222-222222222222'
  const emit = (event: HostManagementEvent) => listeners.forEach(listener => listener(event))
  const hostManagement = {
    ...browserHost.hostManagement,
    async onEvent(listener: (event: HostManagementEvent) => void) {
      listeners.add(listener)
      subscriptions += 1
      const unlisten = () => { listeners.delete(listener) }
      if (options.deferTerminalSubscription && subscriptions > 1) {
        return new Promise<() => void>(resolve => pendingSubscriptions.push(() => resolve(unlisten)))
      }
      return unlisten
    },
    async createConnection() {
      createCalls += 1
      return { ok: true as const, data: { connectionId, generation: 1 } }
    },
    async startConnection() {
      startCalls += 1
      if (options.failFirstGeneration && startCalls === 1) {
        emit({ type: 'connection-state', connectionId, generation: 1, status: 'failed', error: 'AUTH_FAILED' })
      } else {
        emit({ type: 'connection-state', connectionId, generation: startCalls, status: 'ready' })
      }
      return { ok: true as const, data: undefined }
    },
    async disconnect() {
      disconnectCalls += 1
      emit({ type: 'connection-state', connectionId, generation: Math.max(1, startCalls), status: 'closing' })
      emit({ type: 'connection-state', connectionId, generation: Math.max(1, startCalls), status: 'closed' })
      return { ok: true as const, data: undefined }
    },
    async writeConnection() { return { ok: true as const, data: undefined } },
    async resizeConnection() { return { ok: true as const, data: undefined } },
    async ackOutput(input: { connectionId: string; generation: number; bytesAcked: number }) {
      ackCalls.push(input)
      return { ok: true as const, data: undefined }
    },
  }
  ;(window as any).desktopHost = { ...browserHost, hostManagement }
  return {
    emit,
    ackCalls,
    settleSubscriptions() { for (const settle of pendingSubscriptions.splice(0)) settle() },
    get listenerCount() { return listeners.size },
    get startCalls() { return startCalls },
    get createCalls() { return createCalls },
    get disconnectCalls() { return disconnectCalls },
  }
}

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  useHostSshStore.getState().teardownAll()
  terminalState.constructed = 0
  terminalState.opened = 0
  terminalState.disposed = 0
  terminalState.writes.length = 0
  terminalState.lines.length = 0
})

afterEach(() => {
  cleanup()
  useHostSshStore.getState().teardownAll()
  ;(window as any).desktopHost = undefined
})

describe('M3 SshConsole production join', () => {
  it('mounts xterm after the real connect action creates a connection and acks terminal output', async () => {
    // The terminal surface must be visibly sized even before a connection is allocated.
    const fixture = installHostFixture()
    const view = render(<SshConsole host={host} />)
    expect(terminalState.constructed).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }))
    await waitFor(() => expect(terminalState.constructed).toBe(1))
    expect(terminalState.opened).toBe(1)
    expect(fixture.createCalls).toBe(1)
    expect(fixture.startCalls).toBe(1)

    fixture.emit({
      type: 'terminal-output',
      connectionId: '22222222-2222-4222-8222-222222222222',
      generation: 1,
      seq: 1,
      data: Buffer.from('hello from loopback').toString('base64'),
      byteLength: Buffer.byteLength('hello from loopback'),
    })
    await waitFor(() => expect(terminalState.writes).toHaveLength(1))
    await waitFor(() => expect(fixture.ackCalls).toHaveLength(1))
    expect(fixture.ackCalls[0]?.bytesAcked).toBe(Buffer.byteLength('hello from loopback'))

    view.unmount()
    expect(terminalState.disposed).toBe(1)
  })

  it('cleans late asynchronous event subscriptions after StrictMode remount and unmount', async () => {
    const fixture = installHostFixture({ deferTerminalSubscription: true })
    await useHostSshStore.getState().start(host, 80, 24)
    const view = render(<StrictMode><SshConsole host={host} /></StrictMode>)
    expect(terminalState.constructed - terminalState.disposed).toBe(1)
    await act(async () => { fixture.settleSubscriptions() })
    expect(fixture.listenerCount).toBe(2) // one store + one live terminal
    await act(async () => {
      fixture.emit({ type: 'terminal-output', connectionId: '22222222-2222-4222-8222-222222222222', generation: 0, seq: 1, data: 'b2xk', byteLength: 3 })
    })
    expect(terminalState.writes).toHaveLength(0)
    expect(fixture.ackCalls).toHaveLength(0)
    view.unmount()
    expect(fixture.listenerCount).toBe(1)
    expect(terminalState.constructed).toBe(terminalState.disposed)
  })

  it('renders a MobaXterm-style visible terminal surface before connecting', () => {
    installHostFixture()
    render(<SshConsole host={host} />)
    const terminalRegion = screen.getByRole('region', { name: /ssh terminal output/i })
    expect(terminalRegion.parentElement).toHaveClass('min-h-[360px]')
    expect(screen.getByText(/click connect to open an interactive ssh terminal/i)).toBeInTheDocument()
    expect(screen.getByText('fixture@127.0.0.1:22')).toBeInTheDocument()
  })

  it('shows an explicit host-key fingerprint prompt and clears it when authentication continues', async () => {
    const fixture = installHostFixture()
    render(<SshConsole host={host} />)
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }))
    await waitFor(() => expect(document.querySelector('[data-status="ready"]')).toBeInTheDocument())

    fixture.emit({
      type: 'connection-state',
      connectionId: '22222222-2222-4222-8222-222222222222',
      generation: 1,
      status: 'awaiting_host_key',
      hostKeyChallenge: {
        challengeId: '33333333-3333-4333-8333-333333333333',
        endpoint: '127.0.0.1:22',
        algorithm: 'ssh-ed25519',
        fingerprint: 'fixtureFingerprint123',
      },
    })

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getByText('SHA256:fixtureFingerprint123')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /trust.*continue/i })).toBeInTheDocument()

    fixture.emit({
      type: 'connection-state',
      connectionId: '22222222-2222-4222-8222-222222222222',
      generation: 1,
      status: 'authenticating',
    })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())

    fixture.emit({
      type: 'connection-state',
      connectionId: '22222222-2222-4222-8222-222222222222',
      generation: 1,
      status: 'failed',
      error: 'HOST_KEY_TIMEOUT',
    })
    expect(await screen.findByText(/timed out waiting for host-key confirmation/i)).toBeInTheDocument()
    expect(screen.queryByText(/host denied \(verification failed\)/i)).not.toBeInTheDocument()
  })

  it('keeps the terminal state closed after disconnect instead of overwriting the closed event with closing', async () => {
    const fixture = installHostFixture()
    render(<SshConsole host={host} />)
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }))
    await waitFor(() => expect(document.querySelector('[data-status="ready"]')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /^disconnect$/i }))
    await waitFor(() => expect(document.querySelector('[data-status="closed"]')).toBeInTheDocument())
    expect(fixture.disconnectCalls).toBe(1)
    expect(useHostSshStore.getState().byHostId[host.id]?.connectionId).toBeNull()
    expect(screen.getByRole('button', { name: /^connect$/i })).toBeInTheDocument()
  })

  it('retries a failed SSH generation through the existing connection without allocating another session', async () => {
    const fixture = installHostFixture({ failFirstGeneration: true })
    render(<SshConsole host={host} />)

    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }))
    await waitFor(() => expect(document.querySelector('[data-status="failed"]')).toBeInTheDocument())
    expect(fixture.createCalls).toBe(1)
    expect(fixture.startCalls).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }))
    await waitFor(() => expect(document.querySelector('[data-status="ready"]')).toBeInTheDocument())
    expect(fixture.createCalls).toBe(1)
    expect(fixture.startCalls).toBe(2)
  })
})
