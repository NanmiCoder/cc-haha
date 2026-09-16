/**
 * Shared harness for the M7-B WS-bridge contract tests.
 *
 * It mirrors what the real WS handler does around `ConversationService`:
 * prepare -> (only when accepted) hand the composed content to the SDK ->
 * acknowledge. `attempts` is therefore "what the SDK actually received",
 * which is what the identity/idempotency contracts are about.
 */

import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { composeUserContent } from '../composer.js'
import { ContextTurnReceiptStore } from '../receipts.js'
import {
  acknowledgeUserMessage,
  prepareUserMessage,
  type ManagedContextBridgeDeps,
  type ManagedContextUserMessageFrame,
  type ManagedContextUserMessagePreparation,
} from '../wsBridge.js'
import { ContextTicketStore } from '../ticketStore.js'
import { createTestDeps } from './stagedFixture.js'

export type BridgeAttempt = {
  sessionId: string
  content: string
  contextText: string | null
  /** Exactly what would be handed to the SDK. */
  composed: string
}

export type BridgeHarness = {
  deps: ManagedContextBridgeDeps
  receipts: ContextTurnReceiptStore
  ticketStore: ContextTicketStore
  attempts: BridgeAttempt[]
  send(
    sessionId: string,
    frame: ManagedContextUserMessageFrame,
  ): Promise<{ preparation: ManagedContextUserMessagePreparation; dispatched: boolean }>
  /** Simulates the sidecar restarting: new in-memory stores, same disk dir. */
  restart(): BridgeHarness
}

export async function createSandboxDir(prefix = 'm7b-bridge-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

export function createBridgeHarness(options: {
  receiptsDir: string
  ticketStore?: ContextTicketStore
  runtimeRevision?: number | null
  now?: () => number
}): BridgeHarness {
  const ticketStore = options.ticketStore ?? createTestDeps().store
  const receipts = new ContextTurnReceiptStore({
    dir: options.receiptsDir,
    now: options.now,
  })
  const deps: ManagedContextBridgeDeps = {
    store: ticketStore,
    receipts,
    runtimeRevision: () =>
      options.runtimeRevision === undefined ? 1 : options.runtimeRevision,
    persistSensitivity: async () => undefined,
  }
  const attempts: BridgeAttempt[] = []

  const harness: BridgeHarness = {
    deps,
    receipts,
    ticketStore,
    attempts,
    async send(sessionId, frame) {
      const preparation = await prepareUserMessage({ sessionId, frame, deps })
      if (preparation.kind !== 'accepted') {
        return { preparation, dispatched: false }
      }
      attempts.push({
        sessionId,
        content: frame.content,
        contextText: preparation.contextText,
        composed: composeUserContent({
          userText: frame.content,
          contextText: preparation.contextText,
        }).content,
      })
      await acknowledgeUserMessage({
        sessionId,
        requestId: preparation.requestId,
        ticketId: preparation.ticketId,
        deps,
      })
      return { preparation, dispatched: true }
    },
    restart() {
      return createBridgeHarness({
        receiptsDir: options.receiptsDir,
        now: options.now,
        runtimeRevision: options.runtimeRevision,
      })
    },
  }
  return harness
}
