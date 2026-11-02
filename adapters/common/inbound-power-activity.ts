import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { enqueue } from './chat-queue.js'
import type { AdapterHttpClient } from './http-client.js'
import { adapterMigrationLifecycle } from './migration-lifecycle.js'

type LeaseClient = Pick<AdapterHttpClient, 'acquirePowerActivityLease' | 'releasePowerActivityLease'>
export type InboundPowerLease = { id: string; transferred: boolean }
type LeaseContext = InboundPowerLease & { client: LeaseClient; chatId: string; supported: boolean }
const context = new AsyncLocalStorage<LeaseContext>()
const owner = `im:${randomUUID()}`

/** Only the matching chat can transfer this operation's lease to the server. */
export function currentInboundPowerLease(chatId: string): InboundPowerLease | undefined {
  const lease = context.getStore()
  return lease?.supported && lease.chatId === chatId ? lease : undefined
}

/** Call only after sender authorization and replay deduplication. */
export function enqueueInboundPowerActivity(
  client: LeaseClient,
  chatId: string,
  task: (lease?: InboundPowerLease) => Promise<void>,
  onError?: (error: unknown) => Promise<void>,
): Promise<void> {
  if (adapterMigrationLifecycle.isQuiescing) return Promise.resolve()
  const current = context.getStore()
  // A platform's authorized middleware may already own this chat's FIFO slot.
  if (current?.client === client && current.chatId === chatId) return task(current.supported ? current : undefined)
  const lease: LeaseContext = { id: `${owner}:${randomUUID()}`, transferred: false, client, chatId, supported: false }
  // Reserve the FIFO slot synchronously. Reordered HTTP replies must not reorder
  // input, and queued messages must acquire protection before their turn starts.
  const acquisition = client.acquirePowerActivityLease(lease.id).then(
    supported => ({ supported }),
    (error: unknown) => ({ error }),
  )
  const queued = enqueue(chatId, async () => {
    try {
      const acquired = await acquisition
      if ('error' in acquired) throw acquired.error
      lease.supported = acquired.supported
      await context.run(lease, () => task(acquired.supported ? lease : undefined))
    } catch (error) {
      if (onError) await onError(error)
      else throw error
    }
  })
  return adapterMigrationLifecycle.track(queued.finally(async () => {
    const acquired = await acquisition
    if ('error' in acquired || !acquired.supported || lease.transferred) return
    try {
      await client.releasePowerActivityLease(lease.id)
    } catch (error) {
      // Unknown work stays busy until server restart; never expire it into idle.
      console.error('[Adapter] Failed to release inbound activity:', error)
    }
  }))
}
