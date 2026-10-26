import type { MobileActivity } from './dashboard'
import { notificationEvents, type NotificationEvent } from './notifications'
import type { Preferences } from '../state/preferences'

type Snapshot = { hostId: string; activity: MobileActivity[] }
type Delivery = {
  permitted(): Promise<boolean>
  schedule(event: NotificationEvent): Promise<unknown>
}

/** Local notification transition state, independent of the native delivery API. */
export class NotificationFallback {
  private previous = new Map<string, MobileActivity[]>()
  private epoch = 0

  cancel() {
    this.epoch++
  }

  async observe(
    snapshot: Snapshot,
    pushStatus: string | undefined,
    preferences: Preferences,
    delivery: Delivery,
    now = new Date()
  ): Promise<void> {
    const epoch = ++this.epoch
    if (pushStatus === 'registered') {
      // Remote push owns these events, including an initial pending request.
      this.previous.set(snapshot.hostId, snapshot.activity)
      return
    }
    // Errors and permission/token setup failures are not proof that the server
    // cannot push. Preserve the baseline until configuration is authoritative.
    if (pushStatus !== 'notConfigured') return
    const prior = this.previous.get(snapshot.hostId) ?? null
    const events = notificationEvents(prior, snapshot.activity, preferences, now)
    if (events.length && (!await delivery.permitted() || epoch !== this.epoch)) return
    this.previous.set(snapshot.hostId, snapshot.activity)
    await Promise.all(events.map(event => delivery.schedule(event)))
  }
}
