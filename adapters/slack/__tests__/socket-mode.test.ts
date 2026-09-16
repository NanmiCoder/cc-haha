import { afterEach, describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import type WebSocket from 'ws'
import { SlackSocketMode, type SocketEnvelope } from '../socket-mode.js'

class FakeSocket extends EventEmitter {
  readyState = 1 // WebSocket.OPEN
  sent: string[] = []
  closedWith: Array<[number, string]> = []

  send(payload: string): void {
    this.sent.push(payload)
  }

  close(code: number, reason: string): void {
    this.closedWith.push([code, reason])
    this.readyState = 3
    this.emit('close')
  }

  deliver(envelope: SocketEnvelope): void {
    this.emit('message', Buffer.from(JSON.stringify(envelope)))
  }
}

const sockets: FakeSocket[] = []
let started: SlackSocketMode | null = null

function createSocketMode(options: {
  onEnvelope?: (envelope: SocketEnvelope) => void
  openConnection?: () => Promise<string>
} = {}) {
  const received: SocketEnvelope[] = []
  const opened: string[] = []
  const mode = new SlackSocketMode({
    openConnection: options.openConnection
      ?? (async () => {
        opened.push('wss://wss.slack.com/link')
        return 'wss://wss.slack.com/link'
      }),
    onEnvelope: options.onEnvelope ?? ((envelope) => received.push(envelope)),
    createWebSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
    logPrefix: '[Test]',
  })
  started = mode
  return { mode, received, opened }
}

afterEach(() => {
  started?.stop()
  started = null
  sockets.length = 0
})

describe('SlackSocketMode', () => {
  it('acknowledges an envelope before handing it to the handler', async () => {
    const order: string[] = []
    const { mode } = createSocketMode({
      onEnvelope: () => order.push('handled'),
    })
    await mode.start()
    const socket = sockets[0]!
    socket.send = (payload: string) => {
      order.push('acked')
      socket.sent.push(payload)
    }

    socket.deliver({ type: 'events_api', envelope_id: 'env-1', payload: {} })

    // Slack redelivers anything unacked within three seconds, and handling can
    // take far longer than that — so the ack must not wait on the handler.
    expect(order).toEqual(['acked', 'handled'])
    expect(JSON.parse(socket.sent[0]!)).toEqual({ envelope_id: 'env-1' })
  })

  it('passes an events_api envelope to the handler', async () => {
    const { mode, received } = createSocketMode()
    await mode.start()

    sockets[0]!.deliver({
      type: 'events_api',
      envelope_id: 'env-1',
      payload: { event: { type: 'message', text: 'hi' } },
    })

    expect(received).toHaveLength(1)
    expect(received[0]!.payload?.event).toMatchObject({ text: 'hi' })
  })

  it('swallows the hello frame instead of routing it as an event', async () => {
    const { mode, received } = createSocketMode()
    await mode.start()

    sockets[0]!.deliver({ type: 'hello' })

    expect(received).toHaveLength(0)
  })

  it('reconnects with a freshly opened URL when Slack asks it to', async () => {
    let opens = 0
    const { mode } = createSocketMode({
      openConnection: async () => {
        opens += 1
        return 'wss://wss.slack.com/link'
      },
    })
    await mode.start()
    expect(opens).toBe(1)

    sockets[0]!.deliver({ type: 'disconnect', envelope_id: 'env-2', reason: 'refresh_requested' })
    await new Promise((resolve) => setTimeout(resolve, 1_200))

    expect(sockets[0]!.closedWith[0]![1]).toBe('slack requested reconnect')
    expect(opens).toBe(2)
  })

  it('does not reconnect after stop()', async () => {
    let opens = 0
    const { mode } = createSocketMode({
      openConnection: async () => {
        opens += 1
        return 'wss://wss.slack.com/link'
      },
    })
    await mode.start()
    mode.stop()

    await new Promise((resolve) => setTimeout(resolve, 1_200))

    expect(opens).toBe(1)
  })

  it('survives a malformed frame without dropping the connection', async () => {
    const { mode, received } = createSocketMode()
    await mode.start()

    sockets[0]!.emit('message', Buffer.from('not json'))
    sockets[0]!.deliver({ type: 'events_api', envelope_id: 'env-3', payload: {} })

    expect(received).toHaveLength(1)
  })

  it('schedules a reconnect when opening the connection fails', async () => {
    let attempts = 0
    const { mode } = createSocketMode({
      openConnection: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('rate limited')
        return 'wss://wss.slack.com/link'
      },
    })
    await mode.start()

    expect(sockets).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(attempts).toBe(2)
    expect(sockets).toHaveLength(1)
  })
})
