import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { Client, ClientChannel } from 'ssh2'
import { createFakeSftpTransport } from './sftpTestTransport'
import { createLocalPathService, createSftpService, createTransferService, type TransferJob } from './sftpService'
import { remoteChecksumCommand, remoteFileChecksum } from './remoteFileChecksum'

const ownerId = 'large-file-fixture'
const connectionId = '22222222-2222-4222-8222-222222222222'
let temp: string
let remote: Awaited<ReturnType<typeof createFakeSftpTransport>>
let local: ReturnType<typeof createLocalPathService>
let sftp: ReturnType<typeof createSftpService>
let transfers: ReturnType<typeof createTransferService>
let execCount = 0
let signals = 0
let mode: 'hash' | 'missing' | 'mismatch' | 'hold'
const events: TransferJob[] = []
async function hashFile(file: string) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(file, { highWaterMark: 1024 * 1024 })) hash.update(bytes)
  return hash.digest('hex')
}
function collector() {
  const channel = new EventEmitter() as EventEmitter & { stderr: PassThrough; end(): void; close(): void; destroy(): void; signal(): void }
  channel.stderr = new PassThrough()
  channel.end = () => {}
  channel.close = () => {}
  channel.destroy = () => { channel.stderr.destroy() }
  channel.signal = () => { signals++ }
  return channel
}
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-large-verify-'))
  remote = await createFakeSftpTransport()
  local = createLocalPathService({ userDataDir: temp })
  sftp = createSftpService({ resolveSession: remote.resolveSession, tempDir: temp })
  mode = 'hash'; execCount = 0; signals = 0; events.length = 0
  const client = remote.resolveSession({ connectionId, ownerId }).client
  // Only the remote command boundary is simulated. Hash actual bytes on disk,
  // without routing them over SFTP a second time or mocking the transfer service.
  client.exec = ((command: string, callback: (error: Error | undefined, channel: ClientChannel) => void) => {
    execCount++
    const channel = collector()
    callback(undefined, channel as unknown as ClientChannel)
    void (async () => {
      if (mode === 'hold') return
      if (mode === 'missing') { channel.emit('exit', 127); channel.emit('close'); return }
      const staging = (await fs.readdir(remote.remoteRoot)).find(name => name.endsWith('.part'))!
      expect(command).toBe(remoteChecksumCommand('/' + staging))
      const hash = mode === 'mismatch' ? 'a'.repeat(64) : await hashFile(path.join(remote.remoteRoot, staging))
      channel.emit('data', Buffer.from(`CC_HAHA_VERIFY_V1\n${hash}  -\n`))
      channel.emit('exit', 0); channel.emit('close')
    })().catch(error => channel.emit('error', error))
    return client
  }) as Client['exec']
  transfers = createTransferService({ resolveSession: remote.resolveSession, localPathService: local, sftpService: sftp,
    emit: ({ job }) => { if (job.state !== 'in_progress') events.push(job) },
  })
})
afterEach(async () => {
  transfers?.dispose(); sftp?.dispose(); local?.dispose()
  await remote?.dispose()
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
async function upload(size: number) {
  const token = await local.mintUploadToken({ ownerId, fileName: 'large.bin' })
  const handle = await fs.open(token.absolutePath, 'w')
  await handle.truncate(size)
  if (size > 20) { await handle.write(Buffer.from('fixture-first'), 0, 13, 0); await handle.write(Buffer.from('last!'), 0, 5, size - 5) }
  await handle.close()
  const input = { jobId: randomUUID(), connectionId, ownerId, generation: 1, remotePath: '/large.bin', localToken: token.token }
  return { token, input }
}

describe('large uploads retain integrity without a full network read-back', () => {
  it('uploads more than 1 GiB and verifies SHA-256 on the remote side before publishing', async () => {
    const size = 1024 * 1024 * 1024 + 17
    const { token, input } = await upload(size)
    const holder = await sftp.ensureSftp(connectionId, ownerId)
    const reads = vi.spyOn(holder.sftp, 'createReadStream')
    const result = await transfers.startUpload(input)
    expect(result).toMatchObject({ state: 'completed', size, transferred: size, verifiedBytes: size, verificationMethod: 'remote-sha256' })
    expect(execCount).toBe(1)
    expect(reads).not.toHaveBeenCalled()
    expect(result.checksum).toBe(await hashFile(token.absolutePath))
    expect((await fs.stat(path.join(remote.remoteRoot, 'large.bin'))).size).toBe(size)
    expect(events.some(job => job.state === 'verifying')).toBe(true)
    expect(await fs.readdir(remote.remoteRoot)).toEqual(['large.bin'])
  }, 180000)

  it('falls back only when unavailable, with visible progress for full stream verification', async () => {
    mode = 'missing'
    const { input } = await upload(16 * 1024 * 1024 + 3)
    const result = await transfers.startUpload(input)
    expect(result.state).toBe('completed')
    expect(result.verificationMethod).toBe('stream-sha256')
    expect(events.some(job => (job.verifiedBytes ?? 0) > 0 && job.verifiedBytes! < job.size)).toBe(true)
    expect(result.verifiedBytes).toBe(result.size)
  })

  it('never publishes a checksum mismatch or disguises it with a fallback', async () => {
    mode = 'mismatch'
    const { input } = await upload(16 * 1024 * 1024)
    const holder = await sftp.ensureSftp(connectionId, ownerId)
    const reads = vi.spyOn(holder.sftp, 'createReadStream')
    const result = await transfers.startUpload(input)
    expect(result).toMatchObject({ state: 'failed', error: { code: 'CHECKSUM_MISMATCH' } })
    expect(reads).not.toHaveBeenCalled()
    expect(await fs.readdir(remote.remoteRoot)).toEqual([])
  })

  it('cancels a slow remote verification without closing SSH or publishing partial bytes', async () => {
    mode = 'hold'
    const { input } = await upload(16 * 1024 * 1024)
    const pending = transfers.startUpload(input)
    await vi.waitFor(() => expect(execCount).toBe(1))
    await transfers.cancel(input.jobId, ownerId)
    expect(await pending).toMatchObject({ state: 'cancelled' })
    expect(signals).toBeGreaterThan(0)
    expect(await fs.readdir(remote.remoteRoot)).toEqual([])
    expect(remote.resolveSession({ connectionId, ownerId }).generation).toBe(1)
  })

  it('gives a bounded verification timeout instead of waiting indefinitely', async () => {
    mode = 'hold'
    const controller = new AbortController()
    await expect(remoteFileChecksum({ client: remote.resolveSession({ connectionId, ownerId }).client, path: '/fixture',
      size: 1024 ** 3, signal: controller.signal, checkpoint() {}, timeoutMs: 25 })).rejects.toThrow('VERIFY_TIMEOUT')
    expect(signals).toBeGreaterThan(0)
  })
})
