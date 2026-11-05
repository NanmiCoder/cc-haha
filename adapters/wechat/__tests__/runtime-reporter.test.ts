import { describe, expect, it } from 'bun:test'
import { WechatRuntimeReporter } from '../runtime-reporter.js'

describe('WeChat local runtime reporting', () => {
  it('registers once, authenticates and reports actual progress without credentials', async () => {
    const requests: Array<{ url: string; body: any; authorization: string | null }> = []
    const reporter = new WechatRuntimeReporter({ serverUrl: 'ws://127.0.0.1:1234', token: 'local-fixture',
      fetch: (async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get('Authorization') })
        return Response.json(String(url).endsWith('/register') ? { leaseId: 'lease-fixture' } : { ok: true })
      }) as typeof fetch,
    })
    await reporter.flush()
    reporter.update({ state: 'online', lastPollOkAt: 10, lastReceiveAt: 11, lastSendAt: 12 })
    await reporter.flush()
    await reporter.stop()
    expect(requests.filter(r => r.url.endsWith('/register'))).toHaveLength(1)
    expect(requests.every(r => r.authorization === 'Bearer local-fixture')).toBe(true)
    expect(requests[2]!.body).toEqual({ leaseId: 'lease-fixture', state: 'online', lastPollOkAt: 10, lastReceiveAt: 11, lastSendAt: 12 })
    expect(requests.at(-1)!.body.state).toBe('stopped')
    expect(JSON.stringify(requests)).not.toContain('botToken')
  })

  it('does not reclaim a superseded lease', async () => {
    let calls = 0
    let superseded = 0
    const reporter = new WechatRuntimeReporter({ serverUrl: 'ws://127.0.0.1:1234', onSuperseded: () => { superseded++ },
      fetch: (async () => ++calls === 1 ? Response.json({ leaseId: 'old' }) : new Response(null, { status: 409 })) as typeof fetch,
    })
    await reporter.flush()
    await reporter.flush()
    expect(calls).toBe(2)
    expect(superseded).toBe(1)
  })

  it('retries local connection failure without inventing a successful report', async () => {
    let calls = 0
    const reporter = new WechatRuntimeReporter({ serverUrl: 'ws://127.0.0.1:1234',
      fetch: (async () => { calls++; throw new Error('offline') }) as typeof fetch,
    })
    await reporter.flush()
    await reporter.flush()
    expect(calls).toBe(2)
  })
})
