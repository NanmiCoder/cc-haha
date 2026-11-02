import { hasConfiguredLocalAccessToken, isLocalAccessAuthorized } from '../localAccessAuth.js'
import { powerActivityClock } from './powerActivityClock.js'

const leases = new Set<string>()
const MAX_LEASES = 10_000

function isLeaseId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9:._-]{1,128}$/.test(value)
}

/** No timeout: a crashed adapter must not turn unfinished inbound work into idle. */
export function hasPowerActivityLeases(): boolean {
  return leases.size > 0
}

/** Called by the local WS admission path only after server activity takes over. */
export function releasePowerActivityLease(leaseId: unknown): void {
  if (isLeaseId(leaseId) && leases.delete(leaseId)) powerActivityClock.changed()
}

export async function handlePowerActivityLease(request: Request): Promise<Response> {
  // Source servers without native power authority keep ordinary IM admission.
  // Only this unavailable mode uses the adapter's 404 compatibility path.
  if (!hasConfiguredLocalAccessToken()) return Response.json({ error: 'Power activity leases unavailable' }, { status: 404 })
  if (!isLocalAccessAuthorized(request)) return Response.json({ error: 'Local access required' }, { status: 403 })
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 })
  let input: unknown
  try {
    const body = await request.text()
    if (body.length > 1024) return Response.json({ error: 'Lease request too large' }, { status: 413 })
    input = JSON.parse(body)
  } catch {
    return Response.json({ error: 'Invalid lease request' }, { status: 400 })
  }
  if (!input || typeof input !== 'object' || !('leaseId' in input) || !isLeaseId(input.leaseId)
    || !('active' in input) || typeof input.active !== 'boolean') {
    return Response.json({ error: 'Invalid lease request' }, { status: 400 })
  }
  if (input.active) {
    if (!leases.has(input.leaseId)) {
      if (leases.size >= MAX_LEASES) return Response.json({ error: 'Too many active leases' }, { status: 429 })
      leases.add(input.leaseId)
      powerActivityClock.changed()
    }
  } else {
    releasePowerActivityLease(input.leaseId)
  }
  return Response.json({ ok: true })
}
