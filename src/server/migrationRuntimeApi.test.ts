import { expect, test } from 'bun:test'
import { handleMigrationRuntimeRequest } from './migrationRuntimeApi.js'

test('migration control rejects H5, forwarded, external and tokenless requests', async () => {
  const oldToken = process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
  process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'isolated-token'
  let calls = 0
  const control = { preview: async () => ({ activeTasks: 2, externalProcesses: 0 }), quiesce: async () => { calls++ }, activate: async () => {} }
  try {
    for (const [address, headers] of [
      ['127.0.0.1', {}],
      ['192.168.0.4', { Authorization: 'Bearer isolated-token' }],
      ['127.0.0.1', { Authorization: 'Bearer isolated-token', Origin: 'https://remote.test' }],
      ['127.0.0.1', { Authorization: 'Bearer isolated-token', 'x-forwarded-for': '8.8.8.8' }],
    ] as [string, Record<string, string>][]) {
      const response = await handleMigrationRuntimeRequest(new Request('http://localhost/api/runtime/migration/quiesce', { method: 'POST', headers }), address, control)
      expect(response.status).toBe(403)
    }
    expect(calls).toBe(0)
    const response = await handleMigrationRuntimeRequest(new Request('http://localhost/api/runtime/migration/quiesce', { method: 'POST', headers: { Authorization: 'Bearer isolated-token' } }), '127.0.0.1', control)
    expect(await response.json()).toEqual({ quiesced: true })
    expect(calls).toBe(1)
  } finally {
    if (oldToken === undefined) delete process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
    else process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = oldToken
  }
})
