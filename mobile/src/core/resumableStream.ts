import type { ClientMessage } from './types'

/**
 * 可续传的会话流（服务端见 src/server/ws/resumableStreams.ts）。
 *
 * 手机一切后台、一换网络，套接字就断。打开续传后，电脑把这条流的每一帧编号并留着，
 * 手机带着「看到第几帧」重新接上，电脑只补发没看到的部分，同一个会话连接继续用：
 * 不重读历史、不重新打开会话。手机发出的命令也带编号，断线后重发的那条只执行一次。
 */

/** 收到这么多帧还没确认，就不等下一次心跳，提前确认一次，让电脑放掉缓存。 */
export const STREAM_ACK_EVERY = 500

type RandomSource = { getRandomValues<T extends Uint8Array>(array: T): T }

/** 128 位随机数，编成服务端接受的 22 位 base64url。 */
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

/** 在会话套接字地址上带上流编号；续传时再带上已看到的帧号和电脑这次运行的标识。 */
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
  /** 电脑已执行到的手机命令编号。 */
  cack: number
  /** 这次接上后第一帧的编号。 */
  next: number
  /** 接上时电脑最新的帧号：看到它，补发就结束了。 */
  last: number
}
export type StreamFrame =
  | { kind: 'attached'; frame: StreamAttached }
  | { kind: 'command_ack'; cseq: number }
  | { kind: 'event'; value: unknown; seq?: number }

const integer = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** 解析一帧：先认出流的控制帧，其余照常交给事件解析，并带出帧号。 */
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
 * 同一条命令续传后最多重发几次。电脑每次都因为这条命令断开（例如超过大小上限的 1009）时，
 * 不能一直「接上、重发、断开」地转下去；超过就放弃，按「未确认送达」交给用户决定。
 */
export const MAX_COMMAND_RESENDS = 2

/** 发出去、电脑还没确认执行的命令。 */
export class CommandOutbox {
  #next = 0
  #pending: { cseq: number; message: ClientMessage; resends: number }[] = []

  /**
   * 给命令编号并记下，返回编号和要发出的文本（编号必须在最前面，服务端按前缀识别）。
   * 当场没发出去的要用 `drop` 撤掉：界面已经告诉用户它没发出、不会自动重试。
   */
  encode(message: ClientMessage) {
    const cseq = ++this.#next
    this.#pending.push({ cseq, message, resends: 0 })
    return { cseq, text: JSON.stringify({ cseq, ...message }) }
  }

  /** 电脑按顺序执行命令：确认了这一条，之前的也都执行过了。 */
  acknowledge(cseq: number) {
    this.#pending = this.#pending.filter((item) => item.cseq > cseq)
  }

  /** 续传接上后还没执行的命令（原编号重发，电脑会去重）。 */
  unacknowledged(cack: number) {
    this.acknowledge(cack)
    return this.#pending.map((item) => ({
      ...item,
      text: JSON.stringify({ cseq: item.cseq, ...item.message }),
    }))
  }

  /** 记下又重发了一次。 */
  resent(cseq: number) {
    const item = this.#pending.find((value) => value.cseq === cseq)
    if (item) item.resends++
  }

  /** 不再需要的命令（例如补发里那个决定已经处理掉了）。编号留空，电脑只要求后来的更大。 */
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
