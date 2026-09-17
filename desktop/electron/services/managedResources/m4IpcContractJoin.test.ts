import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { ELECTRON_IPC_CHANNELS, type ElectronIpcChannel } from '../../ipc/channels'
import { validateElectronIpcPayload, ELECTRON_IPC_VALIDATORS } from '../../ipc/capabilities'
import {
  MintTokenInputSchema,
  FolderTransferInputSchema,
  RemoteEditCloseInputSchema,
  RemoteEditOpenInputSchema,
  RemoteEditSaveInputSchema,
  ResolveTokenInputSchema,
  RevokeTokenInputSchema,
  SftpListInputSchema,
  SftpStatInputSchema,
  TransferCancelInputSchema,
  TransferGetInputSchema,
  TransferStartDownloadInputSchema,
  TransferStartUploadInputSchema,
} from '../../../src/features/managed-resources/api/hostManagementApi.js'
import {
  M4_EDIT_TEXT_MAX_BYTES,
  M4_PAYLOAD_FIELDS,
  isM4Uuid,
  utf8ByteLength,
  type M4PayloadKind,
} from '../../../src/features/managed-resources/api/m4IpcContract.js'
import { createLocalPathService, createRemoteEditService, createSftpService, createTransferService } from './sftpService.js'
import {
  MANAGED_RESOURCES_IPC_CHANNELS,
  registerManagedResourcesIpc,
  type ManagedResourcesServices,
} from './registerIpc.js'
import { createFakeSftpTransport, type FakeSftpTransport } from './sftpTestTransport.js'

// ===========================================================================
// F30-01 / F30-02 — cross-layer contract join
//
// These tests drive BOTH ends of the same request:
//   renderer payload -> preload validator (`validateElectronIpcPayload`)
//                    -> ipcMain handler registered by `registerManagedResourcesIpc`
//                    -> real transfer / remote-edit service code path
//
// The audit found two reproducible drifts (0030 review F30-01/F30-02):
//   * the preload download validator did not allow the `localToken` the main
//     schema requires, so every legal download was rejected before the handler;
//   * the preload edit-text cap counted UTF-16 code units while the main schema
//     counted UTF-8 bytes, so ~1 MiB of CJK text passed the preload gate and was
//     then rejected by the handler.
// A test that exercises only one layer cannot see either bug, so every
// assertion below compares the two layers on the same payload object.
// ===========================================================================

const SCHEMAS = {
  mintToken: MintTokenInputSchema,
  folderTransfer: FolderTransferInputSchema,
  resolveToken: ResolveTokenInputSchema,
  revokeToken: RevokeTokenInputSchema,
  sftpList: SftpListInputSchema,
  sftpStat: SftpStatInputSchema,
  transferStartDownload: TransferStartDownloadInputSchema,
  transferStartUpload: TransferStartUploadInputSchema,
  transferCancel: TransferCancelInputSchema,
  transferGet: TransferGetInputSchema,
  remoteEditOpen: RemoteEditOpenInputSchema,
  remoteEditSave: RemoteEditSaveInputSchema,
  remoteEditClose: RemoteEditCloseInputSchema,
} satisfies Record<M4PayloadKind, { shape: Record<string, unknown> }>

function mainSchemaAccepts(kind: M4PayloadKind, payload: unknown): boolean {
  return SCHEMAS[kind].safeParse(payload).success
}

function preloadAccepts(channel: ElectronIpcChannel, payload: unknown): boolean {
  return validateElectronIpcPayload(channel, payload)
}

function withoutKeys(payload: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const copy = { ...payload }
  for (const key of keys) delete copy[key]
  return copy
}

function legalPayload(kind: M4PayloadKind): Record<string, unknown> {
  const connectionId = randomUUID()
  switch (kind) {
    case 'mintToken': return { fileName: 'report.txt' }
    case 'folderTransfer': return { jobId: randomUUID(), connectionId, generation: 1, remotePath: '/home/tester/folder' }
    case 'resolveToken':
    case 'revokeToken': return { token: randomUUID() }
    case 'sftpList':
    case 'sftpStat': return { connectionId, generation: 1, absolutePath: '/home/tester' }
    case 'transferStartDownload':
    case 'transferStartUpload': return {
      jobId: randomUUID(),
      connectionId,
      generation: 1,
      remotePath: '/home/tester/report.txt',
      localToken: randomUUID(),
    }
    case 'transferCancel':
    case 'transferGet': return { jobId: randomUUID() }
    case 'remoteEditOpen': return { connectionId, generation: 1, absolutePath: '/home/tester/notes.txt' }
    case 'remoteEditSave': return { editId: randomUUID(), baseRevision: 'rev-1', text: 'hello' }
    case 'remoteEditClose': return { editId: randomUUID() }
  }
}

const M4_CHANNELS: Array<[M4PayloadKind, ElectronIpcChannel]> = [
  ['folderTransfer', ELECTRON_IPC_CHANNELS.mrTransferUploadFolder],
  ['folderTransfer', ELECTRON_IPC_CHANNELS.mrTransferDownloadFolder],
  ['mintToken', ELECTRON_IPC_CHANNELS.mrMintUploadToken],
  ['mintToken', ELECTRON_IPC_CHANNELS.mrMintDownloadToken],
  ['resolveToken', ELECTRON_IPC_CHANNELS.mrResolveLocalToken],
  ['revokeToken', ELECTRON_IPC_CHANNELS.mrRevokeLocalToken],
  ['sftpList', ELECTRON_IPC_CHANNELS.mrSftpList],
  ['sftpStat', ELECTRON_IPC_CHANNELS.mrSftpStat],
  ['transferStartDownload', ELECTRON_IPC_CHANNELS.mrTransferStartDownload],
  ['transferStartUpload', ELECTRON_IPC_CHANNELS.mrTransferStartUpload],
  ['transferCancel', ELECTRON_IPC_CHANNELS.mrTransferCancel],
  ['transferGet', ELECTRON_IPC_CHANNELS.mrTransferGet],
  ['remoteEditOpen', ELECTRON_IPC_CHANNELS.mrRemoteEditOpen],
  ['remoteEditSave', ELECTRON_IPC_CHANNELS.mrRemoteEditSave],
  ['remoteEditClose', ELECTRON_IPC_CHANNELS.mrRemoteEditClose],
]

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

async function buildServices(tempDir: string, transport: FakeSftpTransport): Promise<ManagedResourcesServices> {
  const sftpService = createSftpService({ resolveSession: transport.resolveSession, tempDir })
  const localPathService = createLocalPathService({ userDataDir: tempDir })
  return {
    // Only the M4 transfer/edit channels are exercised here; the unrelated M2/M3
    // services are never reached by these handlers.
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

describe('F30-01/F30-02 — M4 preload <-> main contract join', () => {
  let tempDir: string
  let transport: FakeSftpTransport
  let services: ManagedResourcesServices
  let windowA: any
  const ownerA = 'window-owner-join-a'

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-m4-join-'))
    transport = await createFakeSftpTransport()
    services = await buildServices(tempDir, transport)
    windowA = makeFakeMainWindow(311)
  })

  afterEach(async () => {
    await transport.dispose()
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  })

  function registerFor(window: any, ownerId: string) {
    const ipc = makeFakeIpcMain()
    registerManagedResourcesIpc({
      ipcMain: ipc as any,
      getMainWindow: () => window as any,
      services,
      expectedOwnerId: ownerId,
    })
    return ipc
  }

  it('F30-01: a legal download survives the preload validator and completes through the real handler', async () => {
    await transport.seedFile('/home/tester/report.txt', 'hello-from-remote')
    const ipc = registerFor(windowA, ownerA)
    const event = makeEvent(windowA)

    const minted = await ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.mintDownloadToken)!(
      event,
      { fileName: 'report.txt' },
    )
    expect(minted.ok).toBe(true)

    // The exact payload a renderer sends for a normal download: no `ownerId`,
    // every main-process-required field present, including `localToken`.
    const payload = {
      jobId: randomUUID(),
      connectionId: randomUUID(),
      generation: 1,
      remotePath: '/home/tester/report.txt',
      localToken: minted.data.token,
    }

    // Layer 1 — preload gate. This is the assertion that failed before F30-01.
    expect(preloadAccepts(ELECTRON_IPC_CHANNELS.mrTransferStartDownload, payload)).toBe(true)
    // Layer 2 — main-process strict schema, same object.
    expect(mainSchemaAccepts('transferStartDownload', payload)).toBe(true)
    // The two layers must also agree on the channel name itself, otherwise the
    // validator could be guarding a different channel than the handler.
    expect(MANAGED_RESOURCES_IPC_CHANNELS.transferStartDownload)
      .toBe(ELECTRON_IPC_CHANNELS.mrTransferStartDownload)

    // Layer 3 — the real handler, reached with the validated payload.
    const res = await ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.transferStartDownload)!(event, payload)
    expect(res.ok).toBe(true)
    expect(res.data.id).toBe(payload.jobId)
    expect(res.data.state).toBe('completed')
    expect(res.data.checksum).toMatch(/^[0-9a-f]{64}$/)

    const localPath = services.localPathService.resolveToken(minted.data.token, ownerA, 'download-target')
    expect(localPath).not.toBeNull()
    expect((await fs.readFile(localPath!)).toString('utf8')).toBe('hello-from-remote')
  })

  it('F30-01: preload and main agree on legal and illegal download payloads', () => {
    const base = {
      jobId: randomUUID(),
      connectionId: randomUUID(),
      generation: 1,
      remotePath: '/home/tester/a.bin',
      localToken: randomUUID(),
    }
    const cases: Array<[string, unknown]> = [
      ['legal', base],
      ['legal without ownerId', base],
      ['legal with ownerId', { ...base, ownerId: 'window:101' }],
      ['missing localToken', withoutKeys(base, ['localToken'])],
      ['missing jobId', withoutKeys(base, ['jobId'])],
      ['missing remotePath', withoutKeys(base, ['remotePath'])],
      ['unknown field', { ...base, transferId: 'legacy' }],
      ['bad localToken', { ...base, localToken: 'not-a-uuid' }],
      ['hex-shaped but non-v4 localToken', { ...base, localToken: '11111111-1111-1111-1111-111111111111' }],
      ['bad jobId', { ...base, jobId: 'not-a-uuid' }],
      ['bad connectionId', { ...base, connectionId: 'not-a-uuid' }],
      ['generation zero', { ...base, generation: 0 }],
      ['generation fractional', { ...base, generation: 1.5 }],
      ['generation as string', { ...base, generation: '1' }],
      ['relative remotePath', { ...base, remotePath: 'home/tester/a.bin' }],
      ['remotePath with empty segment', { ...base, remotePath: '/home//tester/a.bin' }],
      ['remotePath with NUL', { ...base, remotePath: '/home/tester/\u0000a.bin' }],
      ['oversized remotePath', { ...base, remotePath: '/' + 'a'.repeat(4097) }],
      ['empty ownerId', { ...base, ownerId: '' }],
      ['oversized ownerId', { ...base, ownerId: 'x'.repeat(257) }],
      ['numeric ownerId', { ...base, ownerId: 123 }],
      ['payload is a string', 'download-please'],
    ]

    for (const [name, payload] of cases) {
      const preload = preloadAccepts(ELECTRON_IPC_CHANNELS.mrTransferStartDownload, payload)
      const main = mainSchemaAccepts('transferStartDownload', payload)
      expect(preload, `${name}: preload verdict`).toBe(main)
    }

    // The parity loop above passes when both layers agree — including when both
    // are wrong. Pin the verdicts the contract actually promises.
    expect(preloadAccepts(ELECTRON_IPC_CHANNELS.mrTransferStartDownload, base)).toBe(true)
    expect(mainSchemaAccepts('transferStartDownload', base)).toBe(true)
    for (const name of [
      'missing localToken',
      'unknown field',
      'bad localToken',
      'hex-shaped but non-v4 localToken',
      'generation zero',
      'relative remotePath',
    ]) {
      const payload = cases.find(entry => entry[0] === name)![1]
      expect(preloadAccepts(ELECTRON_IPC_CHANNELS.mrTransferStartDownload, payload), `${name}: preload`).toBe(false)
      expect(mainSchemaAccepts('transferStartDownload', payload), `${name}: main`).toBe(false)
    }
  })

  it('F30-01: preload and main expose the same field set on every M4 channel', () => {
    for (const [kind, channel] of M4_CHANNELS) {
      const payload = legalPayload(kind)
      // The shared table is the contract both layers read.
      const allowed: readonly string[] = M4_PAYLOAD_FIELDS[kind]
      for (const key of Object.keys(payload)) {
        expect(allowed.includes(key), `${kind}: ${key} missing from the shared field table`).toBe(true)
      }
      expect(Object.keys(SCHEMAS[kind].shape).sort(), `${kind}: zod shape vs shared table`)
        .toEqual([...allowed].sort())

      const withExtra = { ...payload, bogus: 1 }
      const legalPreload = preloadAccepts(channel, payload)
      const legalMain = mainSchemaAccepts(kind, payload)
      expect(legalPreload, `${kind}: legal payload rejected by preload`).toBe(true)
      expect(legalMain, `${kind}: legal payload rejected by main`).toBe(true)
      expect(preloadAccepts(channel, withExtra), `${kind}: unknown field accepted by preload`).toBe(false)
      expect(mainSchemaAccepts(kind, withExtra), `${kind}: unknown field accepted by main`).toBe(false)
    }
  })

  it('F30-01: every M4 channel the preload registry exposes is covered by this contract test', () => {
    // Guards the test itself: a new `mr*` transfer/edit/sftp channel must be
    // added to M4_CHANNELS (and therefore to the shared field table) instead of
    // silently escaping the parity checks above. The `mr` prefix alone is not a
    // usable filter — it also covers the M2/M3 channels — so the M4 family is
    // derived from the names owned by this contract.
    const m4NamePattern = /^mr(Mint|ResolveLocal|RevokeLocal|Sftp|Transfer|RemoteEdit)/
    const derived = Object.entries(ELECTRON_IPC_CHANNELS)
      .filter(([name]) => m4NamePattern.test(name))
      .map(([, channel]) => channel)
    expect(derived.length).toBeGreaterThan(0)
    expect(new Set(derived)).toEqual(new Set(M4_CHANNELS.map(([, channel]) => channel)))
    for (const channel of derived) {
      expect(
        ELECTRON_IPC_VALIDATORS[channel as ElectronIpcChannel],
        `${channel} is not registered in the preload validator map`,
      ).toBeDefined()
    }
  })

  it('F30-01/F30-02: preload and main agree on every mutation of every M4 payload', () => {
    // Data-driven parity sweep: for each M4 channel, drop each field, add an
    // unknown field, and set each field to a wrong-typed value. Every pair of
    // verdicts must match, which is the invariant the two audit findings broke.
    for (const [kind, channel] of M4_CHANNELS) {
      const base = legalPayload(kind)
      const mutations: Array<[string, unknown]> = [['legal', base], ['unknown field', { ...base, bogus: true }]]
      for (const key of Object.keys(base)) {
        mutations.push([`missing ${key}`, withoutKeys(base, [key])])
        mutations.push([`null ${key}`, { ...base, [key]: null }])
        mutations.push([`numeric ${key}`, { ...base, [key]: 0 }])
        mutations.push([`empty ${key}`, { ...base, [key]: '' }])
      }
      for (const [label, payload] of mutations) {
        const preload = preloadAccepts(channel, payload)
        const main = mainSchemaAccepts(kind, payload)
        expect(preload, `${kind} / ${label}: preload verdict`).toBe(main)
      }
    }
  })

  it('F30-01: the shared UUID predicate matches zod on every version/variant nibble', () => {
    // The original drift was that preload used a hex shape while zod checks the
    // version/variant nibbles. Pinning the predicate against zod keeps a future
    // zod upgrade from silently re-opening the same hole.
    const zodUuid = z.string().uuid()
    const cases: string[] = []
    for (const version of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'e', 'f']) {
      for (const variant of ['0', '1', '8', '9', 'a', 'b', 'c', 'f']) {
        cases.push(`0195f1a1-6a5e-${version}c3d-${variant}abc-0123456789ab`)
      }
    }
    cases.push(
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      '0195F1A1-6A5E-7C3D-9ABC-0123456789AB',
      'not-a-uuid',
      '',
      '12345678-1234-1234-1234-12345678901',
      '12345678-1234-1234-1234-1234567890123',
    )
    for (const value of cases) {
      expect(isM4Uuid(value), value).toBe(zodUuid.safeParse(value).success)
    }
  })
})

describe('F30-02 — the 2 MiB edit-text cap is byte-identical in preload and main', () => {
  let tempDir: string
  let transport: FakeSftpTransport
  let services: ManagedResourcesServices
  let windowA: any
  const ownerA = 'window-owner-bytes-a'

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-m4-bytes-'))
    transport = await createFakeSftpTransport()
    services = await buildServices(tempDir, transport)
    windowA = makeFakeMainWindow(411)
  })

  afterEach(async () => {
    await transport.dispose()
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  })

  function editSavePayload(text: string): Record<string, unknown> {
    return { editId: randomUUID(), baseRevision: 'rev-1', text }
  }

  function verdicts(text: string): { preload: boolean; main: boolean } {
    const payload = editSavePayload(text)
    return {
      preload: preloadAccepts(ELECTRON_IPC_CHANNELS.mrRemoteEditSave, payload),
      main: mainSchemaAccepts('remoteEditSave', payload),
    }
  }

  it('accepts exactly 2 MiB of ASCII and rejects one byte more, in both layers', () => {
    expect(M4_EDIT_TEXT_MAX_BYTES).toBe(2 * 1024 * 1024)
    expect(verdicts('a'.repeat(M4_EDIT_TEXT_MAX_BYTES))).toEqual({ preload: true, main: true })
    expect(verdicts('a'.repeat(M4_EDIT_TEXT_MAX_BYTES + 1))).toEqual({ preload: false, main: false })
  })

  it('rejects CJK text that fits in UTF-16 but exceeds 2 MiB of UTF-8, in both layers', () => {
    const cjk = '\u4e2d'.repeat(1_048_576)
    // 1 MiB UTF-16 code units <= 2 MiB, but 3 MiB of UTF-8 bytes.
    expect(cjk.length).toBeLessThan(M4_EDIT_TEXT_MAX_BYTES)
    expect(utf8ByteLength(cjk)).toBe(3 * 1024 * 1024)
    expect(verdicts(cjk)).toEqual({ preload: false, main: false })
  })

  it('pins the multibyte boundary at the byte, not the code unit, in both layers', () => {
    // 699_050 * 3 === 2_097_150 <= 2_097_152, the next character exceeds the cap.
    expect(utf8ByteLength('\u4e2d'.repeat(699_050))).toBe(2_097_150)
    expect(verdicts('\u4e2d'.repeat(699_050))).toEqual({ preload: true, main: true })
    expect(utf8ByteLength('\u4e2d'.repeat(699_051))).toBe(2_097_153)
    expect(verdicts('\u4e2d'.repeat(699_051))).toEqual({ preload: false, main: false })
  })

  it('counts surrogate pairs as 4 bytes (emoji boundary) in both layers', () => {
    // 524_288 * 4 === 2_097_152 === the cap, exactly.
    expect(utf8ByteLength('\ud83d\ude00'.repeat(524_288))).toBe(M4_EDIT_TEXT_MAX_BYTES)
    expect(verdicts('\ud83d\ude00'.repeat(524_288))).toEqual({ preload: true, main: true })
    expect(verdicts('\ud83d\ude00'.repeat(524_289))).toEqual({ preload: false, main: false })
  })

  it('keeps UTF-8 counting identical to TextEncoder (and Node Buffer), including lone surrogates', () => {
    const wellFormed = [
      '',
      'a',
      '\u4e2d',
      '\u4e2d\u6587',
      '\ud83d\ude00',
      '\u4e2da\ud83d\ude00',
      '\u00e9',
      '\u0000',
    ]
    for (const sample of wellFormed) {
      expect(utf8ByteLength(sample), JSON.stringify(sample)).toBe(new TextEncoder().encode(sample).length)
      // Node's Buffer agrees for well-formed text. The shared helper is also
      // used by the renderer, where Node globals do not exist at all.
      expect(utf8ByteLength(sample), JSON.stringify(sample)).toBe(Buffer.byteLength(sample, 'utf8'))
    }
    // A lone surrogate cannot be encoded: UTF-8 turns it into U+FFFD (3 bytes).
    // This is the Node/Electron behaviour; Bun's Buffer.byteLength under-reports
    // it as 2, which is one more reason the shared helper must not delegate to
    // Buffer — the two IPC layers run under different JS runtimes in tests.
    for (const sample of ['\ud800', '\udc00', 'a\ud800']) {
      expect(utf8ByteLength(sample), JSON.stringify(sample)).toBe(new TextEncoder().encode(sample).length)
    }
    // The text cap uses the same rule, so an unpaired surrogate cannot be
    // smuggled in by counting it as a single byte.
    expect(utf8ByteLength('\ud800')).toBe(3)
    expect(verdicts('a'.repeat(M4_EDIT_TEXT_MAX_BYTES - 3) + '\ud800')).toEqual({ preload: true, main: true })
    expect(verdicts('a'.repeat(M4_EDIT_TEXT_MAX_BYTES - 2) + '\ud800')).toEqual({ preload: false, main: false })
  })

  it('rejects NUL and oversized text through the registered handler, and lets the byte-exact boundary through', async () => {
    const ipc = makeFakeIpcMain()
    registerManagedResourcesIpc({
      ipcMain: ipc as any,
      getMainWindow: () => windowA as any,
      services,
      expectedOwnerId: ownerA,
    })
    const event = makeEvent(windowA)
    const save = ipc.handlers.get(MANAGED_RESOURCES_IPC_CHANNELS.remoteEditSave)!

    // CJK text the old preload gate forwarded and this layer then rejected.
    const rejected = await save(event, editSavePayload('\u4e2d'.repeat(1_048_576)))
    expect(rejected.ok).toBe(false)
    expect(rejected.error.code).toBe('INVALID_ARGUMENT')

    const nulRejected = await save(event, editSavePayload('has\u0000nul'))
    expect(nulRejected.ok).toBe(false)
    expect(nulRejected.error.code).toBe('INVALID_ARGUMENT')

    // Byte-exact boundary payload reaches the service (which then reports the
    // unknown edit id), proving the size gate itself no longer rejects it.
    const accepted = await save(event, editSavePayload('\u4e2d'.repeat(699_050)))
    expect(accepted.ok).toBe(false)
    expect(accepted.error.code).not.toBe('INVALID_ARGUMENT')
  })
})
