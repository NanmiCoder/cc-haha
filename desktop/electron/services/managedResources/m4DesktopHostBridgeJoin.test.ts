import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ELECTRON_IPC_CHANNELS } from '../../ipc/channels.js'
import { RemoteEditSaveInputSchema } from '../../../src/features/managed-resources/api/hostManagementApi.js'
import { M4_EDIT_TEXT_MAX_BYTES } from '../../../src/features/managed-resources/api/m4IpcContract.js'
import { createElectronHost } from '../../../src/lib/desktopHost/electronHost.js'
import { createLocalPathService, createRemoteEditService, createSftpService, createTransferService } from './sftpService.js'
import {
  MANAGED_RESOURCES_IPC_CHANNELS,
  registerManagedResourcesIpc,
  type ManagedResourcesServices,
} from './registerIpc.js'
import { createFakeSftpTransport, type FakeSftpTransport } from './sftpTestTransport.js'

// ===========================================================================
// 0032 — M4 DesktopHost bridge, end to end
//
// These tests drive the real renderer-side bridge
// (`createElectronHost(...).hostManagement`, which runs the real preload
// capability validator on every payload) into the real
// `registerManagedResourcesIpc` handlers, over the same fake SFTP transport the
// owner-isolation suite uses. Nothing here mocks the host method, the preload
// validator, the channel dispatch or the handlers: a call either crosses all
// three layers and reaches the service, or it fails where the contract says it
// must.
// ===========================================================================

const OWNER_ID = 'window-owner-bridge'
const INVALID_PAYLOAD = 'Invalid Electron IPC payload'

function makeFakeMainWindow(id: number) {
  const mainFrame = { id: id * 10 + 1 }
  const webContents = { id: id * 10 + 2, mainFrame }
  return { id, isDestroyed: () => false, webContents, mainFrame }
}

function makeEvent(window: any) {
  return { sender: window.webContents, senderFrame: window.mainFrame }
}

function makeFakeIpcMain() {
  const handlers = new Map<string, (event: any, payload: any) => Promise<any>>()
  return {
    handlers,
    handle(channel: string, handler: (event: any, payload: any) => Promise<any>) {
      handlers.set(channel, handler)
    },
    removeHandler(channel: string) {
      handlers.delete(channel)
    },
  }
}

function buildServices(tempDir: string, transport: FakeSftpTransport): ManagedResourcesServices {
  const sftpService = createSftpService({ resolveSession: transport.resolveSession, tempDir })
  const localPathService = createLocalPathService({ userDataDir: tempDir })
  return {
    // Only the M4 channels are exercised; the unrelated M2/M3 services are
    // never reached by them (the one M3 mapping check below only needs the
    // handler to answer, not a live session).
    store: { filePath: path.join(tempDir, 'resources.json') } as never,
    libService: {} as never,
    vault: {} as never,
    credentialService: {} as never,
    selectionsRepo: {} as never,
    temporaryCredentials: { dispose: () => undefined } as never,
    knownHosts: {} as never,
    sshService: { dispose: async () => undefined } as never,
    sftpService,
    localPathService,
    transferService: createTransferService({ resolveSession: transport.resolveSession, sftpService, localPathService }),
    remoteEditService: createRemoteEditService({ resolveSession: transport.resolveSession, sftpService, localPathService }),
    dispose() {},
  }
}

describe('0032 — M4 DesktopHost bridge join', () => {
  let tempDir: string
  let transport: FakeSftpTransport
  let services: ManagedResourcesServices
  let ipc: ReturnType<typeof makeFakeIpcMain>
  let window: any
  let event: { sender: any; senderFrame: any }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-m4-bridge-'))
    transport = await createFakeSftpTransport()
    services = buildServices(tempDir, transport)
    window = makeFakeMainWindow(711)
    event = makeEvent(window)
    ipc = makeFakeIpcMain()
    registerManagedResourcesIpc({
      ipcMain: ipc as any,
      getMainWindow: () => window as any,
      services,
      expectedOwnerId: OWNER_ID,
    })
  })

  afterEach(async () => {
    await transport.dispose()
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  })

  /** The DesktopHost the renderer actually gets, wired to the handlers above. */
  function createBridge() {
    const calls: Array<{ channel: string; payload: unknown }> = []
    const host = createElectronHost({
      getPathForFile: () => '',
      async invoke<T>(channel: string, payload?: unknown): Promise<T> {
        calls.push({ channel, payload })
        const handler = ipc.handlers.get(channel)
        if (!handler) throw new Error(`no handler registered for ${channel}`)
        return (await handler(event, payload)) as T
      },
      subscribe: async () => () => undefined,
    })
    return { host, calls }
  }

  it('binds native upload/save dialogs without exposing the selected local path to the renderer', async () => {
    const selectedUpload = path.join(tempDir, 'user-picked-upload.txt')
    const selectedDownload = path.join(tempDir, 'user-picked-download.txt')
    await fs.writeFile(selectedUpload, 'native-upload-payload')
    await transport.seedFile('/home/tester/native-download.txt', 'native-download-payload')

    registerManagedResourcesIpc({
      ipcMain: ipc as any,
      getMainWindow: () => window as any,
      services,
      expectedOwnerId: OWNER_ID,
      dialogService: {
        showOpenDialog: async () => ({ canceled: false, filePaths: [selectedUpload] }),
        showSaveDialog: async () => ({ canceled: false, filePath: selectedDownload }),
      },
    })
    const { host } = createBridge()
    const connectionId = randomUUID()

    const uploadToken = await host.hostManagement.mintUploadToken('renderer-cannot-pick-this-path.txt')
    expect(uploadToken.ok).toBe(true)
    if (!uploadToken.ok) return
    expect(uploadToken.data.absolutePath).not.toBe(selectedUpload)
    expect(JSON.stringify(uploadToken.data)).not.toContain(selectedUpload)
    expect((await fs.readFile(uploadToken.data.absolutePath)).toString('utf8')).toBe('native-upload-payload')

    const uploaded = await host.hostManagement.transferStartUpload(
      randomUUID(), connectionId, 1, '/home/tester/native-upload.txt', uploadToken.data.token,
    )
    expect(uploaded.ok).toBe(true)
    expect((await transport.readFile('/home/tester/native-upload.txt')).toString('utf8')).toBe('native-upload-payload')

    const downloadToken = await host.hostManagement.mintDownloadToken('native-download.txt')
    expect(downloadToken.ok).toBe(true)
    if (!downloadToken.ok) return
    expect(downloadToken.data.absolutePath).not.toBe(selectedDownload)
    expect(JSON.stringify(downloadToken.data)).not.toContain(selectedDownload)

    const downloaded = await host.hostManagement.transferStartDownload(
      randomUUID(), connectionId, 1, '/home/tester/native-download.txt', downloadToken.data.token,
    )
    expect(downloaded.ok).toBe(true)
    expect((await fs.readFile(selectedDownload)).toString('utf8')).toBe('native-download-payload')
    await expect(fs.stat(downloadToken.data.absolutePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('completes a real download through electronHost -> preload validator -> main handler', async () => {
    await transport.seedFile('/home/tester/remote.bin', 'remote-payload')
    const { host } = createBridge()

    const minted = await host.hostManagement.mintDownloadToken('remote.bin')
    expect(minted.ok).toBe(true)
    if (!minted.ok) return

    const jobId = randomUUID()
    const connectionId = randomUUID()
    const job = await host.hostManagement.transferStartDownload(
      jobId,
      connectionId,
      1,
      '/home/tester/remote.bin',
      minted.data.token,
    )

    expect(job.ok).toBe(true)
    if (!job.ok) return
    expect(job.data.id).toBe(jobId)
    expect(job.data.connectionId).toBe(connectionId)
    expect(job.data.state).toBe('completed')
    expect(job.data.checksum).toMatch(/^[0-9a-f]{64}$/)
    // The public transfer DTO carries no owner id and no local path.
    expect(Object.keys(job.data).sort()).toEqual([
      'checksum',
      'connectionId',
      'direction',
      'error',
      'finishedAt',
      'generation',
      'id',
      'remotePath',
      'size',
      'startedAt',
      'state',
      'transferred',
    ])

    expect((await fs.readFile(minted.data.absolutePath)).toString('utf8')).toBe('remote-payload')

    // The published transfer DTO carries no local filesystem path either; the
    // projection is what removes `localPath` (and the owner id) from the value
    // the renderer actually receives.
    expect(JSON.stringify(job.data)).not.toContain(tempDir)
    expect(JSON.stringify(job.data)).not.toContain('managed-resources')
    expect(Object.keys(job.data)).not.toContain('localPath')
    expect(Object.keys(job.data)).not.toContain('ownerId')
  })

  it('ignores a foreign ownerId in the payload: the canonical window owner wins', async () => {
    await transport.seedFile('/home/tester/remote.bin', 'remote-payload')
    const { host } = createBridge()

    const minted = await host.hostManagement.mintDownloadToken('remote.bin')
    expect(minted.ok).toBe(true)
    if (!minted.ok) return

    // The bridge cannot produce this payload (it never sends `ownerId`), so a
    // hostile payload is injected straight into the registered handler to prove
    // the main process ignores it instead of trusting it.
    const jobId = randomUUID()
    const handler = ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.transferStartDownload)
    expect(handler).toBeDefined()
    const injected = await handler!(event, {
      jobId,
      connectionId: randomUUID(),
      generation: 1,
      remotePath: '/home/tester/remote.bin',
      localToken: minted.data.token,
      ownerId: 'attacker-owner',
    })

    // The minted token is bound to the canonical owner, so a transfer that
    // honoured the injected id would have failed as UNAUTHORIZED_OWNER.
    expect(injected.ok).toBe(true)
    expect(injected.data.state).toBe('completed')

    // And the job is owned by that canonical owner: this window can still read
    // it through its own bridge.
    const fetched = await host.hostManagement.transferGet(jobId)
    expect(fetched.ok).toBe(true)
    if (fetched.ok) expect(fetched.data.state).toBe('completed')
  })

  it('rejects a download payload in the preload validator before it can reach the handler', async () => {
    const { host, calls } = createBridge()
    const base = {
      jobId: randomUUID(),
      connectionId: randomUUID(),
      generation: 1,
      remotePath: '/home/tester/remote.bin',
      localToken: randomUUID(),
    }

    const callsBefore = calls.length

    await expect(
      host.hostManagement.transferStartDownload(
        base.jobId,
        base.connectionId,
        base.generation,
        base.remotePath,
        undefined as unknown as string,
      ),
    ).rejects.toThrow(INVALID_PAYLOAD)

    await expect(
      host.hostManagement.transferStartDownload(
        base.jobId,
        base.connectionId,
        base.generation,
        base.remotePath,
        'not-a-uuid',
      ),
    ).rejects.toThrow(INVALID_PAYLOAD)

    // Same rule in the upload direction.
    await expect(
      host.hostManagement.transferStartUpload(
        base.jobId,
        base.connectionId,
        base.generation,
        base.remotePath,
        'not-a-uuid',
      ),
    ).rejects.toThrow(INVALID_PAYLOAD)

    // Nothing crossed the bridge for any of the rejected payloads: the validator
    // is what stopped them, not the handler.
    expect(calls.length).toBe(callsBefore)
    expect(ipc.handlers.has(MANAGED_RESOURCES_IPC_CHANNELS.transferStartDownload)).toBe(true)
  })

  it('never returns the local path bound to a token from resolveLocalToken', async () => {
    const { host, calls } = createBridge()

    const minted = await host.hostManagement.mintDownloadToken('remote.bin')
    expect(minted.ok).toBe(true)
    if (!minted.ok) return

    const resolved = await host.hostManagement.resolveLocalToken(minted.data.token)
    expect(resolved).toEqual({ ok: true, data: { ok: true, token: minted.data.token } })

    // The confirmation must not leak the landing path, the transfer staging
    // directory, the profile temp dir, or anything else from the local disk.
    const serialized = JSON.stringify(resolved)
    expect(serialized).not.toContain(minted.data.absolutePath)
    expect(serialized).not.toContain(tempDir)
    expect(serialized).not.toContain('managed-resources/transfers')
    expect(serialized.toLowerCase()).not.toContain('absolutePath'.toLowerCase())
    expect(serialized).not.toContain(transport.remoteRoot)

    // Only the token crossed the bridge, and it came back unchanged.
    const resolveCall = calls.find(call => call.channel === ELECTRON_IPC_CHANNELS.mrResolveLocalToken)
    expect(resolveCall).toEqual({
      channel: ELECTRON_IPC_CHANNELS.mrResolveLocalToken,
      payload: { token: minted.data.token },
    })
    // The value still round-trips for its owner.
    const confirmed = await host.hostManagement.resolveLocalToken(minted.data.token)
    expect(confirmed.ok).toBe(true)
  })

  it('routes all 13 M4 methods onto their own channel with the exact field set and no ownerId', async () => {
    await transport.seedFile('/home/tester/remote.bin', 'remote-payload')
    await transport.seedFile('/home/tester/notes.txt', 'hello\n')
    const { host, calls } = createBridge()
    const connectionId = randomUUID()

    const downloadToken = await host.hostManagement.mintDownloadToken('remote.bin')
    expect(downloadToken.ok).toBe(true)
    if (!downloadToken.ok) return

    const uploadToken = await host.hostManagement.mintUploadToken('local.bin')
    expect(uploadToken.ok).toBe(true)
    if (!uploadToken.ok) return
    await fs.writeFile(uploadToken.data.absolutePath, 'local-payload')

    const resolve = await host.hostManagement.resolveLocalToken(downloadToken.data.token)
    expect(resolve.ok).toBe(true)

    const list = await host.hostManagement.sftpList(connectionId, 1, '/home/tester')
    expect(list.ok).toBe(true)
    if (list.ok) expect(list.data.entries.map(entry => entry.name).sort()).toEqual(['notes.txt', 'remote.bin'])

    const stat = await host.hostManagement.sftpStat(connectionId, 1, '/home/tester/remote.bin')
    expect(stat.ok).toBe(true)
    if (stat.ok) {
      expect(stat.data.type).toBe('file')
      expect(stat.data.size).toBe(Buffer.byteLength('remote-payload', 'utf8'))
    }

    const download = await host.hostManagement.transferStartDownload(
      randomUUID(),
      connectionId,
      1,
      '/home/tester/remote.bin',
      downloadToken.data.token,
    )
    expect(download.ok).toBe(true)

    const upload = await host.hostManagement.transferStartUpload(
      randomUUID(),
      connectionId,
      1,
      '/home/tester/uploaded.bin',
      uploadToken.data.token,
    )
    expect(upload.ok).toBe(true)
    if (upload.ok) {
      expect((await transport.readFile('/home/tester/uploaded.bin')).toString('utf8')).toBe('local-payload')
    }

    const fetched = await host.hostManagement.transferGet(upload.ok ? upload.data.id : randomUUID())
    expect(fetched.ok).toBe(true)

    const cancelled = await host.hostManagement.transferCancel(fetched.ok ? fetched.data.id : randomUUID())
    expect(cancelled.ok).toBe(true)

    const opened = await host.hostManagement.remoteEditOpen(connectionId, 1, '/home/tester/notes.txt')
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.data.edit.text).toBe('hello\n')

    const saved = await host.hostManagement.remoteEditSave(
      opened.data.edit.id,
      opened.data.edit.baseRevision,
      'hello from the renderer\n',
    )
    expect(saved.ok).toBe(true)

    const closed = await host.hostManagement.remoteEditClose(opened.data.edit.id)
    expect(closed.ok).toBe(true)

    const revoked = await host.hostManagement.revokeLocalToken(downloadToken.data.token)
    expect(revoked.ok).toBe(true)

    const expected: Array<[string, string[]]> = [
      [ELECTRON_IPC_CHANNELS.mrMintDownloadToken, ['fileName']],
      [ELECTRON_IPC_CHANNELS.mrMintUploadToken, ['fileName']],
      [ELECTRON_IPC_CHANNELS.mrResolveLocalToken, ['token']],
      [ELECTRON_IPC_CHANNELS.mrSftpList, ['absolutePath', 'connectionId', 'generation']],
      [ELECTRON_IPC_CHANNELS.mrSftpStat, ['absolutePath', 'connectionId', 'generation']],
      [ELECTRON_IPC_CHANNELS.mrTransferStartDownload, ['connectionId', 'generation', 'jobId', 'localToken', 'remotePath']],
      [ELECTRON_IPC_CHANNELS.mrTransferStartUpload, ['connectionId', 'generation', 'jobId', 'localToken', 'remotePath']],
      [ELECTRON_IPC_CHANNELS.mrTransferGet, ['jobId']],
      [ELECTRON_IPC_CHANNELS.mrTransferCancel, ['jobId']],
      [ELECTRON_IPC_CHANNELS.mrRemoteEditOpen, ['absolutePath', 'connectionId', 'generation']],
      [ELECTRON_IPC_CHANNELS.mrRemoteEditSave, ['baseRevision', 'editId', 'text']],
      [ELECTRON_IPC_CHANNELS.mrRemoteEditClose, ['editId']],
      [ELECTRON_IPC_CHANNELS.mrRevokeLocalToken, ['token']],
    ]

    expect(calls.map(call => call.channel)).toEqual(expected.map(([channel]) => channel))
    calls.forEach((call, index) => {
      const entry = expected[index]
      expect(entry, `no expectation recorded for ${call.channel}`).toBeDefined()
      if (!entry) return
      const [, allowedKeys] = entry
      const keys = Object.keys(call.payload as Record<string, unknown>).sort()
      expect(keys, `${call.channel} payload keys`).toEqual(allowedKeys)
      // The renderer must never try to speak for an owner: the main process
      // binds the canonical owner of the calling window instead.
      expect(keys).not.toContain('ownerId')
    })

    // M3 SSH surface stays mapped after the M4 additions.
    const m3 = await host.hostManagement.createConnection({ hostId: randomUUID() })
    expect('ok' in m3).toBe(true)
    const lastCall = calls.at(-1)
    expect(lastCall?.channel).toBe(ELECTRON_IPC_CHANNELS.mrCreateConnection)
    expect(Object.keys((lastCall?.payload ?? {}) as Record<string, unknown>)).toEqual(['hostId'])
  })

  it('replaces an existing executable file twice while preserving an unrelated draft', async () => {
    const file = '/home/tester/example.sh'
    await transport.seedFile(file, '# original fixture\n')
    await transport.seedFile(file + '.editdraft', 'unrelated draft')
    const { host } = createBridge()
    const connectionId = randomUUID()
    const { sftp } = await services.sftpService.ensureSftp(connectionId, OWNER_ID)
    await new Promise<void>((resolve, reject) => sftp.chmod(file, 0o755, error => error ? reject(error) : resolve()))
    const opened = await host.hostManagement.remoteEditOpen(connectionId, 1, file)
    if (!opened.ok) throw new Error('Fixture open failed')
    const saved = await host.hostManagement.remoteEditSave(opened.data.edit.id, opened.data.edit.baseRevision, '# first fixture\n')
    expect(saved.ok).toBe(true)
    if (!saved.ok) throw new Error(saved.error.code)
    expect(saved.data.metadata.mode & 0o777).toBe(0o755)
    expect((await transport.readFile(file + '.editdraft')).toString()).toBe('unrelated draft')
    const again = await host.hostManagement.remoteEditSave(saved.data.edit.id, saved.data.edit.baseRevision, '# second fixture\n')
    expect(again.ok).toBe(true)
    expect((await transport.readFile(file)).toString()).toBe('# second fixture\n')
  })

  it.each([3, 8, 4])('retains original content and accurately reports SFTP status %s', async code => {
    const file = '/home/tester/preserve.txt'
    await transport.seedFile(file, 'original\n')
    const { host } = createBridge()
    const connectionId = randomUUID()
    const opened = await host.hostManagement.remoteEditOpen(connectionId, 1, file)
    if (!opened.ok) throw new Error('Fixture open failed')
    const { sftp } = await services.sftpService.ensureSftp(connectionId, OWNER_ID)
    sftp.ext_openssh_rename = (_from, _to, callback) => callback(Object.assign(new Error('transport detail'), { code }))
    const result = await host.hostManagement.remoteEditSave(opened.data.edit.id, opened.data.edit.baseRevision, 'edited\n')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('Expected failure')
    expect(result.error.code).toBe(code === 3 ? 'PERMISSION_DENIED' : code === 8 ? 'ATOMIC_REPLACE_UNSUPPORTED' : 'SAVE_REPLACE_FAILED')
    expect(JSON.stringify(result)).not.toContain('transport detail')
    expect((await transport.readFile(file)).toString()).toBe('original\n')
    expect((await host.hostManagement.sftpStat(connectionId, 1, file)).ok).toBe(true)
    expect((await fs.readdir(path.join(transport.remoteRoot, 'home', 'tester'))).sort()).toEqual(['preserve.txt'])
  })

  it('applies the shared 2 MiB UTF-8 text contract to remoteEditSave through the bridge', async () => {
    await transport.seedFile('/home/tester/notes.txt', 'hello\n')
    const { host, calls } = createBridge()
    const connectionId = randomUUID()

    const opened = await host.hostManagement.remoteEditOpen(connectionId, 1, '/home/tester/notes.txt')
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    const { id, baseRevision } = opened.data.edit

    // Exactly at the cap: accepted, and the bytes really land in the file.
    const atCap = 'a'.repeat(M4_EDIT_TEXT_MAX_BYTES)
    const saved = await host.hostManagement.remoteEditSave(id, baseRevision, atCap)
    expect(saved.ok).toBe(true)
    if (saved.ok) expect(saved.data.metadata.size).toBe(M4_EDIT_TEXT_MAX_BYTES)
    expect((await transport.readFile('/home/tester/notes.txt')).length).toBe(M4_EDIT_TEXT_MAX_BYTES)

    // One byte over the cap: stopped by the preload validator, and the main
    // schema rejects the same payload, so neither layer would have taken it.
    const overCap = 'a'.repeat(M4_EDIT_TEXT_MAX_BYTES + 1)
    const callsBefore = calls.length
    await expect(host.hostManagement.remoteEditSave(id, baseRevision, overCap)).rejects.toThrow(INVALID_PAYLOAD)
    expect(calls.length).toBe(callsBefore)
    expect(
      RemoteEditSaveInputSchema.safeParse({ editId: id, baseRevision, text: overCap }).success,
    ).toBe(false)

    // CJK that fits in UTF-16 but not in UTF-8: the exact regression class 0031
    // fixed, now observed through the renderer-facing bridge.
    const cjkOverCap = '\u4e2d'.repeat(1_048_576)
    await expect(host.hostManagement.remoteEditSave(id, baseRevision, cjkOverCap)).rejects.toThrow(INVALID_PAYLOAD)
    expect(calls.length).toBe(callsBefore)
    expect(
      RemoteEditSaveInputSchema.safeParse({ editId: id, baseRevision, text: cjkOverCap }).success,
    ).toBe(false)

    // A multibyte payload that does fit passes both layers. The first save
    // changed the file, so this needs a fresh edit session (the old revision is
    // stale by design — FILE_CHANGED).
    const cjkWithinCap = '\u4e2d'.repeat(699_050)
    expect(RemoteEditSaveInputSchema.safeParse({ editId: id, baseRevision, text: cjkWithinCap }).success).toBe(true)
    const reopened = await host.hostManagement.remoteEditOpen(connectionId, 1, '/home/tester/notes.txt')
    expect(reopened.ok).toBe(true)
    if (!reopened.ok) return
    const savedCjk = await host.hostManagement.remoteEditSave(
      reopened.data.edit.id,
      reopened.data.edit.baseRevision,
      cjkWithinCap,
    )
    expect(savedCjk.ok).toBe(true)
    if (savedCjk.ok) expect(savedCjk.data.metadata.size).toBe(2_097_150)
    expect(calls.length).toBe(callsBefore + 2)
  })
})
