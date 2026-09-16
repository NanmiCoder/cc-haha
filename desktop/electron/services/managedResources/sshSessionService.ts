import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import { Client as SshClient } from 'ssh2'
import type {
  SshConnectionStatus,
  SshHostKeyChallenge,
  HostManagementEvent,
} from '../../../src/features/managed-resources/types/resourceTypes.js'
import type { KnownHostsService } from './knownHosts.js'
import type { ResourceDocumentStore } from './repositories/resourceDocumentStore.js'
import type { CredentialVault } from './vault/credentialVault.js'

export type { SshConnectionStatus, SshHostKeyChallenge, HostManagementEvent }

export type SshSessionOptions = {
  store: ResourceDocumentStore
  knownHosts: KnownHostsService
  vault?: CredentialVault
  resolveTemporaryCredential?: (input: { ownerId: string; hostId: string }) => {
    password?: string
    privateKeyPem?: string
    passphrase?: string
  } | null
  maxConnectionsPerOwner?: number
  highWatermarkBytes?: number
  lowWatermarkBytes?: number
  hardLimitBytes?: number
  /** Total SSH handshake budget. Must outlive the interactive host-key prompt. */
  readyTimeoutMs?: number
  /** Time allowed for the user to confirm an unknown server host key. */
  hostKeyChallengeTimeoutMs?: number
}

export type SshSession = {
  connectionId: string
  generation: number
  ownerId: string
  hostId: string
  status: SshConnectionStatus
  cols: number
  rows: number
  client: SshClient | null
  channel: any | null
  unackedBytes: number
  isPaused: boolean
  seq: number
  pendingChallenge: {
    challengeId: string
    endpoint: string
    algorithm: string
    sha256: string
    verifyCallback: (result: boolean) => void
    timer: NodeJS.Timeout
  } | null
  createdAt: string
}

export type SshSessionService = {
  createConnection(input: {
    hostId: string
    expectedRevision?: number
    cols?: number
    rows?: number
    ownerId: string
  }): Promise<{ connectionId: string; generation: number }>

  startConnection(input: {
    connectionId: string
    ownerId: string
  }): Promise<void>

  answerHostKey(input: {
    connectionId: string
    challengeId: string
    decision: 'trust' | 'reject'
    ownerId: string
  }): Promise<void>

  write(input: {
    connectionId: string
    generation: number
    data: string
    isBase64?: boolean
    ownerId: string
  }): Promise<void>

  resize(input: {
    connectionId: string
    generation: number
    cols: number
    rows: number
    ownerId: string
  }): Promise<void>

  ackOutput(input: {
    connectionId: string
    generation: number
    bytesAcked: number
    ownerId: string
  }): Promise<void>

  disconnect(input: {
    connectionId: string
    ownerId: string
  }): Promise<void>

  subscribe(listener: (event: HostManagementEvent) => void): () => void

  subscribeForConnection(
    connectionId: string,
    ownerId: string,
    listener: (event: HostManagementEvent) => void,
  ): () => void

  getClient(connectionId: string): SshClient | null
  getSession(connectionId: string): {
    connectionId: string
    generation: number
    hostId: string
    status: SshConnectionStatus
    cols: number
    rows: number
  } | null
  getInternalsForOwner(connectionId: string, ownerId: string): {
    session: SshSession
    client: SshClient
    generation: number
    ownerId: string
  } | null

  dispose(): Promise<void>
}

const DEFAULT_HIGH_WATERMARK = 1024 * 1024 // 1 MiB
const DEFAULT_LOW_WATERMARK = 256 * 1024 // 256 KiB
const DEFAULT_HARD_LIMIT = 8 * 1024 * 1024 // 8 MiB
const DEFAULT_MAX_CONNECTIONS = 20
const DEFAULT_HOST_KEY_CHALLENGE_TIMEOUT_MS = 120_000
const DEFAULT_READY_TIMEOUT_MS = 150_000
const HOST_KEY_READY_TIMEOUT_MARGIN_MS = 30_000

export function createSshSessionService(options: SshSessionOptions): SshSessionService {
  const {
    store,
    knownHosts,
    vault,
    resolveTemporaryCredential,
    maxConnectionsPerOwner = DEFAULT_MAX_CONNECTIONS,
    highWatermarkBytes = DEFAULT_HIGH_WATERMARK,
    lowWatermarkBytes = DEFAULT_LOW_WATERMARK,
    hardLimitBytes = DEFAULT_HARD_LIMIT,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    hostKeyChallengeTimeoutMs = DEFAULT_HOST_KEY_CHALLENGE_TIMEOUT_MS,
  } = options

  const normalizedHostKeyChallengeTimeoutMs = Number.isFinite(hostKeyChallengeTimeoutMs) && hostKeyChallengeTimeoutMs > 0
    ? Math.floor(hostKeyChallengeTimeoutMs)
    : DEFAULT_HOST_KEY_CHALLENGE_TIMEOUT_MS
  const normalizedReadyTimeoutMs = Number.isFinite(readyTimeoutMs) && readyTimeoutMs > 0
    ? Math.floor(readyTimeoutMs)
    : DEFAULT_READY_TIMEOUT_MS
  // ssh2's readyTimeout covers KEX + host verification + authentication. It
  // therefore must never expire while our interactive host-key confirmation is
  // still legitimately waiting for the user.
  const effectiveReadyTimeoutMs = Math.max(
    normalizedReadyTimeoutMs,
    normalizedHostKeyChallengeTimeoutMs + HOST_KEY_READY_TIMEOUT_MARGIN_MS,
  )

  const sessions = new Map<string, SshSession>()
  const listeners = new Set<(event: HostManagementEvent) => void>()
  // Per-connection subscription registry. A global listener alone does NOT
  // authorize startConnection — the calling owner must explicitly register
  // their interest in this connectionId. This stops a second BrowserWindow
  // (preview, pet, stray webview) from piggy-backing on the main window's
  // listener to start connections it does not own.
  const connectionSubscriptions = new Map<string, {
    owners: Set<string>
    listeners: Set<(event: HostManagementEvent) => void>
  }>()

  function emit(event: HostManagementEvent) {
    listeners.forEach((listener) => {
      try {
        listener(event)
      } catch (err) {
        console.error('Error in SSH listener:', err)
      }
    })
  }

  function countOwnerSessions(ownerId: string): number {
    let count = 0
    for (const session of sessions.values()) {
      if (session.ownerId === ownerId && session.status !== 'closed') {
        count += 1
      }
    }
    return count
  }

  function cleanupSession(session: SshSession) {
    if (session.pendingChallenge) {
      clearTimeout(session.pendingChallenge.timer)
      session.pendingChallenge = null
    }
    if (session.channel) {
      try {
        session.channel.close()
      } catch {}
      session.channel = null
    }
    if (session.client) {
      try {
        session.client.end()
        session.client.destroy()
      } catch {}
      session.client = null
    }
    session.unackedBytes = 0
    session.isPaused = false
    session.seq = 0
  }

  function updateStatus(session: SshSession, status: SshConnectionStatus, error?: string, hostKeyChallenge?: SshHostKeyChallenge) {
    session.status = status
    emit({
      type: 'connection-state',
      connectionId: session.connectionId,
      generation: session.generation,
      status,
      error,
      hostKeyChallenge,
    })
  }

  function handleOutput(session: SshSession, chunk: Buffer, gen: number) {
    if (gen !== session.generation || session.status === 'closed' || session.status === 'closing') {
      return
    }

    session.unackedBytes += chunk.length
    session.seq += 1

    emit({
      type: 'terminal-output',
      connectionId: session.connectionId,
      generation: session.generation,
      seq: session.seq,
      data: chunk.toString('base64'),
      byteLength: chunk.length,
    })

    if (session.unackedBytes > hardLimitBytes) {
      updateStatus(session, 'failed', 'BUFFER_OVERFLOW')
      cleanupSession(session)
      return
    }

    if (session.unackedBytes > highWatermarkBytes && !session.isPaused) {
      session.isPaused = true
      try {
        session.channel?.pause()
      } catch {}
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    /**
     * Bind this owner+listener to a specific connectionId so startConnection
     * can authorize the call. Returns an unlisten function. A subscription
     * is automatically released on disconnect/dispose.
     */
    subscribeForConnection(connectionId, ownerId, listener) {
      const sub = connectionSubscriptions.get(connectionId) ?? {
        owners: new Set<string>(),
        listeners: new Set<(event: HostManagementEvent) => void>(),
      }
      sub.owners.add(ownerId)
      sub.listeners.add(listener)
      connectionSubscriptions.set(connectionId, sub)
      // Also register with the global dispatcher so emit() reaches this
      // listener without needing a separate global subscribe() call. The
      // per-connection entry above is the gate that authorizes start.
      listeners.add(listener)
      return () => {
        const current = connectionSubscriptions.get(connectionId)
        if (current) {
          current.owners.delete(ownerId)
          current.listeners.delete(listener)
          if (current.owners.size === 0 && current.listeners.size === 0) {
            connectionSubscriptions.delete(connectionId)
          }
        }
        listeners.delete(listener)
      }
    },

    getClient(connectionId: string) {
      const session = sessions.get(connectionId)
      return session?.client ?? null
    },

    getInternalsForOwner(connectionId, ownerId) {
      const session = sessions.get(connectionId)
      if (!session || !session.client) return null
      if (session.ownerId !== ownerId) return null
      return {
        session,
        client: session.client,
        generation: session.generation,
        ownerId: session.ownerId,
      }
    },

    getSession(connectionId: string) {
      const session = sessions.get(connectionId)
      if (!session) return null
      return {
        connectionId: session.connectionId,
        generation: session.generation,
        hostId: session.hostId,
        status: session.status,
        cols: session.cols,
        rows: session.rows,
      }
    },

    async createConnection(input) {
      const { hostId, expectedRevision, cols = 80, rows = 24, ownerId } = input

      if (countOwnerSessions(ownerId) >= maxConnectionsPerOwner) {
        throw new Error('Connection limit exceeded for window')
      }

      const loaded = await store.load()
      if (loaded.status !== 'ready') {
        throw new Error(`Storage not ready: ${loaded.status}`)
      }

      const host = loaded.document.hosts.find((h) => h.id === hostId)
      if (!host) {
        throw new Error(`Host not found: ${hostId}`)
      }

      if (expectedRevision !== undefined && host.revision !== expectedRevision) {
        throw new Error(`REVISION_CONFLICT: expected ${expectedRevision}, actual ${host.revision}`)
      }

      const connectionId = crypto.randomUUID()
      const session: SshSession = {
        connectionId,
        generation: 1,
        ownerId,
        hostId,
        status: 'allocated',
        cols: Math.max(2, Math.min(500, cols)),
        rows: Math.max(1, Math.min(300, rows)),
        client: null,
        channel: null,
        unackedBytes: 0,
        isPaused: false,
        seq: 0,
        pendingChallenge: null,
        createdAt: new Date().toISOString(),
      }

      sessions.set(connectionId, session)
      return { connectionId, generation: 1 }
    },

    async startConnection(input) {
      const { connectionId, ownerId } = input
      const session = sessions.get(connectionId)
      if (!session) {
        throw new Error(`Connection not found: ${connectionId}`)
      }

      if (session.ownerId !== ownerId) {
        throw new Error('UNAUTHORIZED_OWNER')
      }

      // The calling owner must have explicitly subscribed to this connection.
      // A global listener is not sufficient: any other BrowserWindow could
      // have added one and that listener must not authorize a foreign start.
      const sub = connectionSubscriptions.get(connectionId)
      if (!sub || !sub.owners.has(ownerId)) {
        throw new Error('Subscriber must be registered for this connection before startConnection')
      }

      if (session.status === 'connecting' || session.status === 'awaiting_host_key' || session.status === 'ready' || session.status === 'authenticating') {
        return
      }

      if (session.status === 'disconnected' || session.status === 'failed') {
        session.generation += 1
      }

      cleanupSession(session)
      session.unackedBytes = 0
      session.isPaused = false
      session.seq = 0

      const currentGen = session.generation
      updateStatus(session, 'connecting')

      const loaded = await store.load()
      if (loaded.status !== 'ready') {
        updateStatus(session, 'failed', `STORAGE_UNAVAILABLE: ${loaded.status}`)
        return
      }

      const host = loaded.document.hosts.find((h) => h.id === session.hostId)
      if (!host) {
        updateStatus(session, 'failed', 'HOST_NOT_FOUND')
        return
      }

      let password: string | undefined
      let privateKey: string | Buffer | undefined
      let passphrase: string | undefined

      const tempCred = resolveTemporaryCredential?.({ ownerId, hostId: host.id })
      if (tempCred) {
        if (tempCred.password) password = tempCred.password
        if (tempCred.privateKeyPem) privateKey = tempCred.privateKeyPem
        if (tempCred.passphrase) passphrase = tempCred.passphrase
      }

      if (!password && !privateKey && host.auth.credentialId && vault) {
        const credRecord = loaded.document.credentials.find((c) => c.id === host.auth.credentialId)
        if (credRecord) {
          const decrypted = vault.decrypt(credRecord)
          if (decrypted.status === 'decrypted') {
            if ('password' in decrypted.payload) {
              password = decrypted.payload.password
            } else if ('privateKeyPem' in decrypted.payload) {
              privateKey = decrypted.payload.privateKeyPem
              passphrase = decrypted.payload.passphrase
            }
          }
        }
      }

      const client = new SshClient()
      session.client = client

      const endpoint = knownHosts.canonicalizeEndpoint(host.address, host.port)

      client.on('error', (err: any) => {
        if (session.generation !== currentGen || session.status === 'closed') return
        // Host verification deliberately drives ssh2's callback with `false`
        // for changed/rejected/timed-out keys. ssh2 then emits the generic
        // "Host denied (verification failed)" error synchronously. Preserve the
        // semantic HOST_KEY_* state that was already emitted instead of
        // replacing it with that implementation detail.
        if (session.status === 'failed') {
          cleanupSession(session)
          return
        }
        const errMsg = err?.message || 'SSH_ERROR'
        updateStatus(session, 'failed', errMsg)
        cleanupSession(session)
      })

      client.on('close', () => {
        if (session.generation !== currentGen) return
        if (session.status === 'closing') {
          updateStatus(session, 'closed')
        } else if (session.status !== 'closed' && session.status !== 'failed') {
          updateStatus(session, 'disconnected')
        }
        cleanupSession(session)
      })

      client.on('end', () => {
        if (session.generation !== currentGen) return
        if (session.status === 'closing') {
          updateStatus(session, 'closed')
        } else if (session.status !== 'closed' && session.status !== 'failed') {
          updateStatus(session, 'disconnected')
        }
        cleanupSession(session)
      })

      client.on('banner', (message: string) => {
        if (session.generation !== currentGen || !message) return
        handleOutput(session, Buffer.from(message.replace(/\r?\n/g, '\r\n'), 'utf-8'), currentGen)
      })

      client.on('greeting', (greeting: string) => {
        if (session.generation !== currentGen || !greeting) return
        handleOutput(session, Buffer.from(greeting.replace(/\r?\n/g, '\r\n'), 'utf-8'), currentGen)
      })

      client.on('ready', () => {
        if (session.generation !== currentGen || session.status === 'closed' || session.status === 'closing') {
          client.end()
          return
        }

        client.shell(
          {
            term: 'xterm-256color',
            cols: session.cols,
            rows: session.rows,
          },
          (err, channel) => {
            if (err) {
              updateStatus(session, 'failed', err.message)
              cleanupSession(session)
              return
            }

            session.channel = channel
            updateStatus(session, 'ready')

            channel.on('data', (data: Buffer) => {
              handleOutput(session, data, currentGen)
            })

            if (channel.stderr) {
              channel.stderr.on('data', (data: Buffer) => {
                handleOutput(session, data, currentGen)
              })
            }

            channel.on('close', () => {
              if (session.generation !== currentGen) return
              if (session.status === 'closing') {
                updateStatus(session, 'closed')
              } else if (session.status === 'ready') {
                updateStatus(session, 'disconnected')
              }
              cleanupSession(session)
            })
          },
        )
      })

      const connectConfig: any = {
        host: host.address,
        port: host.port,
        username: host.username,
        readyTimeout: effectiveReadyTimeoutMs,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer, verify: (result: boolean) => void) => {
          if (session.generation !== currentGen || session.status === 'closed') {
            verify(false)
            return
          }

          let algorithm = 'ssh-rsa'
          try {
            const algoLen = key.readUInt32BE(0)
            if (algoLen > 0 && algoLen < 100) {
              algorithm = key.subarray(4, 4 + algoLen).toString('utf-8')
            }
          } catch {}

          const sha256 = crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')

          void (async () => {
            try {
              const checkResult = await knownHosts.verifyHostKey(endpoint, algorithm, sha256)
              if (session.generation !== currentGen || session.status === 'closed') {
                verify(false)
                return
              }

              if (checkResult === 'trusted') {
                updateStatus(session, 'authenticating')
                verify(true)
                return
              }

              if (checkResult === 'changed') {
                const existing = await knownHosts.getKnownKey(endpoint, algorithm)
                emit({
                  type: 'connection-host-key-changed',
                  connectionId: session.connectionId,
                  generation: session.generation,
                  endpoint,
                  algorithm,
                  oldFingerprint: existing?.sha256 || '',
                  newFingerprint: sha256,
                })
                updateStatus(session, 'failed', 'HOST_KEY_CHANGED')
                verify(false)
                cleanupSession(session)
                return
              }

              // Status is 'unknown': prompt challenge
              const challengeId = crypto.randomUUID()
              const challenge: SshHostKeyChallenge = {
                challengeId,
                endpoint,
                algorithm,
                fingerprint: sha256,
              }

              const timer = setTimeout(() => {
                if (session.pendingChallenge?.challengeId === challengeId) {
                  session.pendingChallenge = null
                  // Publish the semantic reason first. verify(false) causes
                  // ssh2 to synchronously emit a generic handshake error.
                  updateStatus(session, 'failed', 'HOST_KEY_TIMEOUT')
                  verify(false)
                  cleanupSession(session)
                }
              }, normalizedHostKeyChallengeTimeoutMs)

              session.pendingChallenge = {
                challengeId,
                endpoint,
                algorithm,
                sha256,
                verifyCallback: verify,
                timer,
              }

              updateStatus(session, 'awaiting_host_key', undefined, challenge)
            } catch (err) {
              updateStatus(session, 'failed', 'HOST_VERIFICATION_ERROR')
              verify(false)
              cleanupSession(session)
            }
          })()
        },
      }

      if (password) {
        connectConfig.password = password
      }
      if (privateKey) {
        connectConfig.privateKey = privateKey
        if (passphrase) connectConfig.passphrase = passphrase
      }

      try {
        client.connect(connectConfig)
      } catch (err: any) {
        updateStatus(session, 'failed', err.message || 'CONNECT_FAILED')
        cleanupSession(session)
      }
    },

    async answerHostKey(input) {
      const { connectionId, challengeId, decision, ownerId } = input
      const session = sessions.get(connectionId)
      if (!session) {
        throw new Error(`Connection not found: ${connectionId}`)
      }
      if (session.ownerId !== ownerId) {
        throw new Error('UNAUTHORIZED_OWNER')
      }

      const challenge = session.pendingChallenge
      if (!challenge || challenge.challengeId !== challengeId) {
        throw new Error('NO_PENDING_CHALLENGE')
      }

      clearTimeout(challenge.timer)

      if (decision === 'trust') {
        try {
          // Persist before releasing the KEX gate. A reconnect after a later
          // transport failure must see exactly the key the user approved.
          await knownHosts.trustHostKey(challenge.endpoint, challenge.algorithm, challenge.sha256)
        } catch {
          session.pendingChallenge = null
          updateStatus(session, 'failed', 'HOST_KEY_TRUST_FAILED')
          challenge.verifyCallback(false)
          cleanupSession(session)
          return
        }
        session.pendingChallenge = null
        updateStatus(session, 'authenticating')
        challenge.verifyCallback(true)
      } else {
        session.pendingChallenge = null
        updateStatus(session, 'failed', 'HOST_KEY_REJECTED')
        challenge.verifyCallback(false)
        cleanupSession(session)
      }
    },

    async write(input) {
      const { connectionId, generation, data, isBase64, ownerId } = input
      const session = sessions.get(connectionId)
      if (!session) {
        throw new Error(`Connection not found: ${connectionId}`)
      }
      if (session.ownerId !== ownerId) {
        throw new Error('UNAUTHORIZED_OWNER')
      }
      if (session.generation !== generation) {
        throw new Error('STALE_GENERATION')
      }
      if (session.status !== 'ready' || !session.channel) {
        throw new Error('CHANNEL_NOT_READY')
      }

      const buffer = isBase64 ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf-8')
      session.channel.write(buffer)
    },

    async resize(input) {
      const { connectionId, generation, cols, rows, ownerId } = input
      const session = sessions.get(connectionId)
      if (!session) {
        throw new Error(`Connection not found: ${connectionId}`)
      }
      if (session.ownerId !== ownerId) {
        throw new Error('UNAUTHORIZED_OWNER')
      }
      if (session.generation !== generation) {
        throw new Error('STALE_GENERATION')
      }

      session.cols = Math.max(2, Math.min(500, cols))
      session.rows = Math.max(1, Math.min(300, rows))

      if (session.channel && session.status === 'ready') {
        try {
          session.channel.setWindow(session.rows, session.cols, 0, 0)
        } catch {}
      }
    },

    async ackOutput(input) {
      const { connectionId, generation, bytesAcked, ownerId } = input
      const session = sessions.get(connectionId)
      if (!session) {
        return
      }
      if (session.ownerId !== ownerId || session.generation !== generation) {
        return
      }

      session.unackedBytes = Math.max(0, session.unackedBytes - bytesAcked)

      if (session.isPaused && session.unackedBytes < lowWatermarkBytes) {
        session.isPaused = false
        try {
          session.channel?.resume()
        } catch {}
      }
    },

    async disconnect(input) {
      const { connectionId, ownerId } = input
      const session = sessions.get(connectionId)
      if (!session) {
        return
      }
      if (session.ownerId !== ownerId) {
        throw new Error('UNAUTHORIZED_OWNER')
      }

      session.status = 'closing'
      emit({
        type: 'connection-state',
        connectionId: session.connectionId,
        generation: session.generation,
        status: 'closing',
      })

      cleanupSession(session)
      // Release per-connection subscription so a future start must re-bind.
      // The renderer is responsible for re-subscribing after reconnect, so we
      // don't keep stale authorization around across generations.
      connectionSubscriptions.delete(connectionId)
      updateStatus(session, 'closed')
    },

    async dispose() {
      for (const session of sessions.values()) {
        cleanupSession(session)
        session.status = 'closed'
      }
      sessions.clear()
      listeners.clear()
      connectionSubscriptions.clear()
    },
  }
}
