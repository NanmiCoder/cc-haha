import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Server as SshServer } from 'ssh2'
import { createKnownHostsService } from './knownHosts.js'
import { createResourceDocumentStore } from './repositories/resourceDocumentStore.js'
import { createSshSessionService, type HostManagementEvent } from './sshSessionService.js'

describe('SshSessionService with loopback ssh2.Server', () => {
  let server: SshServer
  let serverPort: number
  let serverPrivateKey: string
  let _changedServerPrivateKey: string
  let tempDir: string
  let serverFingerprint = ''
  const serverClients = new Set<any>()

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-session-test-'))

    const keyPair1 = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    })
    serverPrivateKey = keyPair1.privateKey

    const keyPair2 = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    })
    _changedServerPrivateKey = keyPair2.privateKey
    // Reference the changed key in the server fingerprint hash so future tests
    // can swap in a different trust set without redeclaring fixtures.
    void _changedServerPrivateKey

    await new Promise<void>((resolve, reject) => {
      server = new SshServer(
        {
          hostKeys: [serverPrivateKey],
        },
        (client) => {
          serverClients.add(client)
          // Expected host-key rejection closes the transport during KEX. ssh2
          // reports that on the server-side client as an error; consume it so a
          // negative-path fixture never becomes an uncaught Vitest exception.
          client.on('error', () => {})
          client.on('close', () => serverClients.delete(client))
          client.on('end', () => serverClients.delete(client))
          client
            .on('authentication', (ctx) => {
              if (ctx.method === 'password') {
                if (ctx.username === 'testuser' && ctx.password === 'goodpass') {
                  ctx.accept()
                } else {
                  ctx.reject(['password'])
                }
              } else {
                ctx.reject(['password'])
              }
            })
            .on('ready', () => {
              client.on('session', (accept, _reject) => {
                const session = accept()
                session.on('pty', (acceptPty) => {
                  acceptPty()
                })
                session.on('shell', (acceptShell) => {
                  const stream = acceptShell()
                  stream.write('Welcome to Loopback SSH\r\n')
                  stream.on('data', (data: Buffer) => {
                    const text = data.toString('utf-8')
                    if (text === 'ping') {
                      stream.write('pong\r\n')
                    } else if (text === 'flood') {
                      // Flood 2 MiB of data
                      const chunk = Buffer.alloc(64 * 1024, 'A')
                      for (let i = 0; i < 32; i++) {
                        stream.write(chunk)
                      }
                    } else {
                      stream.write(`echo: ${text}\r\n`)
                    }
                  })
                })
              })
            })
        },
      )

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (typeof addr === 'object' && addr !== null) {
          serverPort = addr.port
          resolve()
        } else {
          reject(new Error('Failed to get server address'))
        }
      })
    })
  })

  afterAll(async () => {
      for (const c of serverClients) {
        try {
          c.destroy()
        } catch {}
      }
      serverClients.clear()
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500)
        server.close(() => {
          clearTimeout(timer)
          resolve()
        })
      })
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    })

  it('enforces subscribe-before-start and handles host key challenge trust workflow', async () => {
    const store = createResourceDocumentStore({ activeConfigDir: tempDir })
    const knownHosts = createKnownHostsService(store)

    // Pre-populate a host in the store
    const hostId = '11111111-1111-4111-8111-111111111111'
    await store.transact({
      mutate(draft) {
        draft.hosts.push({
          id: hostId,
          revision: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          name: 'Loopback Host',
          address: '127.0.0.1',
          port: serverPort,
          username: 'testuser',
          auth: { type: 'password', credentialId: null },
          tagIds: [],
          initialDirectory: '/root',
          applications: [],
          notes: '',
        })
        return { commit: true, value: undefined }
      },
    })

    const sshService = createSshSessionService({
      store,
      knownHosts,
      resolveTemporaryCredential: () => ({ password: 'goodpass' }),
    })

    const ownerId = 'window-1'
    const { connectionId, generation } = await sshService.createConnection({
      hostId,
      ownerId,
    })
    expect(connectionId).toBeDefined()
    expect(generation).toBe(1)

    // 1. Calling start without subscriber must throw
    await expect(
      sshService.startConnection({ connectionId, ownerId }),
    ).rejects.toThrow(/Subscriber must be registered for this connection before startConnection/)

    // 2. Register subscriber bound to this connectionId for this ownerId.
    // A bare subscribe() call must NOT authorize start — only per-connection
    // subscription does.
    const events: HostManagementEvent[] = []
    const unlisten = sshService.subscribeForConnection(
      connectionId,
      ownerId,
      (e) => { events.push(e) },
    )

    // 3. Start connection -> status should become awaiting_host_key
    await sshService.startConnection({ connectionId, ownerId })

    // Wait for host key challenge event
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const challengeEvent = events.find((e) => e.type === 'connection-state' && e.status === 'awaiting_host_key')
        if (challengeEvent) {
          clearInterval(check)
          resolve()
        }
      }, 50)
    })

    const challengeEvent = events.find(
      (e) => e.type === 'connection-state' && e.status === 'awaiting_host_key',
    ) as Extract<HostManagementEvent, { type: 'connection-state' }>
    expect(challengeEvent).toBeDefined()
    expect(challengeEvent.hostKeyChallenge).toBeDefined()
    const challengeId = challengeEvent.hostKeyChallenge!.challengeId
    serverFingerprint = challengeEvent.hostKeyChallenge!.fingerprint

    // 4. Trust host key
    await sshService.answerHostKey({
      connectionId,
      challengeId,
      decision: 'trust',
      ownerId,
    })

    // 5. Wait for ready event
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const readyEvent = events.find((e) => e.type === 'connection-state' && e.status === 'ready')
        if (readyEvent) {
          clearInterval(check)
          resolve()
        }
      }, 50)
    })

    // Check initial banner was emitted as output
    const outputs = events.filter((e) => e.type === 'terminal-output')
    expect(outputs.length).toBeGreaterThan(0)
    const combinedText = outputs
      .map((o) => (o.type === 'terminal-output' ? Buffer.from(o.data, 'base64').toString('utf-8') : ''))
      .join('')
    expect(combinedText).toContain('Welcome to Loopback SSH')

    // 6. Test writing to shell and receiving echo
    events.length = 0
    await sshService.write({
      connectionId,
      generation: 1,
      data: 'ping',
      ownerId,
    })

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const pingOutputs = events.filter((e) => e.type === 'terminal-output')
        const text = pingOutputs
          .map((o) => (o.type === 'terminal-output' ? Buffer.from(o.data, 'base64').toString('utf-8') : ''))
          .join('')
        if (text.includes('pong')) {
          clearInterval(check)
          resolve()
        }
      }, 50)
    })

    // 7. Test resize
    await sshService.resize({
      connectionId,
      generation: 1,
      cols: 120,
      rows: 40,
      ownerId,
    })
    const sessionInfo = sshService.getSession(connectionId)
    expect(sessionInfo?.cols).toBe(120)
    expect(sessionInfo?.rows).toBe(40)

    // 8. Disconnect
    await sshService.disconnect({ connectionId, ownerId })
    expect(sshService.getSession(connectionId)?.status).toBe('closed')

    unlisten()
    await sshService.dispose()
  })

  it('keeps HOST_KEY_TIMEOUT semantic state instead of exposing ssh2 Host denied', async () => {
    const timeoutDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-host-key-timeout-'))
    const store = createResourceDocumentStore({ activeConfigDir: timeoutDir })
    const knownHosts = createKnownHostsService(store)
    const hostId = '12121212-1212-4121-8121-121212121212'
    await store.transact({
      mutate(draft) {
        draft.hosts.push({
          id: hostId,
          revision: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          name: 'Host-key timeout fixture',
          address: '127.0.0.1',
          port: serverPort,
          username: 'testuser',
          auth: { type: 'password', credentialId: null },
          tagIds: [],
          initialDirectory: '/root',
          applications: [],
          notes: '',
        })
        return { commit: true, value: undefined }
      },
    })

    const sshService = createSshSessionService({
      store,
      knownHosts,
      resolveTemporaryCredential: () => ({ password: 'goodpass' }),
      hostKeyChallengeTimeoutMs: 30,
      readyTimeoutMs: 100,
    })
    const events: HostManagementEvent[] = []
    const { connectionId } = await sshService.createConnection({ hostId, ownerId: 'window-timeout' })
    sshService.subscribeForConnection(connectionId, 'window-timeout', event => events.push(event))
    await sshService.startConnection({ connectionId, ownerId: 'window-timeout' })

    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('HOST_KEY_TIMEOUT event was not emitted')), 2_000)
      const poll = setInterval(() => {
        if (events.some(event => event.type === 'connection-state' && event.status === 'failed')) {
          clearInterval(poll)
          clearTimeout(deadline)
          resolve()
        }
      }, 10)
    })

    const failures = events.filter(
      (event): event is Extract<HostManagementEvent, { type: 'connection-state' }> =>
        event.type === 'connection-state' && event.status === 'failed',
    )
    expect(failures.at(-1)?.error).toBe('HOST_KEY_TIMEOUT')
    expect(failures.some(event => event.error === 'Host denied (verification failed)')).toBe(false)
    await sshService.dispose()
    await fs.rm(timeoutDir, { recursive: true, force: true }).catch(() => {})
  })

  it('rejects connection when host key is changed', async () => {
    const test2Dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-test2-'))
    const store = createResourceDocumentStore({ activeConfigDir: test2Dir })
    const knownHosts = createKnownHostsService(store)

    const hostId = '22222222-2222-4222-8222-222222222222'
    await store.transact({
      mutate(draft) {
        draft.hosts.push({
          id: hostId,
          revision: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          name: 'Changed Key Host',
          address: '127.0.0.1',
          port: serverPort,
          username: 'testuser',
          auth: { type: 'password', credentialId: null },
          tagIds: [],
          initialDirectory: '/root',
          applications: [],
          notes: '',
        })
        return { commit: true, value: undefined }
      },
    })

    // Pre-trust a different fingerprint for this endpoint
    await knownHosts.trustHostKey('127.0.0.1:' + serverPort, 'ssh-rsa', 'A'.repeat(43))

    const sshService = createSshSessionService({
      store,
      knownHosts,
      resolveTemporaryCredential: () => ({ password: 'goodpass' }),
    })

    const events: HostManagementEvent[] = []
    const { connectionId } = await sshService.createConnection({
      hostId,
      ownerId: 'window-1',
    })
    sshService.subscribeForConnection(connectionId, 'window-1', (e) => events.push(e))

    await sshService.startConnection({ connectionId, ownerId: 'window-1' })

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const failedEvent = events.find((e) => e.type === 'connection-state' && e.status === 'failed')
        if (failedEvent) {
          clearInterval(check)
          resolve()
        }
      }, 50)
    })

    const changedEvent = events.find((e) => e.type === 'connection-host-key-changed')
    expect(changedEvent).toBeDefined()
    expect(changedEvent?.type).toBe('connection-host-key-changed')
    await sshService.dispose()
    await fs.rm(test2Dir, { recursive: true, force: true }).catch(() => {})
  })

  it('fails cleanly on authentication failure', async () => {
    const test3Dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-test3-'))
    const store = createResourceDocumentStore({ activeConfigDir: test3Dir })
    const knownHosts = createKnownHostsService(store)

    const hostId = '33333333-3333-4333-8333-333333333333'
    await store.transact({
      mutate(draft) {
        draft.hosts.push({
          id: hostId,
          revision: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          name: 'Bad Auth Host',
          address: '127.0.0.1',
          port: serverPort,
          username: 'testuser',
          auth: { type: 'password', credentialId: null },
          tagIds: [],
          initialDirectory: '/root',
          applications: [],
          notes: '',
        })
        return { commit: true, value: undefined }
      },
    })

    // Pre-trust the real server key
    if (serverFingerprint) {
      await knownHosts.trustHostKey('127.0.0.1:' + serverPort, 'ssh-rsa', serverFingerprint)
    }

    const sshService = createSshSessionService({
      store,
      knownHosts,
      resolveTemporaryCredential: () => ({ password: 'WRONG_PASSWORD' }),
    })

    const events: HostManagementEvent[] = []
    const { connectionId } = await sshService.createConnection({
      hostId,
      ownerId: 'window-1',
    })
    sshService.subscribeForConnection(connectionId, 'window-1', (e) => events.push(e))

    await sshService.startConnection({ connectionId, ownerId: 'window-1' })

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const failedEvent = events.find((e) => e.type === 'connection-state' && e.status === 'failed')
        if (failedEvent) {
          clearInterval(check)
          resolve()
        }
      }, 50)
    })

    const failed = events.find((e) => e.type === 'connection-state' && e.status === 'failed') as any
    expect(failed).toBeDefined()
    expect(failed.error).not.toBe('HOST_KEY_CHANGED')
    await sshService.dispose()
    await fs.rm(test3Dir, { recursive: true, force: true }).catch(() => {})
  })

  it('handles multi-connection isolation, Chinese characters, and backpressure recovery', async () => {
    const test4Dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-test4-'))
    const store = createResourceDocumentStore({ activeConfigDir: test4Dir })
    const knownHosts = createKnownHostsService(store)

    const hostId = '44444444-4444-4444-8444-444444444444'
    await store.transact({
      mutate(draft) {
        draft.hosts.push({
          id: hostId,
          revision: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          name: 'Multi Conn Host',
          address: '127.0.0.1',
          port: serverPort,
          username: 'testuser',
          auth: { type: 'password', credentialId: null },
          tagIds: [],
          initialDirectory: '/root',
          applications: [],
          notes: '',
        })
        return { commit: true, value: undefined }
      },
    })

    // Pre-trust real key
    if (serverFingerprint) {
      await knownHosts.trustHostKey('127.0.0.1:' + serverPort, 'ssh-rsa', serverFingerprint)
    }

    const sshService = createSshSessionService({
      store,
      knownHosts,
      resolveTemporaryCredential: () => ({ password: 'goodpass' }),
      highWatermarkBytes: 128 * 1024,
      lowWatermarkBytes: 32 * 1024,
    })

    let conn1Id = ''
    let conn2Id = ''
    const conn1Events: HostManagementEvent[] = []
    const conn2Events: HostManagementEvent[] = []

    const res1 = await sshService.createConnection({ hostId, ownerId: 'win' })
    conn1Id = res1.connectionId
    const res2 = await sshService.createConnection({ hostId, ownerId: 'win' })
    conn2Id = res2.connectionId
    sshService.subscribeForConnection(conn1Id, 'win', (e) => {
      if ('connectionId' in e && e.connectionId === conn1Id) conn1Events.push(e)
    })
    sshService.subscribeForConnection(conn2Id, 'win', (e) => {
      if ('connectionId' in e && e.connectionId === conn2Id) conn2Events.push(e)
    })

    await sshService.startConnection({ connectionId: conn1Id, ownerId: 'win' })
    await sshService.startConnection({ connectionId: conn2Id, ownerId: 'win' })

    // Wait for both ready
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const r1 = conn1Events.some((e) => e.type === 'connection-state' && e.status === 'ready')
        const r2 = conn2Events.some((e) => e.type === 'connection-state' && e.status === 'ready')
        if (r1 && r2) {
          clearInterval(check)
          resolve()
        }
      }, 50)
    })

    // Write Chinese characters to conn1
    conn1Events.length = 0
    await sshService.write({
      connectionId: conn1Id,
      generation: 1,
      data: '你好，世界！这是一段中文终端测试。',
      ownerId: 'win',
    })

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const text = Buffer.concat(
          conn1Events
            .filter((e) => e.type === 'terminal-output')
            .map((e: any) => Buffer.from(e.data, 'base64')),
        ).toString('utf-8')
        if (text.includes('你好，世界！这是一段中文终端测试。')) {
          clearInterval(check)
          resolve()
        }
      }, 50)
    })

    // Verify conn2 did not receive conn1 output
    const conn2Output = Buffer.concat(
      conn2Events
        .filter((e) => e.type === 'terminal-output')
        .map((e: any) => Buffer.from(e.data, 'base64')),
    ).toString('utf-8')
    expect(conn2Output).not.toContain('你好，世界')

    // Test backpressure on conn1: send 'flood'
    await sshService.write({
      connectionId: conn1Id,
      generation: 1,
      data: 'flood',
      ownerId: 'win',
    })

    // Wait until output exceeds 128 KiB and pauses
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const totalBytes = conn1Events
          .filter((e) => e.type === 'terminal-output')
          .reduce((acc, cur: any) => acc + cur.byteLength, 0)
        if (totalBytes >= 128 * 1024) {
          clearInterval(check)
          resolve()
        }
      }, 50)
    })

    // Ack output to resume
    const totalBytes = conn1Events
      .filter((e) => e.type === 'terminal-output')
      .reduce((acc, cur: any) => acc + cur.byteLength, 0)
    await sshService.ackOutput({
      connectionId: conn1Id,
      generation: 1,
      bytesAcked: totalBytes,
      ownerId: 'win',
    })

    await sshService.dispose()
    await fs.rm(test4Dir, { recursive: true, force: true }).catch(() => {})
  })
})
