import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { AdapterHttpClient } from '../../../adapters/common/http-client.js'
import { currentInboundPowerLease, enqueueInboundPowerActivity } from '../../../adapters/common/inbound-power-activity.js'
import { powerActivityClock } from './powerActivityClock.js'
import { handlePowerActivityLease, hasPowerActivityLeases, releasePowerActivityLease } from './powerActivityLease.js'

let previousToken: string | undefined
const leaseIds = ['adapter-fixture:message-1', 'adapter-fixture:message-2']
function request(body: unknown, token = 'fixture-local-token', method = 'POST'): Request {
  return new Request('http://127.0.0.1:3456/api/sessions/power-activity-lease', {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  })
}

beforeEach(() => {
  previousToken = process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
  process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'fixture-local-token'
})
afterEach(() => {
  for (const id of leaseIds) releasePowerActivityLease(id)
  if (previousToken === undefined) delete process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
  else process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = previousToken
})

describe('inbound power activity leases', () => {
  it('retains simultaneous messages until each explicit release, without manufacturing completions', async () => {
    const before = powerActivityClock.read(false)
    for (const leaseId of leaseIds) {
      expect((await handlePowerActivityLease(request({ leaseId, active: true }))).status).toBe(200)
    }
    expect(hasPowerActivityLeases()).toBe(true)
    releasePowerActivityLease(leaseIds[0])
    expect(hasPowerActivityLeases()).toBe(true)
    const acquired = powerActivityClock.read(true)
    expect(acquired.revision).toBe(before.revision + 3)
    expect(acquired.completionSequence).toBe(before.completionSequence)
    expect(acquired.scheduledCompletionSequence).toBe(before.scheduledCompletionSequence)
    await handlePowerActivityLease(request({ leaseId: leaseIds[1], active: false }))
    expect(hasPowerActivityLeases()).toBe(false)
    expect(powerActivityClock.read(false).revision).toBe(before.revision + 4)
  })

  it('deduplicates retried acquisition and release, and ignores unknown handoff identifiers', async () => {
    const before = powerActivityClock.read(false).revision
    const body = { leaseId: leaseIds[0], active: true }
    await handlePowerActivityLease(request(body))
    await handlePowerActivityLease(request(body))
    expect(powerActivityClock.read(true).revision).toBe(before + 1)
    releasePowerActivityLease('not-an-existing-lease')
    releasePowerActivityLease({ leaseId: leaseIds[0] })
    expect(hasPowerActivityLeases()).toBe(true)
    releasePowerActivityLease(leaseIds[0])
    releasePowerActivityLease(leaseIds[0])
    expect(powerActivityClock.read(false).revision).toBe(before + 2)
  })

  it('rejects missing, wrong, and public-device credentials when local power authority is configured', async () => {
    for (const token of ['', 'wrong', 'haha_mobile_device_fixture']) {
      expect((await handlePowerActivityLease(request({ leaseId: leaseIds[0], active: true }, token))).status).toBe(403)
    }
    expect(hasPowerActivityLeases()).toBe(false)
  })

  it.each([undefined, '', '   '])('declares leases unavailable without local power authority: %j', async token => {
    if (token === undefined) delete process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
    else process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = token
    const before = powerActivityClock.read(false).revision
    expect((await handlePowerActivityLease(request({ leaseId: leaseIds[0], active: true }))).status).toBe(404)
    expect(hasPowerActivityLeases()).toBe(false)
    expect(powerActivityClock.read(false).revision).toBe(before)
  })

  it.each([null, {}, { leaseId: '', active: true }, { leaseId: 'x'.repeat(129), active: true },
    { leaseId: 'bad/id', active: true }, { leaseId: leaseIds[0], active: 'true' },
  ])('rejects invalid input without acquiring activity: %j', async body => {
    expect((await handlePowerActivityLease(request(body))).status).toBe(400)
    expect(hasPowerActivityLeases()).toBe(false)
  })

  it('rejects malformed, oversized, and non-POST requests', async () => {
    const invalid = new Request('http://127.0.0.1/api/sessions/power-activity-lease', {
      method: 'POST', headers: { Authorization: 'Bearer fixture-local-token' }, body: '{',
    })
    expect((await handlePowerActivityLease(invalid)).status).toBe(400)
    expect((await handlePowerActivityLease(request('x'.repeat(1024)))).status).toBe(413)
    expect((await handlePowerActivityLease(request(null, 'fixture-local-token', 'GET'))).status).toBe(405)
    expect(hasPowerActivityLeases()).toBe(false)
  })
})

describe('adapter lease admission over loopback HTTP', () => {
  function serveLeases() {
    const statuses: number[] = []
    const ids: string[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(incoming) {
        if (new URL(incoming.url).pathname !== '/api/sessions/power-activity-lease') return new Response(null, { status: 404 })
        const body = await incoming.clone().json() as { leaseId: string }
        ids.push(body.leaseId)
        const response = await handlePowerActivityLease(incoming)
        statuses.push(response.status)
        return response
      },
    })
    return {
      statuses,
      url: `ws://127.0.0.1:${server.port}`,
      close() {
        server.stop(true)
        for (const id of ids) releasePowerActivityLease(id)
      },
    }
  }

  it('admits paired CLI messages when the source server has no native power authority', async () => {
    delete process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
    const server = serveLeases()
    try {
      const client = new AdapterHttpClient(server.url)
      const errors: unknown[] = []
      let routed = 0
      let hadLease: boolean | undefined
      await enqueueInboundPowerActivity(client, 'paired-cli-user', async lease => {
        routed += 1
        hadLease = !!lease || !!currentInboundPowerLease('paired-cli-user') || hasPowerActivityLeases()
      }, async error => { errors.push(error) })
      expect(errors).toEqual([])
      expect(routed).toBe(1)
      expect(hadLease).toBe(false)
      expect(server.statuses).toEqual([404])
      expect(hasPowerActivityLeases()).toBe(false)
    } finally {
      server.close()
    }
  })

  it.each([undefined, 'wrong', 'haha_mobile_device_fixture'])('blocks adapter admission with unauthorized credentials: %j', async token => {
    const server = serveLeases()
    try {
      // Construct the client without inheriting the server's private credential.
      delete process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
      const client = new AdapterHttpClient(server.url, { localAccessToken: token })
      process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'fixture-local-token'
      const errors: string[] = []
      let routed = false
      await enqueueInboundPowerActivity(client, 'unprotected-cli-user', async () => {
        routed = true
      }, async error => { errors.push(String(error)) })
      expect(routed).toBe(false)
      expect(errors).toEqual(['Error: Activity lease request failed (403)'])
      expect(server.statuses).toEqual([403])
      expect(hasPowerActivityLeases()).toBe(false)
    } finally {
      server.close()
    }
  })

  it('holds a configured server lease until authorized adapter work finishes', async () => {
    const server = serveLeases()
    try {
      const client = new AdapterHttpClient(server.url)
      const errors: unknown[] = []
      let activeLeaseId: string | undefined
      let protectedDuringWork = false
      await enqueueInboundPowerActivity(client, 'protected-cli-user', async lease => {
        activeLeaseId = lease?.id
        protectedDuringWork = hasPowerActivityLeases()
          && currentInboundPowerLease('protected-cli-user')?.id === activeLeaseId
        await Promise.resolve()
        protectedDuringWork &&= hasPowerActivityLeases()
      }, async error => { errors.push(error) })
      expect(errors).toEqual([])
      expect(activeLeaseId).toStartWith('im:')
      expect(protectedDuringWork).toBe(true)
      expect(server.statuses).toEqual([200, 200])
      expect(hasPowerActivityLeases()).toBe(false)
    } finally {
      server.close()
    }
  })
})
