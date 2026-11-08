import { describe, expect, test } from 'bun:test'
import type { SessionConnection, WebSocketData } from './handler.js'
import {
  createResumableSocketHandler,
  parseResumeRequest,
  RESUME_LIMITS,
  STREAM_NOT_RESUMABLE_CLOSE_CODE,
  STREAM_SUPERSEDED_CLOSE_CODE,
  type ResumeRequest,
} from './resumableStreams.js'

const STREAM = 'AAAAAAAAAAAAAAAAAAAAAA'
const OTHER = 'BBBBBBBBBBBBBBBBBBBBBB'
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

class FakeSocket {
  sent: string[] = []
  closed?: { code?: number; reason?: string }
  constructor(public data: WebSocketData & { resume?: ResumeRequest; remoteDeviceId?: string; terminal?: boolean }) {}
  send(text: string) {
    if (this.closed) return 0
    this.sent.push(text)
    return text.length
  }
  close(code?: number, reason?: string) {
    this.closed ??= { code, reason }
  }
  frames() {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>)
  }
}

/** A stand-in for the session handler: records what it sees and lets a test emit output. */
function fakeInner() {
  const opened: SessionConnection[] = []
  const closed: { ws: SessionConnection; code: number; reason: string }[] = []
  const received: { ws: SessionConnection; text: string }[] = []
  return {
    opened,
    closed,
    received,
    handler: {
      maxPayloadLength: 1234,
      open(ws: SessionConnection) {
        opened.push(ws)
        ws.send(JSON.stringify({ type: 'connected', sessionId: ws.data.sessionId }))
      },
      message(ws: SessionConnection, message: string | Buffer) {
        received.push({ ws, text: String(message) })
      },
      close(ws: SessionConnection, code: number, reason: string) {
        closed.push({ ws, code, reason })
      },
    },
  }
}

function timers() {
  const jobs = new Map<number, () => void>()
  let id = 0
  return {
    set: (callback: () => void) => {
      jobs.set(++id, callback)
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clear: (timer: ReturnType<typeof setTimeout>) => {
      jobs.delete(timer as unknown as number)
    },
    fire: () => {
      for (const [key, run] of [...jobs]) {
        jobs.delete(key)
        run()
      }
    },
    size: () => jobs.size,
  }
}

function socket(resume?: ResumeRequest, extra: Partial<WebSocketData> & { remoteDeviceId?: string } = {}) {
  return new FakeSocket({
    sessionId: 'session',
    connectedAt: 0,
    channel: 'client',
    clientKind: 'full',
    sdkToken: null,
    serverPort: 1,
    serverHost: '127.0.0.1',
    ...(resume ? { resume } : {}),
    ...extra,
  })
}

function setup(limits = {}) {
  const inner = fakeInner()
  const clock = timers()
  const handler = createResumableSocketHandler(inner.handler, {
    epoch: 'epoch1',
    limits,
    setTimer: clock.set,
    clearTimer: clock.clear,
  })
  return { inner, clock, handler }
}

describe('resumable session streams', () => {
  test('a client that does not opt in is passed through byte for byte', () => {
    const { inner, handler } = setup()
    const ws = socket()
    handler.open(ws)
    expect(inner.opened).toEqual([ws as unknown as SessionConnection])
    expect(ws.sent).toEqual([JSON.stringify({ type: 'connected', sessionId: 'session' })])
    handler.message(ws, '{"type":"ping"}')
    expect(inner.received[0]!.text).toBe('{"type":"ping"}')
    handler.close(ws, 1006, '')
    expect(inner.closed).toHaveLength(1)
    expect(handler.maxPayloadLength).toBe(1234)
  })

  test('a new stream announces itself first, then numbers every handler frame', () => {
    const { inner, handler } = setup()
    const ws = socket({ streamId: STREAM, ack: 0 })
    handler.open(ws)
    const virtual = inner.opened[0]!
    expect(virtual).not.toBe(ws as unknown as SessionConnection)
    virtual.send(JSON.stringify({ type: 'status', state: 'idle' }))
    expect(ws.frames()).toEqual([
      { type: 'stream_attached', v: 1, stream: STREAM, epoch: 'epoch1', resumed: false, reason: 'new', cack: 0, next: 1, last: 0 },
      { seq: 1, type: 'connected', sessionId: 'session' },
      { seq: 2, type: 'status', state: 'idle' },
    ])
  })

  test('a dropped socket reattaches and receives exactly the frames it missed, without reopening the session', () => {
    const { inner, handler } = setup()
    const first = socket({ streamId: STREAM, ack: 0 })
    handler.open(first)
    const virtual = inner.opened[0]!
    virtual.send('{"type":"content_delta","text":"a"}')
    handler.close(first, 1006, '')
    virtual.send('{"type":"content_delta","text":"b"}')
    virtual.send('{"type":"message_complete"}')
    const second = socket({ streamId: STREAM, ack: 2, epoch: 'epoch1' })
    handler.open(second)
    expect(second.frames()).toEqual([
      { type: 'stream_attached', v: 1, stream: STREAM, epoch: 'epoch1', resumed: true, cack: 0, next: 3, last: 4 },
      { seq: 3, type: 'content_delta', text: 'b' },
      { seq: 4, type: 'message_complete' },
    ])
    expect(inner.opened).toHaveLength(1)
    expect(inner.closed).toHaveLength(0)
    virtual.send('{"type":"status","state":"idle"}')
    expect(second.frames().at(-1)).toEqual({ seq: 5, type: 'status', state: 'idle' })
  })

  test('stream_end closes the session connection exactly once', () => {
    const { inner, handler } = setup()
    const ws = socket({ streamId: STREAM, ack: 0 })
    handler.open(ws)
    handler.message(ws, '{"type":"stream_end"}')
    handler.close(ws, 1000, 'Client disconnected')
    expect(inner.closed.map((item) => item.reason)).toEqual(['Client ended stream'])
    expect(ws.closed?.code).toBe(1000)
  })

  test('a stream nobody comes back for ends when its window expires', () => {
    const { inner, handler, clock } = setup()
    const ws = socket({ streamId: STREAM, ack: 0 })
    handler.open(ws)
    handler.close(ws, 1006, '')
    expect(inner.closed).toHaveLength(0)
    clock.fire()
    expect(inner.closed).toHaveLength(1)
    expect(handler.streamCount).toBe(0)
  })

  test('overflowing the buffer while detached ends the stream; a later resume is refused', async () => {
    const { inner, handler } = setup({ frames: 3 })
    const first = socket({ streamId: STREAM, ack: 0 })
    handler.open(first)
    const virtual = inner.opened[0]!
    handler.close(first, 1006, '')
    for (let i = 0; i < 4; i++) virtual.send(`{"type":"content_delta","text":"${i}"}`)
    await flush()
    expect(inner.closed).toHaveLength(1)
    const second = socket({ streamId: STREAM, ack: 1, epoch: 'epoch1' })
    handler.open(second)
    expect(second.frames()).toEqual([
      { type: 'stream_attached', v: 1, stream: STREAM, epoch: 'epoch1', resumed: false, reason: 'expired', cack: 0, next: 1, last: 0 },
    ])
    expect(second.closed).toEqual({ code: STREAM_NOT_RESUMABLE_CLOSE_CODE, reason: 'Stream not resumable' })
    expect(inner.opened).toHaveLength(1)
    handler.close(second, STREAM_NOT_RESUMABLE_CLOSE_CODE, 'Stream not resumable')
    expect(inner.closed).toHaveLength(1)
  })

  test('a gap the server can no longer fill refuses the resume instead of skipping frames', () => {
    const { inner, handler } = setup({ frames: 2 })
    const first = socket({ streamId: STREAM, ack: 0 })
    handler.open(first)
    const virtual = inner.opened[0]!
    for (let i = 0; i < 4; i++) virtual.send(`{"type":"content_delta","text":"${i}"}`)
    handler.close(first, 1006, '')
    const second = socket({ streamId: STREAM, ack: 1, epoch: 'epoch1' })
    handler.open(second)
    expect(second.frames()).toEqual([
      { type: 'stream_attached', v: 1, stream: STREAM, epoch: 'epoch1', resumed: false, reason: 'gap', cack: 0, next: 1, last: 0 },
    ])
    expect(second.closed?.code).toBe(STREAM_NOT_RESUMABLE_CLOSE_CODE)
    expect(inner.closed).toHaveLength(1)
    expect(inner.opened).toHaveLength(1)
    expect(handler.streamCount).toBe(0)
  })

  test('a refused resume also closes the old socket if it is still attached', () => {
    const { inner, handler } = setup({ frames: 3 })
    const first = socket({ streamId: STREAM, ack: 0 })
    handler.open(first)
    // Output while the old socket looks open but the phone stopped acknowledging.
    for (let i = 0; i < 10; i++) inner.opened[0]!.send(`{"type":"content_delta","text":"${i}"}`)
    const second = socket({ streamId: STREAM, ack: 1, epoch: 'epoch1' })
    handler.open(second)
    expect(second.frames()[0]).toMatchObject({ resumed: false, reason: 'gap' })
    expect(first.closed?.code).toBe(STREAM_NOT_RESUMABLE_CLOSE_CODE)
    expect(inner.closed).toHaveLength(1)
    // The old socket no longer belongs to any stream: nothing answers it, nothing reaches the session.
    const before = first.sent.length
    handler.message(first, '{"type":"ping","ack":0}')
    handler.close(first, STREAM_NOT_RESUMABLE_CLOSE_CODE, 'Stream not resumable')
    expect(first.sent).toHaveLength(before)
    expect(inner.received).toHaveLength(0)
    expect(inner.closed).toHaveLength(1)
  })

  test('a new stream that reuses a known id replaces the old stream', () => {
    const { inner, handler } = setup()
    const first = socket({ streamId: STREAM, ack: 0 })
    handler.open(first)
    const second = socket({ streamId: STREAM, ack: 0 })
    handler.open(second)
    expect(first.closed?.code).toBe(STREAM_SUPERSEDED_CLOSE_CODE)
    expect(second.frames()[0]).toMatchObject({ resumed: false, reason: 'new' })
    expect(inner.opened).toHaveLength(2)
    expect(inner.closed).toHaveLength(1)
    expect(handler.streamCount).toBe(1)
  })

  test('evicting a stream at the global cap closes its socket too', () => {
    expect(RESUME_LIMITS.streams).toBe(256)
    const { inner, handler } = setup({ streams: 2 })
    const sockets = [STREAM, OTHER, 'CCCCCCCCCCCCCCCCCCCCCC'].map((id, index) => socket({ streamId: id, ack: 0 }, { remoteDeviceId: `phone-${index}` }))
    for (const ws of sockets) handler.open(ws)
    expect(sockets[0]!.closed?.code).toBe(1001)
    expect(sockets[1]!.closed).toBeUndefined()
    expect(inner.closed).toHaveLength(1)
    expect(handler.streamCount).toBe(2)
    const before = sockets[0]!.sent.length
    handler.message(sockets[0]!, '{"type":"ping"}')
    expect(sockets[0]!.sent).toHaveLength(before)
  })

  test('an attach while the old socket is still open replaces it, and the old one receives nothing more', () => {
    const { inner, handler } = setup()
    const first = socket({ streamId: STREAM, ack: 0 })
    handler.open(first)
    const virtual = inner.opened[0]!
    const second = socket({ streamId: STREAM, ack: 1, epoch: 'epoch1' })
    handler.open(second)
    expect(first.closed?.code).toBe(STREAM_SUPERSEDED_CLOSE_CODE)
    // The old socket's close has not arrived yet; a command it still sends must not reach the session.
    handler.message(first, '{"cseq":1,"type":"permission_response","requestId":"r1","allowed":true}')
    handler.message(first, '{"type":"stop_generation"}')
    expect(inner.received).toHaveLength(0)
    handler.close(first, STREAM_SUPERSEDED_CLOSE_CODE, 'Stream superseded')
    virtual.send('{"type":"status","state":"idle"}')
    expect(first.sent).toHaveLength(2)
    expect(second.frames().at(-1)).toEqual({ seq: 2, type: 'status', state: 'idle' })
    expect(inner.closed).toHaveLength(0)
  })

  test('a command resent after a drop reaches the session once, and every copy is acknowledged', () => {
    const { inner, handler } = setup()
    const first = socket({ streamId: STREAM, ack: 0 })
    handler.open(first)
    handler.message(first, '{"cseq":1,"type":"permission_response","requestId":"r1","allowed":true}')
    handler.close(first, 1006, '')
    const second = socket({ streamId: STREAM, ack: 1, epoch: 'epoch1' })
    handler.open(second)
    expect(second.frames()[0]).toMatchObject({ resumed: true, cack: 1 })
    handler.message(second, '{"cseq":1,"type":"permission_response","requestId":"r1","allowed":true}')
    handler.message(second, '{"cseq":2,"type":"sync_state"}')
    expect(inner.received.map((item) => item.text)).toEqual([
      '{"type":"permission_response","requestId":"r1","allowed":true}',
      '{"type":"sync_state"}',
    ])
    expect(first.frames().filter((frame) => frame.type === 'command_ack')).toEqual([{ type: 'command_ack', cseq: 1 }])
    expect(second.frames().filter((frame) => frame.type === 'command_ack')).toEqual([
      { type: 'command_ack', cseq: 1 },
      { type: 'command_ack', cseq: 2 },
    ])
  })

  test('another device cannot attach to a stream it does not own', () => {
    const { inner, handler } = setup()
    const owner = socket({ streamId: STREAM, ack: 0 }, { remoteDeviceId: 'phone-a' })
    handler.open(owner)
    inner.opened[0]!.send('{"type":"content_delta","text":"secret"}')
    handler.close(owner, 1006, '')
    const intruder = socket({ streamId: STREAM, ack: 0, epoch: 'epoch1' }, { remoteDeviceId: 'phone-b' })
    handler.open(intruder)
    expect(intruder.sent.join('')).not.toContain('secret')
    expect(intruder.frames()).toEqual([expect.objectContaining({ resumed: false, reason: 'expired' })])
    expect(intruder.closed?.code).toBe(STREAM_NOT_RESUMABLE_CLOSE_CODE)
    // The owner's stream is untouched and still resumable.
    expect(inner.opened).toHaveLength(1)
    expect(inner.closed).toHaveLength(0)
    expect(handler.streamCount).toBe(1)
  })

  test('a different server epoch cannot resume', () => {
    const { inner, handler } = setup()
    const first = socket({ streamId: STREAM, ack: 0 })
    handler.open(first)
    handler.close(first, 1006, '')
    const second = socket({ streamId: STREAM, ack: 1, epoch: 'older-server' })
    handler.open(second)
    expect(second.frames()).toEqual([
      { type: 'stream_attached', v: 1, stream: STREAM, epoch: 'epoch1', resumed: false, reason: 'epoch', cack: 0, next: 1, last: 0 },
    ])
    expect(second.closed?.code).toBe(STREAM_NOT_RESUMABLE_CLOSE_CODE)
    expect(inner.closed).toHaveLength(1)
    expect(inner.opened).toHaveLength(1)
  })

  test('replayed frames are the per-client bytes the handler produced, untouched', () => {
    const { inner, handler } = setup()
    const first = socket({ streamId: STREAM, ack: 0 }, { mediaRefs: true })
    handler.open(first)
    const virtual = inner.opened[0]!
    expect(virtual.data.mediaRefs).toBe(true)
    const projected = '{"type":"tool_result","content":[{"type":"image_ref","path":"/api/sessions/s/tool-images/t/0"}]}'
    handler.close(first, 1006, '')
    virtual.send(projected)
    const second = socket({ streamId: STREAM, ack: 1, epoch: 'epoch1' }, { mediaRefs: true })
    handler.open(second)
    expect(second.sent.at(-1)).toBe(`{"seq":2,${projected.slice(1)}`)
  })

  test('a terminal close (revoke, origin change, user disable) cannot be resumed', () => {
    const { inner, handler } = setup()
    const ws = socket({ streamId: STREAM, ack: 0 }, { remoteDeviceId: 'phone' })
    handler.open(ws)
    ws.data.terminal = true
    handler.close(ws, 1008, 'Remote access revoked')
    expect(inner.closed).toHaveLength(1)
    expect(handler.streamCount).toBe(0)
  })

  test('revoking a device ends its detached streams too', () => {
    const { inner, handler } = setup()
    const a = socket({ streamId: STREAM, ack: 0 }, { remoteDeviceId: 'phone-a' })
    const b = socket({ streamId: OTHER, ack: 0 }, { remoteDeviceId: 'phone-b' })
    handler.open(a)
    handler.open(b)
    handler.close(a, 1006, '')
    handler.terminateIdentity('phone-a')
    expect(inner.closed.map((item) => item.code)).toEqual([1008])
    expect(handler.streamCount).toBe(1)
    expect(b.closed).toBeUndefined()
  })

  test('ping is answered by the stream layer and acknowledged frames are released', () => {
    const { inner, handler } = setup({ frames: 3 })
    const first = socket({ streamId: STREAM, ack: 0 })
    handler.open(first)
    const virtual = inner.opened[0]!
    virtual.send('{"type":"a"}')
    virtual.send('{"type":"b"}')
    handler.message(first, '{"type":"ping","ack":3}')
    expect(first.frames().at(-1)).toEqual({ type: 'pong' })
    expect(inner.received).toHaveLength(0)
    // Frames 1-3 are acknowledged, so the buffer has room again and nothing is lost.
    virtual.send('{"type":"c"}')
    virtual.send('{"type":"d"}')
    handler.close(first, 1006, '')
    const second = socket({ streamId: STREAM, ack: 3, epoch: 'epoch1' })
    handler.open(second)
    expect(second.frames().slice(1)).toEqual([{ seq: 4, type: 'c' }, { seq: 5, type: 'd' }])
  })

  test('the handler closing its connection ends the stream and the physical socket', async () => {
    const { inner, handler } = setup()
    const ws = socket({ streamId: STREAM, ack: 0 })
    handler.open(ws)
    inner.opened[0]!.close(1009, 'Client message exceeds 16 MiB')
    expect(ws.closed?.code).toBe(1009)
    handler.close(ws, 1009, 'Client message exceeds 16 MiB')
    await flush()
    expect(inner.closed.map((item) => item.code)).toEqual([1009])
  })
})

describe('resume request parsing', () => {
  test('accepts a well-formed request and ignores anything else', () => {
    expect(parseResumeRequest(new URLSearchParams(`stream=${STREAM}&ack=12&epoch=epoch1`))).toEqual({ streamId: STREAM, ack: 12, epoch: 'epoch1' })
    expect(parseResumeRequest(new URLSearchParams(`stream=${STREAM}`))).toEqual({ streamId: STREAM, ack: 0 })
    expect(parseResumeRequest(new URLSearchParams('stream=short'))).toBeUndefined()
    expect(parseResumeRequest(new URLSearchParams(`stream=${STREAM}&ack=-1`))).toBeUndefined()
    expect(parseResumeRequest(new URLSearchParams(`stream=${STREAM}&epoch=bad epoch`))).toBeUndefined()
    expect(parseResumeRequest(new URLSearchParams(''))).toBeUndefined()
  })
})
