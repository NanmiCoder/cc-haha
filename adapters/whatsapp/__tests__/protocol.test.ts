import { describe, it, expect } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { pollWhatsAppLoginWithQr, startWhatsAppLoginWithQr } from '../protocol.js'
import type { WhatsAppSocket } from '../session.js'

type ConnectionUpdate = {
  qr?: string
  connection?: 'open' | 'close'
  lastDisconnect?: { error: unknown }
}

type FakeSocket = {
  sock: WhatsAppSocket
  emit: (update: ConnectionUpdate) => Promise<void>
}

function makeFakeSocket(): FakeSocket {
  const handlers: Array<(update: ConnectionUpdate) => void | Promise<void>> = []
  const sock = {
    user: { id: '8613800000000:1@s.whatsapp.net' },
    ev: {
      on: (event: string, handler: (update: ConnectionUpdate) => void | Promise<void>) => {
        if (event === 'connection.update') handlers.push(handler)
      },
    },
    end: () => {},
  }
  return {
    sock: sock as unknown as WhatsAppSocket,
    emit: async (update) => {
      for (const handler of handlers) await handler(update)
    },
  }
}

function makeFakeSocketFactory() {
  const sockets: FakeSocket[] = []
  const createSocket = async () => {
    const fake = makeFakeSocket()
    sockets.push(fake)
    return fake.sock
  }
  return { sockets, createSocket }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function makeTempAuthDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-protocol-test-'))
}

const restartError = (statusCode: number) => ({ output: { statusCode } })

describe('whatsapp login protocol', () => {
  it('recreates the socket after post-pairing restart (515) and completes login', async () => {
    const { sockets, createSocket } = makeFakeSocketFactory()
    const authDir = makeTempAuthDir()

    const startPromise = startWhatsAppLoginWithQr({ authDir, createSocket })
    await waitFor(() => sockets.length === 1)
    await sockets[0].emit({ qr: 'qr-1' })
    const start = await startPromise
    expect(start.qr).toBe('qr-1')

    // Scan succeeds -> Baileys closes the socket with DisconnectReason.restartRequired (515).
    await sockets[0].emit({
      connection: 'close',
      lastDisconnect: { error: restartError(515) },
    })

    // The login flow must recreate the socket instead of failing.
    await waitFor(() => sockets.length === 2)
    await sockets[1].emit({ connection: 'open' })

    const poll = await pollWhatsAppLoginWithQr({ sessionKey: start.sessionKey })
    expect(poll.connected).toBe(true)
    if (poll.connected) {
      expect(poll.accountJid).toBe('8613800000000:1@s.whatsapp.net')
      expect(poll.authDir).toBe(path.resolve(authDir))
    }
  })

  it('recreates the socket after QR timeout (408) and serves a fresh QR', async () => {
    const { sockets, createSocket } = makeFakeSocketFactory()
    const authDir = makeTempAuthDir()

    const startPromise = startWhatsAppLoginWithQr({ authDir, createSocket })
    await waitFor(() => sockets.length === 1)
    await sockets[0].emit({ qr: 'qr-1' })
    const start = await startPromise

    await sockets[0].emit({
      connection: 'close',
      lastDisconnect: { error: restartError(408) },
    })

    await waitFor(() => sockets.length === 2)
    await sockets[1].emit({ qr: 'qr-2' })

    const poll = await pollWhatsAppLoginWithQr({ sessionKey: start.sessionKey })
    expect(poll.connected).toBe(false)
    if (!poll.connected) {
      expect(poll.status).toBe('waiting')
      expect(poll.qr).toBe('qr-2')
    }
  })

  it('reports an error when the connection closes with a non-restart status', async () => {
    const { sockets, createSocket } = makeFakeSocketFactory()
    const authDir = makeTempAuthDir()

    const startPromise = startWhatsAppLoginWithQr({ authDir, createSocket })
    await waitFor(() => sockets.length === 1)
    await sockets[0].emit({ qr: 'qr-1' })
    const start = await startPromise

    await sockets[0].emit({
      connection: 'close',
      lastDisconnect: { error: restartError(500) },
    })

    const poll = await pollWhatsAppLoginWithQr({ sessionKey: start.sessionKey })
    expect(poll.connected).toBe(false)
    if (!poll.connected) {
      expect(poll.status).toBe('error')
      expect(poll.message).toContain('connection closed')
    }
    expect(sockets.length).toBe(1)
  })

  it('reports logged out instead of restarting', async () => {
    const { sockets, createSocket } = makeFakeSocketFactory()
    const authDir = makeTempAuthDir()

    const startPromise = startWhatsAppLoginWithQr({ authDir, createSocket })
    await waitFor(() => sockets.length === 1)
    await sockets[0].emit({ qr: 'qr-1' })
    const start = await startPromise

    await sockets[0].emit({
      connection: 'close',
      lastDisconnect: { error: restartError(401) },
    })

    const poll = await pollWhatsAppLoginWithQr({ sessionKey: start.sessionKey })
    expect(poll.connected).toBe(false)
    if (!poll.connected) {
      expect(poll.status).toBe('error')
      expect(poll.message).toContain('logged out')
    }
    expect(sockets.length).toBe(1)
  })

  it('stops restarting after the restart limit and reports an error', async () => {
    const { sockets, createSocket } = makeFakeSocketFactory()
    const authDir = makeTempAuthDir()

    const startPromise = startWhatsAppLoginWithQr({ authDir, createSocket })
    await waitFor(() => sockets.length === 1)
    await sockets[0].emit({ qr: 'qr-1' })
    const start = await startPromise

    for (let i = 0; i < 5; i++) {
      await sockets[i].emit({
        connection: 'close',
        lastDisconnect: { error: restartError(408) },
      })
      await waitFor(() => sockets.length === i + 2)
    }
    await sockets[5].emit({
      connection: 'close',
      lastDisconnect: { error: restartError(408) },
    })

    const poll = await pollWhatsAppLoginWithQr({ sessionKey: start.sessionKey })
    expect(poll.connected).toBe(false)
    if (!poll.connected) {
      expect(poll.status).toBe('error')
    }
    expect(sockets.length).toBe(6)
  })
})
