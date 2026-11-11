import { REMOTE_ID_PATTERN, type RemoteAnnouncement, validateRemoteAnnouncement } from '../../shared/remoteIdentityProtocol'

const MAX_ANNOUNCEMENT_BYTES = 4096
type RateLimit = { limit(options: { key: string }): Promise<{ success: boolean }> }
type Store = {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  transaction<T>(callback: (transaction: Store) => Promise<T>): Promise<T>
}
type State = { storage: Store }
export type DirectoryEnvironment = {
  HOSTS: { idFromName(name: string): unknown, get(id: unknown): { fetch(request: Request): Promise<Response> } }
  REQUEST_LIMIT: RateLimit
  PUBLISH_LIMIT: RateLimit
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } })
}

async function readAnnouncement(request: Request): Promise<RemoteAnnouncement | null> {
  if (Number(request.headers.get('content-length')) > MAX_ANNOUNCEMENT_BYTES ||
    request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return null
  const reader = request.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > MAX_ANNOUNCEMENT_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return await validateRemoteAnnouncement(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  } catch { return null } finally { reader.releaseLock() }
}

/** One bounded record per public computer identity. No session or device secrets. */
export class MachineDirectory {
  constructor(private readonly state: State) {}

  async fetch(request: Request): Promise<Response> {
    const hostId = new URL(request.url).pathname.split('/').at(-1) ?? ''
    if (!REMOTE_ID_PATTERN.test(hostId)) return json({ error: 'invalid_host' }, 400)
    if (request.method === 'GET') {
      const record = await this.state.storage.get<RemoteAnnouncement>('announcement')
      if (!record || record.hostId !== hostId) return json({ error: 'not_found' }, 404)
      if (record.expiresAt <= Date.now()) return json({ error: 'offline' }, 410)
      return json(record)
    }
    if (request.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405)
    const incoming = await readAnnouncement(request)
    if (!incoming || incoming.hostId !== hostId) return json({ error: 'invalid_announcement' }, 400)
    return this.state.storage.transaction(async transaction => {
      const previous = await transaction.get<RemoteAnnouncement>('announcement')
      if (previous && (previous.hostId !== incoming.hostId || incoming.sequence <= previous.sequence)) {
        if (JSON.stringify(previous) === JSON.stringify(incoming)) return json({ ok: true }, 200)
        return json({ error: 'stale_sequence' }, 409)
      }
      await transaction.put('announcement', incoming)
      return json({ ok: true }, previous ? 200 : 201)
    })
  }
}

export default {
  async fetch(request: Request, env: DirectoryEnvironment): Promise<Response> {
    const url = new URL(request.url)
    // Local workerd uses loopback HTTP; deployed callers must use TLS.
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return json({ error: 'https_required' }, 400)
    if (request.method === 'GET' && url.pathname === '/health' && !url.search) return json({ service: 'cc-haha-remote-directory', protocolVersion: 2 })
    const match = /^\/v1\/hosts\/([a-f0-9]{64})$/.exec(url.pathname)
    if (!match || url.search) return json({ error: 'not_found' }, 404)
    if (!['GET', 'PUT'].includes(request.method)) return json({ error: 'method_not_allowed' }, 405)
    try {
      const hostId = match[1]!
      // The broad IP cap protects key creation; per-host publication protects storage.
      // Cloudflare's edge sets this header. The local development fallback is shared.
      const ip = request.headers.get('cf-connecting-ip') ?? 'local-development'
      if (!(await env.REQUEST_LIMIT.limit({ key: ip })).success) return json({ error: 'rate_limited' }, 429)
      let forwarded: Request
      if (request.method === 'PUT') {
        const record = await readAnnouncement(request)
        if (!record || record.hostId !== hostId) return json({ error: 'invalid_announcement' }, 400)
        if (!(await env.PUBLISH_LIMIT.limit({ key: hostId })).success) return json({ error: 'rate_limited' }, 429)
        // Only verified, bounded public metadata crosses the storage boundary.
        forwarded = new Request(request.url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(record) })
      } else forwarded = new Request(request.url)
      return await env.HOSTS.get(env.HOSTS.idFromName(hostId)).fetch(forwarded)
    } catch { return json({ error: 'temporarily_unavailable' }, 503) }
  },
}
