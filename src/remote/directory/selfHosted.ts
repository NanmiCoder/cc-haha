import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { REMOTE_ID_PATTERN, type RemoteAnnouncement, validateRemoteAnnouncement } from '../../shared/remoteIdentityProtocol'

const MAX_BODY_BYTES = 4096
const WINDOW_MS = 60_000
const SCHEMA_VERSION = 1

export type SelfHostedDirectoryOptions = {
  stateDir: string
  allowedHostIds: readonly string[]
  now?: () => number
  requestLimit?: number
  publishLimit?: number
  bodyTimeoutMs?: number
}

function validateOptions(options: SelfHostedDirectoryOptions): void {
  if (!options.allowedHostIds.length || options.allowedHostIds.length > 128 || !options.allowedHostIds.every(id => REMOTE_ID_PATTERN.test(id))) {
    throw new Error('A nonempty allowed host ID list is required (maximum 128 SHA-256 IDs)')
  }
  if (!isAbsolute(options.stateDir)) throw new Error('An absolute, dedicated state directory is required')
  for (const value of [options.requestLimit ?? 300, options.publishLimit ?? 30, options.bodyTimeoutMs ?? 5000]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Limits must be positive integers')
  }
}

export function parseSelfHostedConfig(env: Record<string, string | undefined>): SelfHostedDirectoryOptions & { port: number } {
  const allowedHostIds = [...new Set((env.CC_HAHA_DIRECTORY_ALLOWED_HOST_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean))]
  const stateDir = env.CC_HAHA_DIRECTORY_STATE_DIR ?? ''
  validateOptions({ stateDir, allowedHostIds })
  const portText = env.CC_HAHA_DIRECTORY_PORT ?? '8788'
  const port = Number(portText)
  if (!/^\d+$/.test(portText) || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid directory port')
  return { stateDir, allowedHostIds, port }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: {
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    ...(status === 429 ? { 'retry-after': '60' } : {}),
  } })
}

async function readAnnouncement(request: Request, now: () => number, timeoutMs: number): Promise<RemoteAnnouncement | null> {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES ||
    request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return null
  const reader = request.body?.getReader()
  if (!reader) return null
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    void reader.cancel().catch(() => {})
  }, timeoutMs)
  try {
    const bytes = new Uint8Array(MAX_BODY_BYTES)
    let length = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (length + value.length > MAX_BODY_BYTES) {
        await reader.cancel()
        return null
      }
      bytes.set(value, length)
      length += value.length
    }
    if (timedOut) return null
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)))
    return await validateRemoteAnnouncement(value, now())
  } catch { return null } finally {
    clearTimeout(timeout)
    reader.releaseLock()
  }
}

/** Private directory: the allowlist controls capacity, signatures control writes. */
export function createSelfHostedDirectory(options: SelfHostedDirectoryOptions) {
  validateOptions(options)
  const allowed = new Set(options.allowedHostIds)
  const now = options.now ?? Date.now
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 })
  chmodSync(options.stateDir, 0o700)
  const databasePath = join(options.stateDir, 'directory.sqlite')
  const database = new Database(databasePath, { create: true, strict: true })
  try {
    const version = database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0
    if (version > SCHEMA_VERSION) throw new Error('Unsupported remote directory schema version')
    database.exec('PRAGMA busy_timeout = 5000')
    database.exec('PRAGMA journal_mode = WAL')
    database.exec('PRAGMA synchronous = FULL')
    if (version === 0) database.transaction(() => {
      database.exec(`CREATE TABLE announcements (
        host_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        record TEXT NOT NULL
      )`)
      database.exec('PRAGMA user_version = 1')
    })()
    chmodSync(databasePath, 0o600)
  } catch (error) {
    database.close()
    throw error
  }

  const read = database.query<{ sequence: number, record: string }, [string]>('SELECT sequence, record FROM announcements WHERE host_id = ?')
  const write = database.query('INSERT INTO announcements (host_id, sequence, record) VALUES (?, ?, ?) ON CONFLICT(host_id) DO UPDATE SET sequence = excluded.sequence, record = excluded.record')
  const publish = database.transaction((incoming: RemoteAnnouncement): Response => {
    const previous = read.get(incoming.hostId)
    const encoded = JSON.stringify(incoming)
    if (previous && incoming.sequence <= previous.sequence) {
      return previous.record === encoded ? json({ ok: true }) : json({ error: 'stale_sequence' }, 409)
    }
    write.run(incoming.hostId, incoming.sequence, encoded)
    return json({ ok: true }, previous ? 200 : 201)
  })

  // Bounded by the explicit host allowlist. Never trust caller-provided IP headers.
  // A global cap also covers malformed/unknown-host requests before signature work.
  let windowStarted = now()
  let requestCount = 0
  const publishCounts = new Map<string, number>()
  function takeRequest(): boolean {
    const timestamp = now()
    if (timestamp < windowStarted || timestamp - windowStarted >= WINDOW_MS) {
      windowStarted = timestamp
      requestCount = 0
      publishCounts.clear()
    }
    return ++requestCount <= (options.requestLimit ?? 300)
  }
  let closed = false
  return {
    async fetch(request: Request): Promise<Response> {
      try {
        if (closed) return json({ error: 'temporarily_unavailable' }, 503)
        const url = new URL(request.url)
        // Health remains available during throttling; it performs no database work.
        if (request.method === 'GET' && url.pathname === '/health' && !url.search) return json({ service: 'cc-haha-remote-directory', protocolVersion: 2, access: 'private' })
        if (!takeRequest()) return json({ error: 'rate_limited' }, 429)
        const match = /^\/v1\/hosts\/([a-f0-9]{64})$/.exec(url.pathname)
        if (!match || url.search) return json({ error: 'not_found' }, 404)
        if (!['GET', 'PUT'].includes(request.method)) return json({ error: 'method_not_allowed' }, 405)
        const hostId = match[1]!
        if (!allowed.has(hostId)) return json({ error: 'host_not_allowed' }, 403)
        if (request.method === 'GET') {
          const row = read.get(hostId)
          if (!row) return json({ error: 'not_found' }, 404)
          const record = JSON.parse(row.record) as RemoteAnnouncement
          if (record.hostId !== hostId || record.sequence !== row.sequence) return json({ error: 'temporarily_unavailable' }, 503)
          if (record.expiresAt <= now()) return json({ error: 'offline' }, 410)
          return json(record)
        }
        const count = (publishCounts.get(hostId) ?? 0) + 1
        publishCounts.set(hostId, count)
        if (count > (options.publishLimit ?? 30)) return json({ error: 'rate_limited' }, 429)
        const record = await readAnnouncement(request, now, options.bodyTimeoutMs ?? 5000)
        if (!record || record.hostId !== hostId) return json({ error: 'invalid_announcement' }, 400)
        return publish.immediate(record)
      } catch { return json({ error: 'temporarily_unavailable' }, 503) }
    },
    close() {
      if (closed) return
      closed = true
      database.close()
    },
  }
}
