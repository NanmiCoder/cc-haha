import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { WechatMessage } from './protocol.js'
import type { WechatDeliveryStore } from './delivery-store.js'

export function isWechatStorageError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string') return false
  const actualCode = error.code
  return ['SQLITE_FULL', 'SQLITE_READONLY', 'SQLITE_IOERR', 'SQLITE_CANTOPEN', 'SQLITE_CORRUPT', 'SQLITE_NOTADB', 'ENOSPC', 'EACCES', 'EPERM']
    .some(code => actualCode === code || actualCode.startsWith(`${code}_`))
}

export function wechatMessageKey(message: WechatMessage): string {
  const identity = message.message_id !== undefined ? ['id', message.message_id]
    : message.seq !== undefined ? ['seq', message.seq, message.create_time_ms]
      : ['fallback', message.create_time_ms, message.item_list]
  return createHash('sha256').update(JSON.stringify([message.from_user_id, identity])).digest('hex')
}

/** Separates durable receipt from asynchronous execution. No server ACK is
 * inferred from a socket write, and interrupted work is never re-executed. */
export class WechatDeliveryRuntime {
  private readonly active = new Set<string>()
  private readonly liveControl = new WeakSet<WechatMessage>()
  private readonly context = new AsyncLocalStorage<{ key: string; submitted: boolean; claimed: boolean }>()
  private readonly submitted = new Map<string, string[]>()
  constructor(readonly store: WechatDeliveryStore, private readonly allowed: (chatId: string) => boolean) {}

  ingest(messages: WechatMessage[], cursor?: string): WechatMessage[] {
    const valid = messages.filter(message => message && typeof message.from_user_id === 'string' && message.from_user_id)
    const added = new Set(this.store.ingestBatch(valid.map(message => {
      const authorized = this.allowed(message.from_user_id!)
      if (!authorized) this.liveControl.add(message)
      return {
      messageKey: wechatMessageKey(message), chatId: message.from_user_id!,
      payload: authorized ? message : null,
    }}), cursor))
    return valid.filter(message => added.has(wechatMessageKey(message)))
  }

  pending(): WechatMessage[] {
    return this.store.pendingInbound(5000).map(row => row.payload as WechatMessage)
  }

  async dispatch(message: WechatMessage, route: () => Promise<void>): Promise<void> {
    const key = wechatMessageKey(message)
    if (this.active.has(key)) return
    // Unpaired messages are not persisted with a body; pairing remains a live
    // control flow and never replays a saved pairing code after restart.
    if (this.liveControl.has(message) && this.allowed(message.from_user_id!)) {
      if (!this.store.authorizeLiveInput(key, message)) return
    } else if (!this.allowed(message.from_user_id!)) {
      this.store.finishInbound(key, 'rejected')
      await route()
      return
    }
    this.active.add(key)
    const execution = { key, submitted: false, claimed: false }
    try {
      await this.context.run(execution, route)
      if (!execution.submitted) this.store.finishInbound(key)
    } catch {
      this.store.finishInbound(key, 'uncertain')
      throw new Error('微信消息处理未完成；请查看 /delivery 和桌面会话，不会自动重复执行。')
    } finally {
      this.active.delete(key)
    }
  }

  beginCurrent(): boolean {
    const execution = this.context.getStore()
    if (!execution || execution.claimed) return true
    execution.claimed = this.store.beginInbound(execution.key)
    return execution.claimed
  }

  submittedToServer(chatId: string): void {
    const execution = this.context.getStore()
    if (!execution) return
    this.beginCurrent()
    execution.submitted = true
    const keys = this.submitted.get(chatId) ?? []
    keys.push(execution.key)
    this.submitted.set(chatId, keys)
    // Without server submission IDs, completion events cannot safely correlate
    // overlapping turns. Preserve uncertainty rather than claiming completion.
    if (keys.length > 1) for (const key of keys) this.store.finishInbound(key, 'uncertain')
  }

  failedCurrent(): void {
    const execution = this.context.getStore()
    if (!execution) return
    execution.submitted = true
    this.store.finishInbound(execution.key, 'uncertain')
  }

  completed(chatId: string, success: boolean): void {
    const keys = this.submitted.get(chatId)
    const key = success ? keys?.shift() : keys?.[0]
    if (key) this.store.finishInbound(key, success ? 'completed' : 'uncertain')
    if (!keys?.length) this.submitted.delete(chatId)
  }

  cancel(chatId: string): void {
    this.store.cancelChat(chatId, this.context.getStore()?.key)
    this.submitted.delete(chatId)
  }

  summary(chatId: string): string {
    const counts = this.store.recoverySummary(chatId)
    const rows = this.store.listOutbound(chatId, 10)
    const states: Record<string, string> = { pending: '待发送', sending: '发送中', failed: '失败', unknown: '送达未知' }
    return [
      `接收：待处理 ${counts.received}，处理中 ${counts.dispatching}，执行结果待核对 ${counts.uncertain}。`,
      `回复：待发送 ${counts.pending}，发送中 ${counts.sending}，失败 ${counts.failed}，送达未知 ${counts.unknown}。`,
      ...rows.map(row => `${row.kind === 'text' ? '文字' : '附件'} ${states[row.state]}：${row.replyId}`),
      '执行结果待核对的任务请先查看桌面会话，不会自动重跑。文字补发：/retry <上面的 ID>；送达未知可能已收到，请先核对。附件请重新使用 /send。',
    ].join('\n')
  }
}
