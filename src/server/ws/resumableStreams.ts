/**
 * Resumable client streams in front of the session WebSocket handler.
 *
 * A phone loses its socket whenever the OS suspends the app or the network
 * changes. Without help, every drop means a new handler connection plus a
 * history re-read through a slow tunnel. A client that opts in with
 * `?stream=<id>` instead gets a virtual connection: the handler sees one stable
 * `SessionConnection` for the whole stream, while physical sockets come and go.
 * Every frame the handler sends is numbered and kept until acknowledged, so a
 * reattaching socket replays exactly the bytes this client would have received
 * (already projected per client: media refs, pet filtering). Client commands
 * carry a sequence number, so a command resent after a drop runs once.
 *
 * Clients that do not opt in are passed through untouched, byte for byte.
 *
 * Trade-off: a detached stream still counts as a connected client, so idle
 * session cleanup (and the CLI it keeps alive, see #1485) starts up to
 * `RESUME_WINDOW_MS` later than when the phone actually vanished.
 */
import { randomUUID } from 'node:crypto'
import type { ServerWebSocket } from 'bun'
import type { SessionConnection, WebSocketData } from './handler.js'

/** How long a detached stream waits for its client to come back. */
export const RESUME_WINDOW_MS = 180_000
export const RESUME_LIMITS = {
  /** Unacknowledged frames kept per stream. */
  frames: 4000,
  bytes: 4 * 1024 * 1024,
  /** Detached streams per identity (a device, or the main port). */
  detachedPerIdentity: 16,
  /** All streams, attached or not. */
  streams: 256,
}
/** Close code sent to a physical socket replaced by a newer attach of its stream. */
export const STREAM_SUPERSEDED_CLOSE_CODE = 4000
/**
 * Close code for a resume the server cannot honor (expired, gap, other epoch),
 * sent right after an unnumbered `stream_attached{resumed:false}`. The socket
 * never becomes a session connection: the client cold-syncs and opens a new
 * stream, so no fresh `connected` can race its replay bookkeeping.
 */
export const STREAM_NOT_RESUMABLE_CLOSE_CODE = 4001

export type ResumeRequest = { streamId: string; ack: number; epoch?: string }
type ResumeData = WebSocketData & {
  resume?: ResumeRequest
  /** Set before a close that must end the stream (revoke, origin change, user disable). */
  terminal?: boolean
  remoteDeviceId?: string
}
type Physical = Pick<ServerWebSocket<ResumeData>, 'data' | 'send' | 'close'>
type InnerHandler = {
  open?(ws: SessionConnection): void
  message(ws: SessionConnection, message: string | Buffer): void
  close?(ws: SessionConnection, code: number, reason: string): void
  drain?(ws: SessionConnection): void
  maxPayloadLength?: number
}
type Frame = { seq: number; text: string }

/** Control frames, never numbered and never seen by the session handler. */
export type StreamAttachedFrame = {
  type: 'stream_attached'
  v: 1
  stream: string
  epoch: string
  resumed: boolean
  reason?: 'new' | 'expired' | 'gap' | 'epoch'
  /** Highest client command sequence the server has applied. */
  cack: number
  /** Sequence number of the next frame this socket receives. */
  next: number
  /** Highest frame sequence at attach: the replay is complete once the client has seen it. */
  last: number
}

const STREAM_ID = /^[A-Za-z0-9_-]{22}$/
const EPOCH = /^[A-Za-z0-9_-]{1,64}$/
const CLIENT_SEQUENCE = /^\{"cseq":(\d{1,15}),/

/** Reads `stream`, `ack` and `epoch`; anything malformed means "no resume". */
export function parseResumeRequest(params: URLSearchParams): ResumeRequest | undefined {
  const streamId = params.get('stream')
  if (!streamId || !STREAM_ID.test(streamId)) return undefined
  const rawAck = params.get('ack') ?? '0'
  const epoch = params.get('epoch') ?? undefined
  if (!/^\d{1,15}$/.test(rawAck) || (epoch !== undefined && !EPOCH.test(epoch))) return undefined
  return { streamId, ack: Number(rawAck), ...(epoch ? { epoch } : {}) }
}

class Stream {
  frames: Frame[] = []
  bytes = 0
  seq = 0
  clientSeq = 0
  physical?: Physical
  detachedAt?: number
  expiry?: ReturnType<typeof setTimeout>
  ended = false
  readonly virtual: SessionConnection
  constructor(
    readonly key: string,
    readonly identity: string,
    readonly id: string,
    data: ResumeData,
    send: (stream: Stream, text: string) => number,
    close: (stream: Stream, code?: number, reason?: string) => void,
  ) {
    const { resume: _resume, terminal: _terminal, ...rest } = data
    const stream = this
    this.virtual = {
      data: rest as WebSocketData,
      send: ((payload: string | Buffer) => send(stream, typeof payload === 'string' ? payload : payload.toString())) as SessionConnection['send'],
      close: ((code?: number, reason?: string) => close(stream, code, reason)) as SessionConnection['close'],
    }
  }
}

export function createResumableSocketHandler<T extends InnerHandler>(inner: T, options: {
  epoch?: string
  limits?: Partial<typeof RESUME_LIMITS>
  windowMs?: number
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
} = {}) {
  const epoch = options.epoch ?? randomUUID().replace(/-/g, '')
  const limits = { ...RESUME_LIMITS, ...options.limits }
  const windowMs = options.windowMs ?? RESUME_WINDOW_MS
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer = options.clearTimer ?? (timer => clearTimeout(timer))
  const streams = new Map<string, Stream>()
  const byPhysical = new WeakMap<object, Stream>()

  const identityOf = (data: ResumeData) => data.remoteDeviceId ? `device:${data.remoteDeviceId}` : 'main'
  const write = (physical: Physical | undefined, text: string) => {
    if (!physical) return 0
    try { return physical.send(text) } catch { return 0 }
  }
  const control = (physical: Physical, frame: Record<string, unknown>) => write(physical, JSON.stringify(frame))

  /**
   * End the stream for good: the handler sees one close, as for a real socket.
   * A socket still attached is closed with the same code, so the client never
   * keeps a live-looking socket that nothing writes to.
   */
  const end = (stream: Stream, code: number, reason: string) => {
    if (stream.ended) return
    stream.ended = true
    if (stream.expiry) clearTimer(stream.expiry)
    streams.delete(stream.key)
    stream.frames = []
    stream.bytes = 0
    const physical = stream.physical
    stream.physical = undefined
    if (physical) {
      byPhysical.delete(physical)
      try { physical.close(code, reason) } catch { /* already closed */ }
    }
    inner.close?.(stream.virtual, code, reason)
  }

  const send = (stream: Stream, text: string) => {
    if (stream.ended) return 0
    stream.seq++
    // Number the frame by prefixing the handler's own JSON object.
    const numbered = text === '{}' ? `{"seq":${stream.seq}}`
      : text.startsWith('{') ? `{"seq":${stream.seq},${text.slice(1)}` : text
    stream.frames.push({ seq: stream.seq, text: numbered })
    stream.bytes += numbered.length
    while (stream.frames.length > 1 && (stream.frames.length > limits.frames || stream.bytes > limits.bytes)) {
      stream.bytes -= stream.frames.shift()!.text.length
      // A detached client can no longer resume without a gap; stop holding the session for it.
      if (!stream.physical) {
        queueMicrotask(() => end(stream, 1001, 'Resume buffer overflow'))
        return 0
      }
    }
    return write(stream.physical, numbered)
  }

  const close = (stream: Stream, code?: number, reason?: string) => {
    if (stream.ended) return
    const physical = stream.physical
    stream.physical = undefined
    if (physical) {
      byPhysical.delete(physical)
      try { physical.close(code, reason) } catch { /* already closed */ }
    }
    // Bun reports a server-initiated close asynchronously; so does the virtual one.
    queueMicrotask(() => end(stream, code ?? 1000, reason ?? ''))
  }

  const trim = (stream: Stream, ack: number) => {
    while (stream.frames.length && stream.frames[0]!.seq <= ack) stream.bytes -= stream.frames.shift()!.text.length
  }

  const detach = (stream: Stream, now = Date.now()) => {
    stream.physical = undefined
    stream.detachedAt = now
    stream.expiry = setTimer(() => end(stream, 1001, 'Resume window expired'), windowMs)
    const detached = [...streams.values()].filter(item => item.identity === stream.identity && !item.physical && !item.ended)
      .sort((a, b) => a.detachedAt! - b.detachedAt!)
    while (detached.length > limits.detachedPerIdentity) end(detached.shift()!, 1001, 'Too many detached streams')
  }

  const create = (physical: Physical, request: ResumeRequest) => {
    const identity = identityOf(physical.data)
    const key = `${identity}|${physical.data.sessionId}|${request.streamId}`
    while (streams.size >= limits.streams) {
      const oldest = [...streams.values()].sort((a, b) => (a.physical ? 1 : 0) - (b.physical ? 1 : 0) || (a.detachedAt ?? 0) - (b.detachedAt ?? 0))[0]!
      end(oldest, 1001, 'Too many resumable streams')
    }
    const stream = new Stream(key, identity, request.streamId, physical.data, send, close)
    stream.physical = physical
    streams.set(key, stream)
    byPhysical.set(physical, stream)
    control(physical, { type: 'stream_attached', v: 1, stream: request.streamId, epoch, resumed: false, reason: 'new', cack: 0, next: 1, last: 0 } satisfies StreamAttachedFrame)
    inner.open?.(stream.virtual)
  }

  return {
    ...inner,
    open(physical: Physical) {
      const request = physical.data.resume
      if (!request || physical.data.channel !== 'client') { inner.open?.(physical as SessionConnection); return }
      const key = `${identityOf(physical.data)}|${physical.data.sessionId}|${request.streamId}`
      const existing = streams.get(key)
      // No epoch: the client asks for a new stream (an id it reuses replaces the old one).
      if (request.epoch === undefined) {
        if (existing) end(existing, STREAM_SUPERSEDED_CLOSE_CODE, 'Stream restarted')
        return create(physical, request)
      }
      const reason = request.epoch !== epoch ? 'epoch'
        : !existing ? 'expired'
        : request.ack > existing.seq || (existing.frames.length ? request.ack < existing.frames[0]!.seq - 1 : request.ack < existing.seq) ? 'gap'
        : undefined
      if (reason || !existing) {
        // Refuse on this socket instead of opening a new session connection on
        // it: the client cold-syncs first, then starts its own new stream.
        if (existing) end(existing, STREAM_NOT_RESUMABLE_CLOSE_CODE, 'Stream not resumable')
        control(physical, { type: 'stream_attached', v: 1, stream: request.streamId, epoch, resumed: false, reason: reason ?? 'expired', cack: 0, next: 1, last: 0 } satisfies StreamAttachedFrame)
        try { physical.close(STREAM_NOT_RESUMABLE_CLOSE_CODE, 'Stream not resumable') } catch { /* already closed */ }
        return
      }
      if (existing.expiry) clearTimer(existing.expiry)
      existing.expiry = undefined
      existing.detachedAt = undefined
      const previous = existing.physical
      if (previous) {
        byPhysical.delete(previous)
        try { previous.close(STREAM_SUPERSEDED_CLOSE_CODE, 'Stream superseded') } catch { /* already closed */ }
      }
      existing.physical = physical
      byPhysical.set(physical, existing)
      trim(existing, request.ack)
      control(physical, { type: 'stream_attached', v: 1, stream: request.streamId, epoch, resumed: true, cack: existing.clientSeq, next: request.ack + 1, last: existing.seq } satisfies StreamAttachedFrame)
      for (const frame of existing.frames) write(physical, frame.text)
    },

    message(physical: Physical, message: string | Buffer) {
      const stream = byPhysical.get(physical)
      if (!stream) {
        // An opted-in socket without a stream was superseded, refused or ended:
        // it is not a session connection, so nothing it sends reaches the handler.
        if (!physical.data.resume || physical.data.channel !== 'client') inner.message(physical as SessionConnection, message)
        return
      }
      if (stream.ended) return
      const text = typeof message === 'string' ? message : message.toString()
      if (text.length <= 256) {
        let parsed: { type?: unknown; ack?: unknown } | undefined
        try { parsed = JSON.parse(text) } catch { /* the handler reports bad JSON */ }
        const ack = typeof parsed?.ack === 'number' && Number.isSafeInteger(parsed.ack) ? parsed.ack : undefined
        if (parsed?.type === 'ping') {
          if (ack !== undefined) trim(stream, ack)
          control(physical, { type: 'pong' })
          return
        }
        if (parsed?.type === 'stream_ack') {
          if (ack !== undefined) trim(stream, ack)
          return
        }
        if (parsed?.type === 'stream_end') {
          stream.physical = undefined
          byPhysical.delete(physical)
          end(stream, 1000, 'Client ended stream')
          try { physical.close(1000, 'Stream ended') } catch { /* already closed */ }
          return
        }
      }
      const sequence = CLIENT_SEQUENCE.exec(text.slice(0, 32))
      if (!sequence) { inner.message(stream.virtual, message); return }
      const cseq = Number(sequence[1])
      control(physical, { type: 'command_ack', cseq })
      // A command resent after a drop that the server had already applied.
      if (cseq <= stream.clientSeq) return
      stream.clientSeq = cseq
      // The handler sees the command exactly as a non-resumable client sends it.
      inner.message(stream.virtual, `{${text.slice(sequence[0].length)}`)
    },

    close(physical: Physical, code: number, reason: string) {
      const stream = byPhysical.get(physical)
      if (!stream) {
        // Superseded sockets and ended streams were already unlinked.
        if (!physical.data.resume || physical.data.channel !== 'client') inner.close?.(physical as SessionConnection, code, reason)
        return
      }
      byPhysical.delete(physical)
      if (stream.physical !== physical) return
      if (physical.data.terminal) { stream.physical = undefined; end(stream, code, reason); return }
      detach(stream)
    },

    drain(physical: Physical) {
      const stream = byPhysical.get(physical)
      inner.drain?.(stream ? stream.virtual : physical as SessionConnection)
    },

    /** End every stream of a device (revoked or expired), attached or not. */
    terminateIdentity(deviceId: string) {
      for (const stream of [...streams.values()]) {
        if (stream.identity === `device:${deviceId}`) end(stream, 1008, 'Remote access revoked')
      }
    },

    get epoch() { return epoch },
    get streamCount() { return streams.size },
  }
}
