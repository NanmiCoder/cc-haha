/**
 * M7-B §8.3 — durable public receipts for managed-context turns.
 *
 * One JSON file per session under `<config>/cc-haha/context-turns/<sessionId>.json`:
 *
 * ```json
 * { "schemaVersion": 1, "sessionId": "…", "receipts": { "<requestId>": { … } } }
 * ```
 *
 * What is written is exactly the public record §8.3 allows: the original
 * user-visible body, attachment count, the public manifest, the bindings, the
 * runtime revision, the status and the timestamps. The expanded prompt
 * (`modelContext`) and every secret are NEVER written here — the store only
 * accepts the public manifest type, and the caller has no way to pass the
 * composed text.
 *
 * `dispatching` is durably written *before* the SDK call, so a crash between the
 * socket write and the SDK's first event leaves `delivery-unknown` recoverable
 * instead of silently lost (see `wsBridge.prepareUserMessage`).
 *
 * The write is the repo's existing atomic pattern for the `cc-haha/` directory
 * family (temp file + fsync + rename, 0600; same shape as
 * `src/server/api/memory.ts`), plus a per-file promise queue so two frames in
 * flight cannot read-modify-write the same file.
 */

import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getCcHahaDir } from '../../../utils/envUtils.js'
import type { PublicContextManifestV2 } from '../../../services/managedContext/types.js'
import {
  CONTEXT_RECEIPT_TRANSITIONS,
  type ContextTicketReceiptStatus,
} from './ticketStore.js'

export const CONTEXT_TURN_RECEIPT_SCHEMA_VERSION = 1

export type ContextTurnRejection = {
  code: string
  retryable: boolean
}

export type ContextTurnReceiptRecord = {
  schemaVersion: typeof CONTEXT_TURN_RECEIPT_SCHEMA_VERSION
  sessionId: string
  requestId: string
  status: ContextTicketReceiptStatus
  contentBinding: string
  contextBinding: string
  /** The manifest's own password switch; part of the request identity. */
  passwordDisclosure: boolean
  ticketId: string | null
  runtimeRevision: number | null
  /** The original user-visible body. Never the composed text, never a secret. */
  userBody: string
  attachmentCount: number
  manifest: PublicContextManifestV2 | null
  createdAt: string
  updatedAt: string
  rejection?: ContextTurnRejection
}

export type BeginDispatchInput = {
  sessionId: string
  requestId: string
  contentBinding: string
  contextBinding: string
  passwordDisclosure: boolean
  ticketId: string | null
  runtimeRevision: number | null
  userBody: string
  attachmentCount: number
  manifest: PublicContextManifestV2 | null
}

type FileShape = {
  schemaVersion: typeof CONTEXT_TURN_RECEIPT_SCHEMA_VERSION
  sessionId: string
  receipts: Record<string, ContextTurnReceiptRecord>
}

export type ContextTurnReceiptStoreOptions = {
  /** Defaults to `<config>/cc-haha/context-turns`. */
  dir?: string
  now?: () => number
}

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

function sessionFileStem(sessionId: string): string {
  if (SAFE_SESSION_ID.test(sessionId)) return sessionId
  // Session ids are server-generated; this only keeps a hostile id from
  // escaping the receipts directory.
  return sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)
}

const writeQueues = new Map<string, Promise<unknown>>()

async function writeJsonAtomically(filePath: string, content: string): Promise<void> {
  const tempPath = join(dirname(filePath), `.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(tempPath, 'wx', 0o600)
    await handle.writeFile(content, { encoding: 'utf-8' })
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(tempPath, filePath)
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(tempPath).catch(() => undefined)
  }
}

function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  writeQueues.set(key, current)
  return current.finally(() => {
    if (writeQueues.get(key) === current) writeQueues.delete(key)
  }) as Promise<T>
}

export class ContextTurnReceiptStore {
  private readonly dir: string
  private readonly now: () => number

  constructor(options: ContextTurnReceiptStoreOptions = {}) {
    this.dir = options.dir ?? join(getCcHahaDir(), 'context-turns')
    this.now = options.now ?? (() => Date.now())
  }

  get directory(): string {
    return this.dir
  }

  filePathFor(sessionId: string): string {
    return join(this.dir, `${sessionFileStem(sessionId)}.json`)
  }

  /**
   * Durably record `dispatching` BEFORE the SDK call. Returns the written
   * record so the caller can ack with the same receipt later.
   */
  async beginDispatch(input: BeginDispatchInput): Promise<ContextTurnReceiptRecord> {
    return this.mutate(input.sessionId, (file) => {
      const timestamp = new Date(this.now()).toISOString()
      const existing = file.receipts[input.requestId]
      if (existing && existing.status !== 'rejected') {
        throw new Error(
          `Context receipt for ${input.requestId} already exists (${existing.status})`,
        )
      }
      const record: ContextTurnReceiptRecord = {
        schemaVersion: CONTEXT_TURN_RECEIPT_SCHEMA_VERSION,
        sessionId: input.sessionId,
        requestId: input.requestId,
        status: 'dispatching',
        contentBinding: input.contentBinding,
        contextBinding: input.contextBinding,
        passwordDisclosure: input.passwordDisclosure,
        ticketId: input.ticketId,
        runtimeRevision: input.runtimeRevision,
        userBody: input.userBody,
        attachmentCount: input.attachmentCount,
        manifest: input.manifest,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      }
      file.receipts[input.requestId] = record
      return record
    })
  }

  async transition(input: {
    sessionId: string
    requestId: string
    status: ContextTicketReceiptStatus
    rejection?: ContextTurnRejection
  }): Promise<ContextTurnReceiptRecord | null> {
    return this.mutate(input.sessionId, (file) => {
      const existing = file.receipts[input.requestId]
      if (!existing) return null
      if (!CONTEXT_RECEIPT_TRANSITIONS[existing.status].includes(input.status)) {
        throw new Error(
          `Illegal context receipt transition ${existing.status} -> ${input.status}`,
        )
      }
      const next: ContextTurnReceiptRecord = {
        ...existing,
        status: input.status,
        updatedAt: new Date(this.now()).toISOString(),
      }
      if (input.rejection) next.rejection = input.rejection
      file.receipts[input.requestId] = next
      return next
    })
  }

  async read(sessionId: string, requestId: string): Promise<ContextTurnReceiptRecord | null> {
    const file = await this.readFile(sessionId)
    return file?.receipts[requestId] ?? null
  }

  async list(sessionId: string): Promise<ContextTurnReceiptRecord[]> {
    const file = await this.readFile(sessionId)
    if (!file) return []
    return Object.values(file.receipts).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  private async readFile(sessionId: string): Promise<FileShape | null> {
    try {
      const raw = await readFile(this.filePathFor(sessionId), 'utf-8')
      const parsed = JSON.parse(raw) as FileShape
      if (parsed?.schemaVersion !== CONTEXT_TURN_RECEIPT_SCHEMA_VERSION) return null
      if (!parsed.receipts || typeof parsed.receipts !== 'object') return null
      return parsed
    } catch {
      // Missing or unreadable receipts are "no record" — never a crash and
      // never a reason to resend a turn (see the fail-closed rule in wsBridge).
      return null
    }
  }

  private mutate<T>(
    sessionId: string,
    operation: (file: FileShape) => T,
  ): Promise<T> {
    const filePath = this.filePathFor(sessionId)
    return serialize(filePath, async () => {
      const file = (await this.readFile(sessionId)) ?? {
        schemaVersion: CONTEXT_TURN_RECEIPT_SCHEMA_VERSION,
        sessionId,
        receipts: {},
      }
      const result = operation(file)
      await mkdir(this.dir, { recursive: true })
      await writeJsonAtomically(filePath, `${JSON.stringify(file, null, 2)}\n`)
      return result
    })
  }
}
