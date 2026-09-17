import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Server as SshServer } from 'ssh2'
import { createKnownHostsService } from './knownHosts.js'
import { createResourceDocumentStore } from './repositories/resourceDocumentStore.js'
import { createResourceLibraryService } from './repositories/resourceLibraryService.js'
import { createSshSessionService } from './sshSessionService.js'
import { createSftpService, createTransferService, createRemoteEditService, createLocalPathService } from './sftpService.js'
import { createCredentialVault, createTemporaryCredentialStore } from './vault/credentialVault.js'
import {
  registerManagedResourcesIpc,
  type ManagedResourcesServices,
} from './registerIpc.js'

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText: string) => Buffer.from(`sealed:${plainText}`, 'utf8'),
  decryptString: (cipherText: Buffer) => {
    const s = cipherText.toString('utf8')
    if (!s.startsWith('sealed:')) throw new Error('bad ciphertext')
    return s.slice('sealed:'.length)
  },
}

function buildServices(activeConfigDir: string): ManagedResourcesServices {
  const store = createResourceDocumentStore({ activeConfigDir })
  const libService = createResourceLibraryService({ store })
  const vault = createCredentialVault({ safeStorage: fakeSafeStorage })
  const knownHosts = createKnownHostsService(store)
  const temporaryCredentials = createTemporaryCredentialStore()
  const sshService = createSshSessionService({
    store,
    knownHosts,
    vault,
    resolveTemporaryCredential: () => ({ password: 'goodpass' }),
  })
  return {
    store,
    libService,
    vault,
    credentialService: {} as never,
    selectionsRepo: {} as never,
    temporaryCredentials,
    knownHosts,
    sshService,
    sftpService: createSftpService({ resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') }, tempDir: activeConfigDir }),
    localPathService: createLocalPathService({ userDataDir: activeConfigDir }),
    transferService: createTransferService({
      resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') },
      sftpService: createSftpService({ resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') }, tempDir: activeConfigDir }),
      localPathService: createLocalPathService({ userDataDir: activeConfigDir }),
    }),
    remoteEditService: createRemoteEditService({
      resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') },
      sftpService: createSftpService({ resolveSession: () => { throw new Error('SFTP_UNAVAILABLE') }, tempDir: activeConfigDir }),
      localPathService: createLocalPathService({ userDataDir: activeConfigDir }),
    }),
    dispose() {
      void sshService.dispose().catch(() => undefined)
      temporaryCredentials.dispose()
    },
  }
}

describe('M3 SSH Cross-Layer Join: DesktopHost/IPC Handler → sshService → loopback ssh2.Server', () => {
  let server: SshServer
  let serverPort: number
  let serverFingerprint = ''
  let tempDir: string
  let services: ManagedResourcesServices
  let unregister: () => void
  let testHostId: string
  let handlers: Map<string, (event: any, payload: any) => Promise<any>>
  let fakeMainWindow: any
  let fakeIpcMain: any
  let fakeSender: any
  let ownerId: string
  const serverClients = new Set<any>()

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-ipc-join-'))
    const pair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    })
    serverFingerprint = crypto
      .createHash('sha256')
      .update(pair.publicKey)
      .digest('base64')
      .replace(/=+$/, '')

    server = new SshServer(
      { hostKeys: [pair.privateKey] },
      (client) => {
        serverClients.add(client)
        client.on('error', () => {})
        client.on('close', () => serverClients.delete(client))
        client.on('end', () => serverClients.delete(client))
        client
          .on('authentication', (ctx) => {
            if (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'goodpass') {
              ctx.accept()
            } else {
              ctx.reject(['password'])
            }
          })
          .on('ready', () => {
            client.on('session', (accept) => {
              const session = accept()
              session.on('shell', (acceptShell) => {
                const stream = acceptShell()
                stream.write('Welcome to Loopback SSH M3\r\n')
                stream.on('data', (data: Buffer) => {
                  const text = data.toString('utf-8')
                  if (text === 'ping') stream.write('pong\r\n')
                  if (text === 'close') client.end()
                })
              })
            })
          })
      },
    )

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (typeof address === 'object' && address) serverPort = address.port
        resolve()
      })
    })

    services = buildServices(tempDir)
    await services.knownHosts.trustHostKey(`127.0.0.1:${serverPort}`, 'ssh-rsa', serverFingerprint)

    // Seed a host record in the document store so createConnection can resolve it.
    const hostRes = await services.libService.createHost({
      name: 'Loopback M3',
      address: '127.0.0.1',
      port: serverPort,
      username: 'tester',
      auth: { type: 'password', credentialId: null },
      tagIds: [],
      initialDirectory: null,
      applications: [],
      notes: '',
    })
    if (hostRes.status !== 'created') throw new Error('host seed failed')
    testHostId = hostRes.value.id

    handlers = new Map()
    fakeIpcMain = {
      handle(channel: string, handler: any) {
        handlers.set(channel, handler)
      },
      removeHandler(channel: string) {
        handlers.delete(channel)
      },
    }
    fakeMainWindow = {
      id: 1,
      isDestroyed: () => false,
      webContents: { id: 11, isDestroyed: () => false, send: () => {} },
    }
    ownerId = `window:${fakeMainWindow.id}`
    fakeSender = {
      sender: fakeMainWindow.webContents,
      senderFrame: { id: 1 },
    } as any
    unregister = registerManagedResourcesIpc({
      ipcMain: fakeIpcMain,
      getMainWindow: () => fakeMainWindow,
      services,
      expectedOwnerId: ownerId,
    })
  })

  afterAll(async () => {
    unregister()
    await services.sshService.dispose()
    for (const client of serverClients) {
      try { client.destroy() } catch {}
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

  it('startConnection drops a foreign ownerId in payload and uses the canonical owner (F29-02)', async () => {
    const handler = handlers.get('desktop:managed-resources:create-connection')!
    const created = await handler(fakeSender, {
      hostId: testHostId,
      cols: 80,
      rows: 24,
    })
    if (!created.ok) console.error('create debug:', JSON.stringify(created), 'msg:', created.error?.params)
    expect(created.ok).toBe(true)
    const { connectionId } = created.data

    const start = handlers.get('desktop:managed-resources:start-connection')!
    // F29-02: payload.ownerId is untrusted; the handler resolves the
    // canonical owner from the mainWindow and overrides. The foreign value
    // is dropped silently; the request proceeds with the owner that owns
    // the connection. This test asserts the new behavior: ok=true (the
    // service may later report a connection-level error such as AUTH or
    // DISCONNECTED, but the IPC layer no longer rejects on payload
    // ownerId).
    const foreign = await start(fakeSender, { connectionId, ownerId: 'foreign-window' })
    expect(foreign.ok).toBe(true)
  })

  it('runs allocate → subscribe → start → disconnect through IPC (happy wiring)', async () => {
    const create = handlers.get('desktop:managed-resources:create-connection')!
    const start = handlers.get('desktop:managed-resources:start-connection')!
    const disconnect = handlers.get('desktop:managed-resources:disconnect')!

    const created = await create(fakeSender, {
      hostId: testHostId,
      cols: 80,
      rows: 24,
    })
    expect(created.ok).toBe(true)
    const { connectionId } = created.data

    const startRes = await start(fakeSender, { connectionId, ownerId })
    expect(startRes.ok).toBe(true)

    // Allow time for connect + auth before disconnecting.
    await new Promise(r => setTimeout(r, 500))

    const disconnectRes = await disconnect(fakeSender, { connectionId, ownerId })
    expect(disconnectRes.ok).toBe(true)
  })

  it('rejects overlong write payloads through IPC', async () => {
    const create = handlers.get('desktop:managed-resources:create-connection')!
    const start = handlers.get('desktop:managed-resources:start-connection')!
    const write = handlers.get('desktop:managed-resources:write-connection')!

    const created = await create(fakeSender, { hostId: testHostId, cols: 80, rows: 24 })
    const { connectionId } = created.data
    await start(fakeSender, { connectionId, ownerId })

    const huge = 'A'.repeat(70 * 1024)
    const bad = await write(fakeSender, { connectionId, generation: 1, data: huge })
    expect(bad.ok).toBe(false)
    // Validator must reject at IPC layer; payload is too long for base64-encoded raw.
    expect(bad.error?.code).toBe('INTERNAL_ERROR')
  })
})