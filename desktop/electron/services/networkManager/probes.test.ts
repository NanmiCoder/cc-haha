import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { probeDirectHttp } from './probes'

const servers: Array<ReturnType<typeof createServer>> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('direct target HTTP probe', () => {
  it.skipIf(process.platform !== 'win32')('reports an HTTP response without using a proxy', async () => {
    const server = createServer((_request, response) => { response.writeHead(404); response.end('reachable') })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected loopback port')
    const result = await probeDirectHttp('127.0.0.1', address.port, 'http')
    expect(result).toMatchObject({ target: `http://127.0.0.1:${address.port}/`, kind: 'http-direct', ok: true, statusCode: 404 })
  })
})
