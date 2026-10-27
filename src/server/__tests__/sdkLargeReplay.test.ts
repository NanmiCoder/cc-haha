import { expect, spyOn, test } from 'bun:test'
import { handleWebSocket, type WebSocketData } from '../ws/handler.js'
import { conversationService } from '../services/conversationService.js'

test('large image replay reaches the SDK consumer intact before the terminal result', async () => {
  const received: string[] = []
  const closes: number[] = []
  const spies = [
    spyOn(conversationService, 'authorizeSdkConnection').mockReturnValue(true),
    spyOn(conversationService, 'attachSdkConnection').mockImplementation(() => {}),
    spyOn(conversationService, 'detachSdkConnection').mockImplementation(() => {}),
    spyOn(conversationService, 'handleSdkPayload').mockImplementation((_id, payload) => { received.push(payload) }),
  ]
  const server = Bun.serve<WebSocketData>({
    hostname: '127.0.0.1', port: 0,
    fetch(req, host) {
      return host.upgrade(req, { data: { sessionId: 'fixture', channel: 'sdk', sdkToken: 'fake', clientKind: 'full', connectedAt: Date.now(), serverPort: host.port, serverHost: '127.0.0.1' } })
        ? undefined : new Response('upgrade failed', { status: 400 })
    },
    websocket: handleWebSocket,
  })
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/sdk/fixture`)
  socket.onclose = event => { closes.push(event.code) }
  try {
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject })
    const replay = JSON.stringify({ type: 'user', isReplay: true, message: { role: 'user', content: Array.from({ length: 10 }, (_, i) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: String(i).repeat(4_641_880) } })) } })
    socket.send(replay)
    const deadline = Date.now() + 3_000
    while (!received.length && !closes.length && Date.now() < deadline) await Bun.sleep(10)
    expect(closes).toEqual([])
    expect(received).toEqual([replay])
    const result = JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })
    socket.send(result)
    while (received.length < 2 && Date.now() < deadline) await Bun.sleep(10)
    expect(received).toEqual([replay, result])
  } finally {
    socket.close()
    server.stop(true)
    for (const spy of spies) spy.mockRestore()
  }
}, 10_000)

test('renderer messages retain the smaller input budget', () => {
  const closed: Array<[number | undefined, string | undefined]> = []
  handleWebSocket.message({
    data: { sessionId: 'fixture', channel: 'client', sdkToken: null, clientKind: 'full', connectedAt: 0, serverPort: 1, serverHost: '127.0.0.1' },
    send: () => 0,
    close: (code, reason) => { closed.push([code, reason]) },
  }, Buffer.alloc(16 * 1024 * 1024 + 1, 32))
  expect(closed).toEqual([[1009, 'Client message exceeds 16 MiB']])
})
