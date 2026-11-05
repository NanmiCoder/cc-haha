import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleAdaptersApi } from '../api/adapters.js'
import { wechatRuntimeService } from '../services/wechatRuntimeService.js'

let directory: string
let previous: string | undefined
let startedAt = Date.now()
function registration(instanceId: string) {
  startedAt = Math.max(Date.now(), startedAt + 1)
  return { instanceId, startedAt }
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'wechat-health-api-'))
  previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  wechatRuntimeService.invalidate()
})
afterEach(async () => {
  wechatRuntimeService.invalidate()
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previous
  await rm(directory, { recursive: true, force: true })
})
async function request(suffix = '', body?: unknown) {
  const url = new URL(`http://localhost/api/adapters/wechat/runtime${suffix}`)
  return handleAdaptersApi(new Request(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), url, url.pathname.split('/').filter(Boolean))
}

describe('WeChat runtime API', () => {
  it('reports health without exposing a lease and rejects replaced worker reports', async () => {
    const firstRegistration = registration('first')
    const first = await (await request('/register', firstRegistration)).json()
    const second = await (await request('/register', registration('second'))).json()
    expect((await request('/register', firstRegistration)).status).toBe(409)
    expect((await request('/report', { leaseId: first.leaseId, state: 'online' })).status).toBe(409)
    expect((await request('/report', { leaseId: second.leaseId, state: 'online', lastPollOkAt: Date.now(), lastReceiveAt: 100 })).status).toBe(200)
    expect(await (await request()).json()).toMatchObject({ state: 'online', lastReceiveAt: 100, serverReachable: true })
    expect(await (await request()).json()).not.toHaveProperty('leaseId')
    await request('/invalidate', {})
    expect((await request('/report', { leaseId: second.leaseId, state: 'online' })).status).toBe(409)
  })
  it('rejects malformed health fields and free-form potentially sensitive error content', async () => {
    const { leaseId } = await (await request('/register', registration('worker'))).json()
    for (const extra of [{ state: 'invented' }, { state: ['online'] }, { lastSendAt: -1 }, { lastPollOkAt: 'yesterday' }, { errorCode: 'https://secret.example/?token=secret' }]) {
      expect((await request('/report', { leaseId, state: 'online', ...extra })).status).toBe(400)
    }
  })
})
