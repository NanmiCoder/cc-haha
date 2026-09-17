import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { requestPinnedRemoteImageHop } from '../../safe-remote-image.js'

const server = createServer((_request, reply) => {
  reply.writeHead(200, { 'content-type': 'image/png' })
  const drip = setInterval(() => reply.write('x'), 10)
  reply.on('close', () => clearInterval(drip))
})

await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})

try {
  const address = server.address()
  assert(address && typeof address !== 'string', 'missing test port')
  const startedAt = Date.now()
  const hop = await requestPinnedRemoteImageHop(
    new URL(`http://images.example:${address.port}/slow.png`),
    { address: '127.0.0.1', family: 4 },
    50,
  )

  await assert.rejects(async () => {
    for await (const _chunk of hop.body) {
      // Consume until the production total deadline aborts the response.
    }
  })
  assert(Date.now() - startedAt < 500, 'total deadline was not enforced')
  console.log('slow-drip timeout verified')
} finally {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
