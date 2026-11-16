import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { PublicAccessServer } from '../publicAccess.js'
import { diagnosticsService } from '../services/diagnosticsService.js'
import { resolveRemoteAccessProxy, verifyRemoteAccessGateway } from '../services/remoteAccessConnectivity.js'
import type { NetworkSettings } from '../services/networkSettings.js'

function tarEntry(archive: Buffer, wanted: string): string {
  const tar = gunzipSync(archive)
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, '')
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8)
    if (name === wanted) return tar.subarray(offset + 512, offset + 512 + size).toString()
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error(`Missing tar entry ${wanted}`)
}

test('desktop control failures survive recording and real diagnostic bundle export with the same connection attempt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-access-export-'))
  const previousConfig = process.env.CLAUDE_CONFIG_DIR
  const previousToken = process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'fixture-local-access'
  const settings = async (): Promise<NetworkSettings> => ({ aiRequestTimeoutMs: 30000, proxy: { mode: 'manual', url: 'http://private-proxy-user:private-proxy-pass@127.0.0.1:9999' } })
  const cause = Object.assign(new Error('connect ECONNREFUSED http://private-proxy-user:private-proxy-pass@127.0.0.1:9999 token=private-query-secret'), { code: 'ECONNREFUSED', syscall: 'connect' })
  const service = new PublicAccessServer({
    storePath: join(directory, 'devices.json'), serverPort: () => 3456,
    handleApiRequest: async () => new Response(), handleStatic: async () => null, websocket: { message() {} },
    resolveProxy: context => resolveRemoteAccessProxy({ ...context, settings }),
    verifyGateway: (origin, gatewayId, context) => verifyRemoteAccessGateway(origin, gatewayId, { ...context, settings, fetch: (async () => { throw new TypeError('fetch failed', { cause }) }) as typeof fetch }),
  })
  try {
    service.enable('https://probe.example.test')
    const attemptId = '81d5559c-a61e-4871-a185-4e7aaf02c693'
    const request = (route: string, method: string) => service.control(new Request(`http://localhost/api/public-access/${route}`, { method, headers: { Authorization: 'Bearer fixture-local-access', 'X-CC-Haha-Connection-Attempt': attemptId } }))
    expect((await request('network', 'GET')).ok).toBe(true)
    expect(await (await request('verify', 'POST')).json()).toEqual({ ok: false })
    const bundle = await diagnosticsService.exportBundle()
    const archive = await readFile(bundle.path)
    const events = tarEntry(archive, 'diagnostics.jsonl').trim().split('\n').map(line => JSON.parse(line))
    expect(events.find(event => event.type === 'remote_access_gateway_verification' && event.details.outcome === 'failed')).toMatchObject({
      details: { attemptId, stage: 'gateway_request', reason: 'request_failed', proxyMode: 'manual', proxyUsed: true, error: { name: 'TypeError', cause: { name: 'Error', code: 'ECONNREFUSED', syscall: 'connect' } } },
    })
    expect(events.find(event => event.type === 'remote_access_proxy_resolution' && event.details.outcome === 'succeeded')).toMatchObject({ details: { attemptId, stage: 'proxy_resolution', reason: 'proxy_resolved' } })
    const exported = gunzipSync(archive).toString()
    for (const secret of ['private-proxy-user', 'private-proxy-pass', 'private-query-secret', 'fixture-local-access']) expect(exported).not.toContain(secret)
    expect(await diagnosticsService.buildIssueReport()).toContain('reason=request')
  } finally {
    service.disable()
    await diagnosticsService.drainForMigration()
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfig
    if (previousToken === undefined) delete process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
    else process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = previousToken
    await rm(directory, { recursive: true, force: true })
  }
})
