import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type InboundDeliveryState = 'received' | 'dispatching' | 'completed' | 'rejected' | 'uncertain'
export type OutboundDeliveryState = 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' | 'cancelled'
export type InboundDelivery = {
  messageKey: string
  chatId: string
  payload: unknown | null
  state: InboundDeliveryState
  createdAt: number
}
export type OutboundDelivery = {
  replyId: string
  clientId: string
  chatId: string
  kind: 'text' | 'media'
  text: string | null
  contextToken: string | null
  metadata: unknown | null
  state: OutboundDeliveryState
  createdAt: number
}
export type DeliverySummary = {
  received: number
  dispatching: number
  uncertain: number
  pending: number
  sending: number
  failed: number
  unknown: number
}
type StoreOptions = {
  path: string
  bindingKey: string
  now?: () => number
  maxRows?: number
  maxPayloadBytes?: number
}
type InboundRow = Omit<InboundDelivery, 'payload'> & { payload: string | null }
type OutboundRow = Omit<OutboundDelivery, 'metadata'> & { metadata: string | null }
const DAY_MS = 86_400_000
const MAX_RECORD_BYTES = 1024 * 1024

export class DeliveryCapacityError extends Error {
  readonly code = 'JOURNAL_FULL'

  constructor() {
    super('Delivery journal is full; no new work was accepted')
    this.name = 'DeliveryCapacityError'
  }
}

/** A credential fingerprint isolates reauthentication without persisting the credential itself. */
export function wechatBindingKey(accountId: string, credential: string): string {
  return createHash('sha256').update(JSON.stringify(['wechat', accountId, credential])).digest('hex')
}

/**
 * Durable transport journal. The caller MUST own the binding's exclusive worker lock
 * before recovery/dispatch. A websocket write is not a server ACK: crash-interrupted
 * dispatch is uncertain and is never returned by pendingInbound(). Media bytes are
 * not journalled; a restarted upload is failed and requires a new explicit /send.
 */
export class WechatDeliveryStore {
  private readonly db: Database
  private readonly bindingKey: string
  private readonly now: () => number
  private readonly maxRows: number
  private readonly maxPayloadBytes: number
  private workerNonce?: string
  private workerPid?: number

  constructor(options: StoreOptions) {
    if (!options.path || !options.bindingKey) throw new Error('Delivery store requires an explicit path and binding key')
    this.bindingKey = options.bindingKey
    this.now = options.now ?? Date.now
    this.maxRows = options.maxRows ?? 5000
    this.maxPayloadBytes = options.maxPayloadBytes ?? 16 * 1024 * 1024
    mkdirSync(dirname(options.path), { recursive: true })
    this.db = new Database(options.path, { create: true })
    try {
      this.db.exec('PRAGMA busy_timeout = 5000')
      const version = (this.db.query('PRAGMA user_version').get() as { user_version: number }).user_version
      if (version > 2) throw new Error('Delivery database was created by a newer version')
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON')
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS account_state (bindingKey TEXT PRIMARY KEY, cursor TEXT);
          CREATE TABLE IF NOT EXISTS worker_lock (bindingKey TEXT PRIMARY KEY, pid INTEGER NOT NULL, nonce TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS inbound (
            bindingKey TEXT NOT NULL, messageKey TEXT NOT NULL, chatId TEXT NOT NULL,
            payload TEXT, state TEXT NOT NULL, bytes INTEGER NOT NULL,
            createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
            PRIMARY KEY (bindingKey, messageKey)
          );
          CREATE TABLE IF NOT EXISTS outbound (
            bindingKey TEXT NOT NULL, replyId TEXT NOT NULL, clientId TEXT NOT NULL,
            chatId TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, contextToken TEXT, metadata TEXT,
            state TEXT NOT NULL, bytes INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
            PRIMARY KEY (bindingKey, replyId)
          );
          CREATE INDEX IF NOT EXISTS inbound_pending ON inbound(bindingKey, state, createdAt);
          CREATE INDEX IF NOT EXISTS outbound_pending ON outbound(bindingKey, state, createdAt);
          PRAGMA user_version = 2;
        `)
      })()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  getCursor(): string | undefined {
    return (this.db.query('SELECT cursor FROM account_state WHERE bindingKey = ?').get(this.bindingKey) as { cursor: string | null } | null)?.cursor ?? undefined
  }

  /** A live owner is never stolen. Liveness uncertainty also refuses takeover. */
  acquireWorker(ownerPid = process.pid, isAlive: (pid: number) => boolean = isProcessAlive): boolean {
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) throw new Error('Invalid worker PID')
    return this.db.transaction(() => {
      const previous = this.db.query('SELECT pid, nonce FROM worker_lock WHERE bindingKey = ?').get(this.bindingKey) as { pid: number; nonce: string } | null
      if (previous?.nonce === this.workerNonce && previous?.pid === ownerPid) return true
      if (previous && isAlive(previous.pid)) return false
      const nonce = randomUUID()
      this.db.query('INSERT INTO worker_lock(bindingKey, pid, nonce) VALUES (?, ?, ?) ON CONFLICT(bindingKey) DO UPDATE SET pid = excluded.pid, nonce = excluded.nonce')
        .run(this.bindingKey, ownerPid, nonce)
      this.workerPid = ownerPid
      this.workerNonce = nonce
      return true
    }).immediate()
  }

  releaseWorker(): void {
    if (this.workerNonce) {
      this.db.query('DELETE FROM worker_lock WHERE bindingKey = ? AND pid = ? AND nonce = ?')
        .run(this.bindingKey, this.workerPid!, this.workerNonce)
      this.workerNonce = undefined
      this.workerPid = undefined
    }
  }

  /** Commit input and cursor in one transaction; null payload is a body-free rejected/dedup record. */
  ingestBatch(messages: Array<{ messageKey: string; chatId: string; payload: unknown | null }>, cursor?: string): string[] {
    return this.db.transaction(() => {
      const added: string[] = []
      const now = this.now()
      for (const message of messages) {
        if (!message.messageKey || !message.chatId) throw new Error('Missing inbound identity')
        const payload = message.payload === null ? null : JSON.stringify(message.payload)
        if (payload === undefined) throw new Error('Inbound payload is not serializable')
        const bytes = Buffer.byteLength(payload ?? '')
        if (bytes > MAX_RECORD_BYTES) throw new Error('Inbound delivery record exceeds its limit')
        const result = this.db.query(`INSERT OR IGNORE INTO inbound
          (bindingKey, messageKey, chatId, payload, state, bytes, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(this.bindingKey, message.messageKey, message.chatId, payload, payload === null ? 'rejected' : 'received', bytes, now, now)
        if (result.changes) added.push(message.messageKey)
      }
      if (cursor !== undefined) {
        if (Buffer.byteLength(cursor) > MAX_RECORD_BYTES) throw new Error('Cursor exceeds its limit')
        this.db.query('INSERT INTO account_state(bindingKey, cursor) VALUES (?, ?) ON CONFLICT(bindingKey) DO UPDATE SET cursor = excluded.cursor').run(this.bindingKey, cursor)
      }
      this.checkCapacity()
      return added
    })()
  }

  pendingInbound(limit = 100): InboundDelivery[] {
    return (this.db.query('SELECT messageKey, chatId, payload, state, createdAt FROM inbound WHERE bindingKey = ? AND state = ? ORDER BY createdAt, rowid LIMIT ?')
      .all(this.bindingKey, 'received', Math.max(0, Math.min(5000, limit))) as InboundRow[])
      .map(row => ({ ...row, payload: row.payload === null ? null : JSON.parse(row.payload) }))
  }

  /** Only for a freshly received, body-free input whose user paired earlier in the same live batch. */
  authorizeLiveInput(messageKey: string, payload: unknown): boolean {
    const encoded = JSON.stringify(payload)
    if (encoded === undefined || encoded === 'null') throw new Error('Live input payload is required')
    const bytes = Buffer.byteLength(encoded)
    if (bytes > MAX_RECORD_BYTES) throw new Error('Inbound delivery record exceeds its limit')
    return this.db.transaction(() => {
      const changed = this.db.query(`UPDATE inbound SET payload = ?, bytes = ?, state = 'received', updatedAt = ?
        WHERE bindingKey = ? AND messageKey = ? AND state = 'rejected' AND payload IS NULL`)
        .run(encoded, bytes, this.now(), this.bindingKey, messageKey).changes > 0
      if (changed) this.checkCapacity()
      return changed
    })()
  }

  beginInbound(messageKey: string): boolean {
    return this.db.query("UPDATE inbound SET state = 'dispatching', updatedAt = ? WHERE bindingKey = ? AND messageKey = ? AND state = 'received'")
      .run(this.now(), this.bindingKey, messageKey).changes > 0
  }

  finishInbound(messageKey: string, state: 'completed' | 'rejected' | 'uncertain' = 'completed'): boolean {
    return this.db.query(`UPDATE inbound SET state = ?, updatedAt = ?, payload = NULL, bytes = 0
      WHERE bindingKey = ? AND messageKey = ? AND state IN ('received', 'dispatching')`)
      .run(state, this.now(), this.bindingKey, messageKey).changes > 0
  }

  stageText(input: { chatId: string; text: string; contextToken?: string }): OutboundDelivery {
    return this.stageOutbound({ ...input, kind: 'text' })
  }

  /** All response chunks are journalled before the first network send can happen. */
  stageTextBatch(input: { chatId: string; chunks: string[]; contextToken?: string }): OutboundDelivery[] {
    return this.db.transaction(() => input.chunks.map(text => this.stageText({ chatId: input.chatId, text, contextToken: input.contextToken })))()
  }

  stageMedia(input: { chatId: string; metadata: unknown }): OutboundDelivery {
    return this.stageOutbound({ ...input, kind: 'media' })
  }

  private stageOutbound(input: { chatId: string; kind: 'text' | 'media'; text?: string; contextToken?: string; metadata?: unknown }): OutboundDelivery {
    if (!input.chatId) throw new Error('Missing outbound identity')
    const row: OutboundDelivery = {
      replyId: randomUUID(), clientId: randomUUID(), chatId: input.chatId, kind: input.kind,
      text: input.text ?? null, contextToken: input.contextToken ?? null,
      metadata: input.metadata ?? null, state: 'pending', createdAt: this.now(),
    }
    const metadata = row.metadata === null ? null : JSON.stringify(row.metadata)
    const bytes = Buffer.byteLength(row.text ?? '') + Buffer.byteLength(row.contextToken ?? '') + Buffer.byteLength(metadata ?? '')
    if (bytes > MAX_RECORD_BYTES) throw new Error('Outbound delivery record exceeds its limit')
    this.db.transaction(() => {
      this.db.query(`INSERT INTO outbound (bindingKey, replyId, clientId, chatId, kind, text, contextToken, metadata, state, bytes, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(this.bindingKey, row.replyId, row.clientId, row.chatId, row.kind, row.text, row.contextToken, metadata, row.state, bytes, row.createdAt, row.createdAt)
      this.checkCapacity()
    })()
    return row
  }

  getOutbound(replyId: string): OutboundDelivery | undefined {
    const row = this.db.query('SELECT replyId, clientId, chatId, kind, text, contextToken, metadata, state, createdAt FROM outbound WHERE bindingKey = ? AND replyId = ?')
      .get(this.bindingKey, replyId) as OutboundRow | null
    return row ? this.decodeOutbound(row) : undefined
  }

  listOutbound(chatId: string, limit = 20): OutboundDelivery[] {
    return (this.db.query(`SELECT replyId, clientId, chatId, kind, text, contextToken, metadata, state, createdAt
      FROM outbound WHERE bindingKey = ? AND chatId = ? AND state IN ('pending', 'sending', 'failed', 'unknown') ORDER BY createdAt DESC, rowid DESC LIMIT ?`)
      .all(this.bindingKey, chatId, Math.max(0, Math.min(100, limit))) as OutboundRow[]).map(row => this.decodeOutbound(row))
  }

  beginOutbound(replyId: string): boolean {
    return this.db.query("UPDATE outbound SET state = 'sending', updatedAt = ? WHERE bindingKey = ? AND replyId = ? AND state = 'pending'")
      .run(this.now(), this.bindingKey, replyId).changes > 0
  }

  finishOutbound(replyId: string, state: 'sent' | 'failed' | 'unknown' | 'cancelled'): boolean {
    const clearPayload = state === 'sent' || state === 'cancelled'
    return this.db.query(`UPDATE outbound SET state = ?, updatedAt = ?${clearPayload ? ', text = NULL, contextToken = NULL, metadata = NULL, bytes = 0' : ''}
      WHERE bindingKey = ? AND replyId = ? AND state IN ('pending', 'sending')`)
      .run(state, this.now(), this.bindingKey, replyId).changes > 0
  }

  /** User-driven only: new context, no automatic retry of unknown platform delivery. */
  cloneTextForRetry(replyId: string, input: { chatId: string; contextToken?: string }): OutboundDelivery {
    return this.db.transaction(() => {
      const previous = this.getOutbound(replyId)
      if (!previous || previous.chatId !== input.chatId || previous.kind !== 'text' || previous.text === null
        || !['pending', 'failed', 'unknown'].includes(previous.state)) throw new Error('Text delivery is not available for explicit retry')
      this.db.query("UPDATE outbound SET state = 'cancelled', text = NULL, contextToken = NULL, metadata = NULL, bytes = 0, updatedAt = ? WHERE bindingKey = ? AND replyId = ?")
        .run(this.now(), this.bindingKey, replyId)
      const next = this.stageText({ chatId: input.chatId, text: previous.text, contextToken: input.contextToken })
      return next
    }).immediate()
  }

  /** Call once after exclusively acquiring the worker lock, before consuming new messages. */
  recoverInterrupted(): { uncertainInbound: number; unknownOutbound: number; failedMedia: number } {
    const owner = this.db.query('SELECT nonce FROM worker_lock WHERE bindingKey = ?').get(this.bindingKey) as { nonce: string } | null
    if (!this.workerNonce || owner?.nonce !== this.workerNonce) throw new Error('Delivery recovery requires the exclusive worker lock')
    return this.db.transaction(() => {
      const now = this.now()
      const uncertainInbound = this.db.query("UPDATE inbound SET state = 'uncertain', updatedAt = ?, payload = NULL, bytes = 0 WHERE bindingKey = ? AND state = 'dispatching'")
        .run(now, this.bindingKey).changes
      const unknownOutbound = this.db.query("UPDATE outbound SET state = 'unknown', updatedAt = ? WHERE bindingKey = ? AND state = 'sending'")
        .run(now, this.bindingKey).changes
      const failedMedia = this.db.query("UPDATE outbound SET state = 'failed', updatedAt = ? WHERE bindingKey = ? AND kind = 'media' AND state = 'pending'")
        .run(now, this.bindingKey).changes
      return { uncertainInbound, unknownOutbound, failedMedia }
    })()
  }

  recoverySummary(chatId: string): DeliverySummary {
    const summary: DeliverySummary = { received: 0, dispatching: 0, uncertain: 0, pending: 0, sending: 0, failed: 0, unknown: 0 }
    for (const table of ['inbound', 'outbound']) {
      const rows = this.db.query(`SELECT state, count(*) AS count FROM ${table} WHERE bindingKey = ? AND chatId = ? GROUP BY state`)
        .all(this.bindingKey, chatId) as Array<{ state: string; count: number }>
      for (const row of rows) if (Object.hasOwn(summary, row.state)) summary[row.state as keyof DeliverySummary] += row.count
    }
    return summary
  }

  cancelChat(chatId: string, exceptMessageKey?: string): void {
    this.db.transaction(() => {
      const now = this.now()
      // A control command cancels preceding work, not messages received after
      // it in the same atomic poll batch. Revocation (no control key) cancels all.
      const boundary = exceptMessageKey === undefined ? null : (this.db.query('SELECT rowid AS sequence FROM inbound WHERE bindingKey = ? AND messageKey = ?')
        .get(this.bindingKey, exceptMessageKey) as { sequence: number } | null)?.sequence ?? null
      this.db.query(`UPDATE inbound SET state = CASE WHEN state = 'received' THEN 'rejected' ELSE 'uncertain' END,
        payload = NULL, bytes = 0, updatedAt = ? WHERE bindingKey = ? AND chatId = ? AND state IN ('received', 'dispatching')
        AND messageKey != ? AND (? IS NULL OR rowid < ?)`)
        .run(now, this.bindingKey, chatId, exceptMessageKey ?? '', boundary, boundary)
      this.db.query(`UPDATE outbound SET state = CASE WHEN state IN ('sending', 'unknown') THEN 'unknown' ELSE 'cancelled' END,
        text = NULL, contextToken = NULL, metadata = NULL, bytes = 0, updatedAt = ? WHERE bindingKey = ? AND chatId = ? AND state IN ('pending', 'sending', 'failed', 'unknown')`).run(now, this.bindingKey, chatId)
    })()
  }

  /** Bounded retention across all bindings; active work is never evicted to admit new work. */
  prune(): void {
    this.db.transaction(() => {
      const now = this.now()
      this.db.query("DELETE FROM inbound WHERE (state IN ('completed', 'rejected') AND updatedAt < ?) OR (state = 'uncertain' AND updatedAt < ?)").run(now - DAY_MS, now - 7 * DAY_MS)
      this.db.query("DELETE FROM outbound WHERE (state IN ('sent', 'cancelled') AND updatedAt < ?) OR (state IN ('failed', 'unknown') AND updatedAt < ?)").run(now - DAY_MS, now - 7 * DAY_MS)
    })()
  }

  close(): void { this.releaseWorker(); this.db.close() }

  private decodeOutbound(row: OutboundRow): OutboundDelivery {
    return { ...row, metadata: row.metadata === null ? null : JSON.parse(row.metadata) }
  }

  private checkCapacity(): void {
    const usage = this.db.query('SELECT sum(rows) AS rows, sum(bytes) AS bytes FROM (SELECT count(*) AS rows, coalesce(sum(bytes), 0) AS bytes FROM inbound UNION ALL SELECT count(*), coalesce(sum(bytes), 0) FROM outbound UNION ALL SELECT 0, coalesce(sum(length(CAST(cursor AS BLOB))), 0) FROM account_state)')
      .get() as { rows: number; bytes: number }
    // Sent rows no longer own text and are not inbound dedup records. Reclaim
    // those receipts early under pressure, oldest first, inside the caller's
    // transaction. Never erase a recent inbound identity or uncertain work just
    // to make room: that could permit duplicate side effects or hide a failure.
    if (usage.rows > this.maxRows) {
      const deleted = this.db.query(`DELETE FROM outbound WHERE rowid IN (
        SELECT rowid FROM outbound WHERE state = 'sent' ORDER BY updatedAt, rowid LIMIT ?
      )`).run(usage.rows - this.maxRows).changes
      usage.rows -= deleted
    }
    if (usage.rows > this.maxRows || usage.bytes > this.maxPayloadBytes) throw new DeliveryCapacityError()
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    // EPERM and other host errors cannot prove a dead worker.
    return true
  }
}
