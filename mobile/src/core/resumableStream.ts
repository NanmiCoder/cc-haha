import type { ClientMessage } from './types'

/**
 * Resumable session stream (server side in src/server/ws/resumableStreams.ts).
 *
 * Whenever the phone goes to background or switches network the socket drops. With resume on, the computer numbers and keeps every frame of the stream, 
 * the phone reconnects with "seen up to frame N", the computer replays only the unseen part, and the same session connection continues: 
 * no history reread and no reopening the session. Commands from the phone are numbered too, so one resent after a disconnect executes only once.
 */

/** after this many unacknowledged frames, acknowledge early without waiting for the next heartbeat so the computer can release its buffer. */
export const STREAM_ACK_EVERY = 500

type RandomSource = { getRandomValues<T extends Uint8Array>(array: T): T }

/** 128 bit random value, encoded as the 22-char base64url the server accepts. */
export function newStreamId(source: RandomSource): string {
  const bytes = source.getRandomValues(new Uint8Array(16))
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let bits = 0
  let value = 0
  let id = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 6) {
      bits -= 6
      id += alphabet[(value >> bits) & 63]
    }
  }
  if (bits) id += alphabet[(value << (6 - bits)) & 63]
  return id
}

/** Add the stream number to the session socket URL; on resume also add the seen frame number and this computer run's identifier. */
export function streamSocketUrl(
  url: string,
  stream: { id: string; resume?: { epoch: string; ack: number } }
) {
  const next = new URL(url)
  next.searchParams.set('stream', stream.id)
  if (stream.resume) {
    next.searchParams.set('ack', String(stream.resume.ack))
    next.searchParams.set('epoch', stream.resume.epoch)
  }
  return next.toString()
}

export type StreamAttached = {
  type: 'stream_attached'
  epoch: string
  resumed: boolean
  reason?: string
  /** Phone command number executed so far by the computer. */
  cack: number
  /** Number of the first frame after this connect. */
  next: number
  /** The computer's latest frame number at connect time: once seen, the replay is over. */
  last: number
}
export type StreamFrame =
  | { kind: 'attached'; frame: StreamAttached }
  | { kind: 'command_ack'; cseq: number }
  | { kind: 'event'; value: unknown; seq?: number }

const integer = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Parse a frame: recognize stream control frames first, hand the rest to event parsing as usual, carrying the frame number. */
export function readStreamFrame(data: unknown): StreamFrame | null {
  let value: unknown = data
  if (typeof data === 'string') {
    try {
      value = JSON.parse(data)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const frame = value as Record<string, unknown>
  if (frame.type === 'stream_attached') {
    if (
      typeof frame.epoch !== 'string' ||
      typeof frame.resumed !== 'boolean' ||
      !integer(frame.cack) ||
      !integer(frame.next) ||
      !integer(frame.last)
    )
      return null
    return {
      kind: 'attached',
      frame: {
        type: 'stream_attached',
        epoch: frame.epoch,
        resumed: frame.resumed,
        ...(typeof frame.reason === 'string' ? { reason: frame.reason } : {}),
        cack: frame.cack as number,
        next: frame.next as number,
        last: frame.last as number,
      },
    }
  }
  if (frame.type === 'command_ack')
    return integer(frame.cseq) ? { kind: 'command_ack', cseq: frame.cseq as number } : null
  return { kind: 'event', value, ...(integer(frame.seq) ? { seq: frame.seq as number } : {}) }
}

/**
 * Maximum resends of the same command after resume. When the computer disconnects every time because of this command (e.g. 1009 over the size limit), 
 * it must not loop forever "connect, resend, disconnect"; beyond this give up and hand it to the user as "delivery not confirmed".
 */
export const MAX_COMMAND_RESENDS = 2

/** Commands sent but not yet confirmed as executed by the computer. */
export class CommandOutbox {
  #next = 0
  #pending: { cseq: number; message: ClientMessage; resends: number }[] = []

  /**
   * Number and record the command, returning the number and the text to send (the number must come first; the server recognizes the prefix).
   * Ones not sent on the spot must be withdrawn with `drop`: the UI already told the user it was not sent and will not auto-retry.
   */
  encode(message: ClientMessage) {
    const cseq = ++this.#next
    this.#pending.push({ cseq, message, resends: 0 })
    return { cseq, text: JSON.stringify({ cseq, ...message }) }
  }

  /** The computer executes commands in order: confirming this one means earlier ones were executed too. */
  acknowledge(cseq: number) {
    this.#pending = this.#pending.filter((item) => item.cseq > cseq)
  }

  /** Commands not yet executed after resume (resent with the original number; the computer dedupes). */
  unacknowledged(cack: number) {
    this.acknowledge(cack)
    return this.#pending.map((item) => ({
      ...item,
      text: JSON.stringify({ cseq: item.cseq, ...item.message }),
    }))
  }

  /** Record one more resend. */
  resent(cseq: number) {
    const item = this.#pending.find((value) => value.cseq === cseq)
    if (item) item.resends++
  }

  /** Commands no longer needed (e.g. the decision in a replay was already handled). The number is left as a gap; the computer only requires later ones to be larger. */
  drop(cseq: number) {
    this.#pending = this.#pending.filter((item) => item.cseq !== cseq)
  }

  get size() {
    return this.#pending.length
  }

  clear() {
    this.#pending = []
  }
}
