// Executed only by publicAccess.integration.test.ts in an isolated subprocess.
import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises'
import path from 'node:path'
import { startServer, stopServerRuntimeForShutdown } from '../index.js'
import { conversationService } from '../services/conversationService.js'
import { sessionService } from '../services/sessionService.js'

const origin = 'https://fixture.ngrok-free.app'
const requestFetch = globalThis.fetch
// A real route must not silently contact a model/provider during this smoke.
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.hostname !== '127.0.0.1') throw new Error('Public network disabled in remote smoke')
  return requestFetch(input, init)
}) as typeof fetch
await mkdir(process.env.CLAUDE_CONFIG_DIR!, { recursive: true })
await writeFile(path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'fake-never-expose' }, language: 'en', alwaysThinkingEnabled: true }))
process.env.CLAUDE_CLI_PATH = path.join(import.meta.dir, '../__tests__/fixtures/mock-sdk-cli.ts')
const server = startServer(0, '127.0.0.1')
const base = `http://127.0.0.1:${server.port}`
const control = (route: string, body?: unknown) => fetch(`${base}/api/public-access${route}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${process.env.CC_HAHA_LOCAL_ACCESS_TOKEN}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
let socket: WebSocket | undefined
try {
  const denied = await fetch(`${base}/api/public-access`)
  if (denied.status !== 403) throw new Error('Control plane accepted unauthenticated loopback')
  const enabled = await (await control('/enable', { publicUrl: origin })).json()
  let remote = `http://127.0.0.1:${enabled.port}`
  const code = await (await control('/pairing', {})).json()
  const post = (route: string, body: unknown) => fetch(`${remote}/api/public-access/${route}`, { method: 'POST', headers: { Origin: origin }, body: JSON.stringify(body) })
  const pending = await (await post('pair', { secret: code.secret, name: 'Smoke phone' })).json()
  await control('/approve', { id: pending.id })
  const claim = await post('claim', pending)
  const cookie = claim.headers.get('set-cookie')!.split(';')[0]!
  for (const route of ['/health', '/api/models', '/api/models/current', '/api/effort', '/api/permissions/mode', '/api/settings/user', '/api/providers/auth-status', '/api/sessions']) {
    const response = await fetch(`${remote}${route}`, { headers: { Origin: origin, Cookie: cookie } })
    const body = await response.text()
    if (!response.ok) throw new Error(`${route} returned ${response.status}: ${body}`)
    JSON.parse(body)
    if (body.includes('fake-never-expose') || body.includes('ANTHROPIC_API_KEY')) throw new Error(`Secret leaked from ${route}`)
  }
  const authStatus = await (await fetch(`${remote}/api/providers/auth-status`, { headers: { Origin: origin, Cookie: cookie } })).json()
  if (!authStatus.hasAuth || authStatus.source !== 'original-settings') throw new Error('Remote new-session auth check failed')
  const createdResponse = await fetch(`${remote}/api/sessions`, {
    method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workDir: process.env.HOME, permissionMode: 'default' }),
  })
  const created = await createdResponse.json()
  if (createdResponse.status !== 201 || typeof created.sessionId !== 'string') throw new Error(`Remote session creation failed: ${JSON.stringify(created)}`)
  // The fake SDK emits tool events but does not write CLI transcript records.
  // Seed a prior assistant record to independently verify history restoration.
  const sessionFile = await sessionService.findSessionFile(created.sessionId)
  if (!sessionFile) throw new Error('Fixture session transcript unavailable')
  await appendFile(sessionFile.filePath, JSON.stringify({ type: 'assistant', uuid: crypto.randomUUID(), sessionId: created.sessionId, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'remote-history-fixture' }] } }) + '\n')
  async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const value = read()
      if (value !== undefined) return value
      await Bun.sleep(10)
    }
    throw new Error(`Timed out: ${label}`)
  }
  async function connect() {
    const messages: Array<Record<string, any>> = []
    const ws = new WebSocket(`${remote.replace('http:', 'ws:')}/ws/${created.sessionId}`, { headers: { Origin: origin, Cookie: cookie } })
    socket = ws
    ws.onmessage = event => messages.push(JSON.parse(String(event.data)))
    await waitFor(() => messages.find(m => m.type === 'permission_requests_snapshot'), 'websocket snapshot')
    return { ws, messages }
  }
  const first = await connect()
  const writePath = path.join(process.env.HOME!, 'remote-approved.txt')
  const prompt = 'MOCK_TOOL ' + JSON.stringify({ tool: 'Write', input: { file_path: writePath, content: 'remote-success' }, write: { path: writePath, content: 'remote-success' }, reply: 'remote-success' })
  first.ws.send(JSON.stringify({ type: 'user_message', content: prompt }))
  const approval = await waitFor(() => first.messages.find(m => m.type === 'permission_request'), 'initial approval')
  const firstClosed = new Promise<void>(resolve => { first.ws.onclose = () => resolve() })
  first.ws.close()
  await firstClosed
  if (!conversationService.hasSession(created.sessionId)) throw new Error('Disconnect terminated active agent')
  const second = await connect()
  const replay = await waitFor(() => second.messages.find(m => m.type === 'permission_request'), 'replayed approval')
  if (replay.requestId !== approval.requestId) throw new Error('Reconnection replaced pending approval')
  const secondClosed = new Promise<void>(resolve => { second.ws.onclose = () => resolve() })
  await control('/disable', {})
  await secondClosed
  if (!conversationService.hasSession(created.sessionId)) throw new Error('Disabling remote access terminated active agent')
  if (!conversationService.getPendingPermissionRequests(created.sessionId).some(p => p.requestId === approval.requestId)) throw new Error('Disabling remote access lost pending approval')
  const restarted = await (await control('/enable', { publicUrl: origin })).json()
  remote = `http://127.0.0.1:${restarted.port}`
  const third = await connect()
  await waitFor(() => third.messages.find(m => m.type === 'permission_request' && m.requestId === approval.requestId), 'approval after enable')
  third.ws.send(JSON.stringify({ type: 'permission_response', requestId: approval.requestId, allowed: true }))
  await waitFor(() => third.messages.find(m => m.type === 'message_complete'), 'approved tool completion')
  if (await readFile(writePath, 'utf8') !== 'remote-success') throw new Error('Approved mock tool did not finish')
  const history = await fetch(`${remote}/api/sessions/${created.sessionId}/messages`, { headers: { Origin: origin, Cookie: cookie } })
  const historyText = await history.text()
  if (!history.ok || !historyText.includes('remote-history-fixture')) throw new Error(`History missing prior turn after reconnect: ${historyText}`)
  const thirdClosed = new Promise<void>(resolve => { third.ws.onclose = () => resolve() })
  third.ws.close()
  await thirdClosed
  const fourth = await connect()
  const settled = fourth.messages.find(m => m.type === 'permission_requests_snapshot')
  if (settled?.toolRequestIds.includes(approval.requestId)) throw new Error('Completed approval replayed after reconnect')
  const ws = fourth.ws
  const revoked = new Promise<void>(resolve => { ws.onclose = () => resolve() })
  await control('/revoke', { id: pending.id })
  await revoked
  if ((await fetch(`${remote}/api/sessions`, { headers: { Cookie: cookie } })).status !== 401) throw new Error('Revoked device retained API access')
  await control('/disable', {})
  if ((await (await control('')).json()).enabled !== false) throw new Error('Disable did not clear status')
  console.log('REMOTE_INTEGRATION_PASSED')
} finally {
  socket?.close()
  await stopServerRuntimeForShutdown()
  await server.stop(true)
}
// Runtime watchers may have retry timers; the subprocess owns their full lifetime.
process.exit(0)
