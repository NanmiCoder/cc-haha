// Executed only by publicAccess.integration.test.ts in an isolated subprocess.
import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises'
import { constants, createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import path from 'node:path'
import { startServer, stopServerRuntimeForShutdown } from '../index.js'
import { conversationService } from '../services/conversationService.js'
import { ProviderService } from '../services/providerService.js'
import { sessionService } from '../services/sessionService.js'
import { remoteCanonical, verifyRemoteSignature } from '../../shared/remoteIdentityProtocol.js'

let origin = 'https://fixture.trycloudflare.com'
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
// Saved providers a new session can be pinned to; the global default stays Claude Official.
const fixtureModels = { main: 'fixture-model', haiku: 'fixture-model', sonnet: 'fixture-model', opus: 'fixture-model' }
const keyedProvider = await new ProviderService().addProvider({ presetId: 'custom', name: 'Keyed fixture', baseUrl: 'http://127.0.0.1:9/anthropic', apiKey: 'fake-remote-provider-key', apiFormat: 'anthropic', models: fixtureModels })
const keylessProvider = await new ProviderService().addProvider({ presetId: 'custom', name: 'Keyless fixture', baseUrl: 'http://127.0.0.1:9/anthropic', apiKey: '', apiFormat: 'anthropic', models: fixtureModels })
const server = startServer(0, '127.0.0.1')
const base = `http://127.0.0.1:${server.port}`
const control = (route: string, body?: unknown) => fetch(`${base}/api/public-access${route}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${process.env.CC_HAHA_LOCAL_ACCESS_TOKEN}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
let socket: WebSocket | undefined
let desktopSocket: WebSocket | undefined
try {
  const denied = await fetch(`${base}/api/public-access`)
  if (denied.status !== 403) throw new Error('Control plane accepted unauthenticated loopback')
  let enabled = await (await control('/enable', { publicUrl: origin })).json()
  const nativeClient = process.env.CC_HAHA_PUBLIC_ACCESS_TEST_CLIENT === 'native'
  // Reuse a port allocated by this isolated process to exercise a custom
  // tunnel's stable upstream without competing for a hard-coded machine port.
  const fixedPort = nativeClient ? enabled.port : undefined
  if (fixedPort !== undefined) {
    await control('/disable', {})
    enabled = await (await control('/enable', { publicUrl: origin, port: fixedPort })).json()
    if (enabled.port !== fixedPort) throw new Error('Custom tunnel did not bind the requested fixed port')
  }
  let remote = `http://127.0.0.1:${enabled.port}`
  const identity = await (await control('/native/configure', { directoryUrl: 'https://fixture-directory.example.test' })).json()
  if (identity.version !== 2 || typeof identity.hostId !== 'string') throw new Error('Native control route unavailable')
  const code = await (await control('/pairing', {})).json()
  if (code.nativeBinding?.hostId !== identity.hostId) throw new Error('Pairing did not include host identity')
  const post = (route: string, body: unknown) => fetch(`${remote}/api/public-access/${route}`, { method: 'POST', headers: { Origin: origin }, body: JSON.stringify(body) })
  const pending = await (await post('pair', { secret: code.secret, name: 'Smoke phone', ...(nativeClient ? { clientType: 'native' } : {}) })).json()
  await control('/approve', { id: pending.id })
  const claim = await post('claim', pending)
  let authHeaders: Record<string, string>
  if (nativeClient) {
    const credential = await claim.json()
    if (claim.headers.has('set-cookie') || credential.tokenType !== 'Bearer' || !/^native_[A-Za-z0-9_-]{43}$/.test(credential.token)) throw new Error('Native pairing did not issue an isolated bearer credential')
    authHeaders = { Authorization: `Bearer ${credential.token}` }
  } else {
    authHeaders = { Cookie: claim.headers.get('set-cookie')!.split(';')[0]! }
  }
  const phone = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 })
  const devicePublicKey = phone.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
  const deviceSign = (purpose: string, fields: string[]) => sign('sha256', remoteCanonical(purpose, fields), { key: phone.privateKey, padding: constants.RSA_PKCS1_PADDING }).toString('base64url')
  const nonce = randomBytes(32).toString('base64url')
  const enroll = await fetch(`${remote}/api/public-access/native/enroll`, { method: 'POST', headers: { Origin: origin, ...authHeaders },
    body: JSON.stringify({ devicePublicKey, nonce, signature: deviceSign('enroll', [identity.hostId, origin, devicePublicKey, nonce]) }),
  })
  if (!enroll.ok) throw new Error('Approved device could not enroll its native key')
  const enrolled = await enroll.json()
  if (enrolled.deviceId !== pending.id || !await verifyRemoteSignature(identity.publicKey, enrolled.signature,
    remoteCanonical('enrolled', [identity.hostId, origin, pending.id, devicePublicKey, nonce]))) throw new Error('Native enrollment proof invalid')
  if ((await fetch(`${remote}/api/public-access/native/challenge`, { method: 'POST', body: JSON.stringify({ hostId: identity.hostId, nonce }) })).status !== 403) throw new Error('Native endpoint omitted Origin enforcement')
  if ((await fetch(`${base}/api/public-access/native/identity`)).status !== 403) throw new Error('Native control identity bypassed desktop credential')
  for (const route of ['/health', '/api/models', '/api/models/current', '/api/effort', '/api/permissions/mode', '/api/settings/user', '/api/providers/auth-status', '/api/sessions']) {
    const response = await fetch(`${remote}${route}`, { headers: { Origin: origin, ...authHeaders } })
    const body = await response.text()
    if (!response.ok) throw new Error(`${route} returned ${response.status}: ${body}`)
    JSON.parse(body)
    if (body.includes('fake-never-expose') || body.includes('ANTHROPIC_API_KEY')) throw new Error(`Secret leaked from ${route}`)
  }
  const authStatus = await (await fetch(`${remote}/api/providers/auth-status`, { headers: { Origin: origin, ...authHeaders } })).json()
  if (!authStatus.hasAuth || authStatus.source !== 'original-settings') throw new Error('Remote new-session auth check failed')
  const providerListResponse = await fetch(`${remote}/api/providers`, { headers: { Origin: origin, ...authHeaders } })
  const providerListText = await providerListResponse.text()
  if (!providerListResponse.ok) throw new Error(`Remote provider listing failed: ${providerListResponse.status}`)
  const providerList = JSON.parse(providerListText)
  if (JSON.stringify(providerList.builtInProviderAvailability) !== JSON.stringify({ 'claude-official': true, 'openai-official': false, 'grok-official': false, 'deepseek-account': false })) throw new Error('Remote provider listing lost the local availability snapshot')
  if (providerListText.includes('fake-never-expose') || providerListText.includes('fake-remote-provider-key')) throw new Error('Remote provider listing leaked a credential')
  if (!providerList.providers.some((provider: { id: string, hasApiKey: boolean, apiKey: string }) => provider.id === keyedProvider.id && provider.hasApiKey && provider.apiKey === '')) throw new Error('Remote provider listing lost the configured API-key provider')
  const scopedAuthStatus = async (providerId: string) => {
    const response = await fetch(`${remote}/api/providers/auth-status?providerId=${encodeURIComponent(providerId)}`, { headers: { Origin: origin, ...authHeaders } })
    const body = await response.text()
    if (!response.ok) throw new Error(`Provider-scoped auth-status returned ${response.status}: ${body}`)
    if (body.includes('fake-never-expose') || body.includes('fake-remote-provider-key')) throw new Error('Secret leaked from provider-scoped auth-status')
    return JSON.parse(body) as Record<string, unknown>
  }
  // A session pinned to a saved provider runs with that provider's own key only.
  const keylessStatus = await scopedAuthStatus(keylessProvider.id)
  if (JSON.stringify(keylessStatus) !== JSON.stringify({ hasAuth: false, source: 'none', activeProvider: 'Keyless fixture' })) throw new Error(`Provider-scoped auth-status borrowed ambient credentials: ${JSON.stringify(keylessStatus)}`)
  const keyedStatus = await scopedAuthStatus(keyedProvider.id)
  if (JSON.stringify(keyedStatus) !== JSON.stringify({ hasAuth: true, source: 'cc-haha-provider', activeProvider: 'Keyed fixture' })) throw new Error(`Provider-scoped auth-status missed the provider key: ${JSON.stringify(keyedStatus)}`)
  const createdResponse = await fetch(`${remote}/api/sessions`, {
    method: 'POST', headers: { Origin: origin, ...authHeaders, 'Content-Type': 'application/json' },
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
    const ws = new WebSocket(`${remote.replace('http:', 'ws:')}/ws/${created.sessionId}`, { headers: { Origin: origin, ...authHeaders } })
    socket = ws
    ws.onmessage = event => messages.push(JSON.parse(String(event.data)))
    await waitFor(() => messages.find(m => m.type === 'permission_requests_snapshot'), 'websocket snapshot')
    return { ws, messages }
  }
  const desktopMessages: Array<Record<string, any>> = []
  async function connectDesktop() {
    const offset = desktopMessages.length
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws/${created.sessionId}`, {
      headers: { Authorization: `Bearer ${process.env.CC_HAHA_LOCAL_ACCESS_TOKEN}` },
    })
    desktopSocket = ws
    ws.onmessage = event => desktopMessages.push(JSON.parse(String(event.data)))
    await waitFor(() => desktopMessages.slice(offset).find(m => m.type === 'connected'), 'desktop connection')
    return ws
  }
  const initialDesktop = await connectDesktop()
  const writePath = path.join(process.env.HOME!, 'remote-approved.txt')
  const prompt = 'MOCK_TOOL ' + JSON.stringify({ tool: 'Write', input: { file_path: writePath, content: 'remote-success' }, write: { path: writePath, content: 'remote-success' }, reply: 'remote-success' })
  initialDesktop.send(JSON.stringify({ type: 'user_message', content: prompt }))
  const approval = await waitFor(() => desktopMessages.find(m => m.type === 'permission_request'), 'desktop-started approval')
  const first = await connect()
  const attachedApproval = await waitFor(() => first.messages.find(m => m.type === 'permission_request'), 'phone attaches to running desktop task')
  if (attachedApproval.requestId !== approval.requestId) throw new Error('Phone did not attach to the same desktop task')
  const desktopClosed = new Promise<void>(resolve => { initialDesktop.onclose = () => resolve() })
  initialDesktop.close()
  await desktopClosed
  const firstClosed = new Promise<void>(resolve => { first.ws.onclose = () => resolve() })
  first.ws.close()
  await firstClosed
  if (!conversationService.hasSession(created.sessionId)) throw new Error('Disconnect terminated active agent')
  const second = await connect()
  const replay = await waitFor(() => second.messages.find(m => m.type === 'permission_request'), 'replayed approval')
  if (replay.requestId !== approval.requestId) throw new Error('Reconnection replaced pending approval')
  const secondClosed = new Promise<number>(resolve => { second.ws.onclose = event => resolve(event.code) })
  await control('/disable', {})
  if (await secondClosed !== 1012) throw new Error('Temporary tunnel shutdown incorrectly invalidated device authorization')
  if (!conversationService.hasSession(created.sessionId)) throw new Error('Disabling remote access terminated active agent')
  if (!conversationService.getPendingPermissionRequests(created.sessionId).some(p => p.requestId === approval.requestId)) throw new Error('Disabling remote access lost pending approval')
  origin = 'https://restarted-fixture.trycloudflare.com'
  const restarted = await (await control('/enable', { publicUrl: origin, ...(fixedPort === undefined ? {} : { port: fixedPort }) })).json()
  if (fixedPort !== undefined && restarted.port !== fixedPort) throw new Error('Custom tunnel upstream changed after restart')
  remote = `http://127.0.0.1:${restarted.port}`
  if ((await fetch(`${remote}/api/sessions`, { headers: { Origin: origin, ...authHeaders } })).status !== 401) throw new Error('Old-domain credential survived a tunnel origin change')
  const resumeNonce = randomBytes(32).toString('base64url')
  const proof = await (await post('native/challenge', { hostId: identity.hostId, nonce: resumeNonce })).json()
  if (!await verifyRemoteSignature(identity.publicKey, proof.signature,
    remoteCanonical('host-proof', [identity.hostId, origin, resumeNonce, proof.challenge, String(proof.expiresAt)]))) throw new Error('New-origin host proof invalid')
  const resumed = await post('native/session', { hostId: identity.hostId, deviceId: pending.id, nonce: resumeNonce, challenge: proof.challenge, expiresAt: proof.expiresAt,
    signature: deviceSign('resume', [identity.hostId, origin, pending.id, resumeNonce, proof.challenge, String(proof.expiresAt)]),
    ...(nativeClient ? { clientType: 'native' } : {}),
  })
  if (!resumed.ok) throw new Error('Bound device could not resume on the new tunnel origin')
  const resumedProof = await resumed.json()
  let resumedToken: string
  if (nativeClient) {
    if (resumed.headers.has('set-cookie') || resumedProof.tokenType !== 'Bearer' || !/^native_[A-Za-z0-9_-]{43}$/.test(resumedProof.token)) throw new Error('Native resume did not issue an isolated bearer')
    resumedToken = resumedProof.token
    authHeaders = { Authorization: `Bearer ${resumedToken}` }
  } else {
    const cookie = resumed.headers.get('set-cookie')!.split(';')[0]!
    resumedToken = cookie.slice(cookie.indexOf('=') + 1)
    authHeaders = { Cookie: cookie }
  }
  if (resumedProof.tokenHash !== createHash('sha256').update(resumedToken).digest('hex') || !await verifyRemoteSignature(identity.publicKey, resumedProof.signature,
    remoteCanonical('session', [identity.hostId, origin, pending.id, resumeNonce, resumedProof.tokenHash, String(resumedProof.expiresAt)]))) throw new Error('Resumed credential proof invalid')
  const third = await connect()
  await waitFor(() => third.messages.find(m => m.type === 'permission_request' && m.requestId === approval.requestId), 'approval after enable')
  await connectDesktop()
  third.ws.send(JSON.stringify({ type: 'permission_response', requestId: approval.requestId, allowed: true }))
  await waitFor(() => third.messages.find(m => m.type === 'message_complete'), 'approved tool completion')
  await waitFor(() => desktopMessages.find(m => m.type === 'message_complete'), 'desktop receives phone-approved completion')
  if (await readFile(writePath, 'utf8') !== 'remote-success') throw new Error('Approved mock tool did not finish')
  // A follow-up from the phone uses the same live runtime and streams to both clients.
  const phoneOffset = third.messages.length
  const desktopOffset = desktopMessages.length
  third.ws.send(JSON.stringify({ type: 'user_message', content: 'Continue from Android fixture' }))
  await waitFor(() => third.messages.slice(phoneOffset).find(m => m.type === 'message_complete'), 'phone follow-up completion')
  await waitFor(() => desktopMessages.slice(desktopOffset).find(m => m.type === 'message_complete'), 'desktop follow-up completion')
  for (const received of [third.messages.slice(phoneOffset), desktopMessages.slice(desktopOffset)]) {
    if (!received.some(m => m.type === 'content_delta' && String(m.text).includes('Continue from Android fixture'))) {
      throw new Error('Live follow-up stream was not delivered to both desktop and phone')
    }
  }
  const history = await fetch(`${remote}/api/sessions/${created.sessionId}/messages`, { headers: { Origin: origin, ...authHeaders } })
  const historyText = await history.text()
  if (!history.ok || !historyText.includes('remote-history-fixture')) throw new Error(`History missing prior turn after reconnect: ${historyText}`)
  const thirdClosed = new Promise<void>(resolve => { third.ws.onclose = () => resolve() })
  third.ws.close()
  await thirdClosed
  const fourth = await connect()
  const settled = fourth.messages.find(m => m.type === 'permission_requests_snapshot')
  if (settled?.toolRequestIds.includes(approval.requestId)) throw new Error('Completed approval replayed after reconnect')
  const ws = fourth.ws
  const revoked = new Promise<number>(resolve => { ws.onclose = event => resolve(event.code) })
  await control('/revoke', { id: pending.id })
  if (await revoked !== 1008) throw new Error('Revocation did not reject the paired device')
  if ((await fetch(`${remote}/api/sessions`, { headers: { Origin: origin, ...authHeaders } })).status !== 401) throw new Error('Revoked device retained API access')
  await control('/disable', {})
  if ((await (await control('')).json()).enabled !== false) throw new Error('Disable did not clear status')
  // Persist the success marker before explicit exit: Bun can lose captured stdout.
  await writeFile(path.join(process.env.CLAUDE_CONFIG_DIR!, 'REMOTE_INTEGRATION_PASSED'), 'passed')
  console.log('REMOTE_INTEGRATION_PASSED')
} finally {
  socket?.close()
  desktopSocket?.close()
  await stopServerRuntimeForShutdown()
  await server.stop(true)
}
// Runtime watchers may have retry timers; the subprocess owns their full lifetime.
process.exit(0)
