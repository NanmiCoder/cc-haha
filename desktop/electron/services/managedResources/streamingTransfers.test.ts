import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createFakeSftpTransport } from './sftpTestTransport'
import { createLocalPathService, createSftpService, createTransferService, createRemoteEditService } from './sftpService'

let temp: string
let remote: Awaited<ReturnType<typeof createFakeSftpTransport>>
let local: ReturnType<typeof createLocalPathService>
let sftp: ReturnType<typeof createSftpService>
let transfers: ReturnType<typeof createTransferService>
const ownerId = 'fixture-owner'
const connectionId = '22222222-2222-4222-8222-222222222222'
const base = () => ({ jobId: randomUUID(), connectionId, ownerId, generation: 1 })
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-streaming-'))
  remote = await createFakeSftpTransport()
  local = createLocalPathService({ userDataDir: temp })
  sftp = createSftpService({ resolveSession: remote.resolveSession, tempDir: temp })
  transfers = createTransferService({ resolveSession: remote.resolveSession, localPathService: local, sftpService: sftp })
})
afterEach(async () => {
  transfers?.dispose()
  sftp?.dispose()
  local?.dispose()
  await remote?.dispose()
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('streaming files and recursive directories', () => {
  it('uploads and downloads a file above the editor limit and still refuses to edit it', async () => {
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 1, 97)
    const upload = await local.mintUploadToken({ ownerId, fileName: 'large.bin' })
    await fs.writeFile(upload.absolutePath, bytes)
    const sent = await transfers.startUpload({ ...base(), remotePath: '/large.bin', localToken: upload.token })
    expect(sent.state).toBe('completed')
    expect(sent.transferred).toBe(bytes.length)
    const destination = await local.mintDownloadToken({ ownerId, fileName: 'large.bin' })
    const received = await transfers.startDownload({ ...base(), remotePath: '/large.bin', localToken: destination.token })
    expect(received.state).toBe('completed')
    expect(received.checksum).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(await fs.readFile(destination.absolutePath)).toEqual(bytes)
    const editor = createRemoteEditService({ resolveSession: remote.resolveSession, sftpService: sftp, localPathService: local })
    await expect(editor.open({ connectionId, ownerId, generation: 1, absolutePath: '/large.bin' })).rejects.toThrow('FILE_TOO_LARGE')
  })

  it('maps numeric SFTP permission failures without exposing transport error details', async () => {
    const holder = await sftp.ensureSftp(connectionId, ownerId)
    holder.sftp.lstat = (_name, callback) => callback(Object.assign(new Error('sensitive transport details'), { code: 3 }), undefined as never)
    const token = await local.mintUploadToken({ ownerId, fileName: 'denied.txt' })
    await fs.writeFile(token.absolutePath, 'fixture')
    const result = await transfers.startUpload({ ...base(), remotePath: '/denied.txt', localToken: token.token })
    expect(result.error?.code).toBe('PERMISSION_DENIED')
    expect(JSON.stringify(result.error)).not.toContain('sensitive transport details')
  })

  it('uploads an empty file without confusing it with an invalid path', async () => {
    const token = await local.mintUploadToken({ ownerId, fileName: '.profile' })
    await fs.writeFile(token.absolutePath, '')
    const result = await transfers.startUpload({ ...base(), remotePath: '/.profile', localToken: token.token })
    expect(result.state).toBe('completed')
    expect((await remote.readFile('/.profile')).length).toBe(0)
  })

  it('refuses an existing target and never cleans up its unrelated .part sibling', async () => {
    await remote.seedFile('/keep.bin', 'original')
    await remote.seedFile('/keep.bin.part', 'someone else')
    const token = await local.mintUploadToken({ ownerId, fileName: 'keep.bin' })
    await fs.writeFile(token.absolutePath, 'replacement')
    const result = await transfers.startUpload({ ...base(), remotePath: '/keep.bin', localToken: token.token })
    expect(result.error?.code).toBe('TARGET_EXISTS')
    expect((await remote.readFile('/keep.bin')).toString()).toBe('original')
    expect((await remote.readFile('/keep.bin.part')).toString()).toBe('someone else')
  })

  it('cancels the actual streams before publishing a file and preserves other jobs', async () => {
    let cancellation: Promise<void> | undefined
    transfers = createTransferService({ resolveSession: remote.resolveSession, localPathService: local, sftpService: sftp,
      emit: ({ job }) => { if (job.transferred > 0 && job.state === 'in_progress' && !cancellation) cancellation = transfers.cancel(job.id, ownerId) },
    })
    const token = await local.mintUploadToken({ ownerId, fileName: 'cancel.bin' })
    await fs.writeFile(token.absolutePath, Buffer.alloc(8 * 1024 * 1024))
    const result = await transfers.startUpload({ ...base(), remotePath: '/cancel.bin', localToken: token.token })
    await cancellation
    expect(result.state).toBe('cancelled')
    expect(await remote.fileExists('/cancel.bin')).toBe(false)
    expect(await fs.readdir(remote.remoteRoot)).toEqual([])
  })

  it('refuses changed SSH generation before publishing already streamed bytes', async () => {
    transfers = createTransferService({ resolveSession: remote.resolveSession, localPathService: local, sftpService: sftp,
      emit: ({ job }) => { if (job.transferred > 0 && job.state === 'verifying') remote.setGeneration(2) },
    })
    const token = await local.mintUploadToken({ ownerId, fileName: 'generation.bin' })
    await fs.writeFile(token.absolutePath, Buffer.alloc(128 * 1024))
    const result = await transfers.startUpload({ ...base(), remotePath: '/generation.bin', localToken: token.token })
    expect(result.error?.code).toBe('STALE_GENERATION')
    expect(await remote.fileExists('/generation.bin')).toBe(false)
  })

  it('rejects symlink/junction directories without copying their targets', async () => {
    const source = path.join(temp, 'source')
    const outside = path.join(temp, 'outside')
    await fs.mkdir(source)
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'private.txt'), 'must not upload')
    await fs.symlink(outside, path.join(source, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = await transfers.startFolderUpload({ ...base(), localRoot: source, remotePath: '/' })
    expect(result.error?.code).toBe('IS_SYMLINK')
    expect(await fs.readdir(remote.remoteRoot)).toEqual([])
  })

  it('rejects an oversized directory plan before creating its destination', async () => {
    const source = path.join(temp, 'bounded')
    await fs.mkdir(source)
    await fs.writeFile(path.join(source, 'a'), 'a')
    await fs.writeFile(path.join(source, 'b'), 'b')
    transfers = createTransferService({ resolveSession: remote.resolveSession, localPathService: local, sftpService: sftp, maxEntries: 2 })
    const result = await transfers.startFolderUpload({ ...base(), localRoot: source, remotePath: '/' })
    expect(result.error?.code).toBe('TREE_LIMIT_EXCEEDED')
    expect(await fs.readdir(remote.remoteRoot)).toEqual([])
  })

  it('preserves directory hierarchy, dotfiles, empty files and empty folders in both directions', async () => {
    const source = path.join(temp, 'project')
    await fs.mkdir(path.join(source, 'empty-directory'), { recursive: true })
    await fs.mkdir(path.join(source, 'nested'), { recursive: true })
    await fs.writeFile(path.join(source, '.bashrc'), 'export LANG=C.UTF-8\n')
    await fs.writeFile(path.join(source, 'nested', 'empty.txt'), '')
    await fs.writeFile(path.join(source, 'nested', '文档.md'), '# Hello\n')
    const sent = await transfers.startFolderUpload({ ...base(), localRoot: source, remotePath: '/' })
    expect(sent.state).toBe('completed')
    expect(await remote.readFile('/project/.bashrc')).toEqual(Buffer.from('export LANG=C.UTF-8\n'))
    const destination = path.join(temp, 'download')
    await fs.mkdir(destination)
    const received = await transfers.startFolderDownload({ ...base(), localRoot: destination, remotePath: '/project' })
    expect(received.state).toBe('completed')
    expect(await fs.readFile(path.join(destination, 'project', 'nested', '文档.md'), 'utf8')).toBe('# Hello\n')
    expect((await fs.stat(path.join(destination, 'project', 'nested', 'empty.txt'))).size).toBe(0)
    expect((await fs.stat(path.join(destination, 'project', 'empty-directory'))).isDirectory()).toBe(true)
    const collision = await transfers.startFolderDownload({ ...base(), localRoot: destination, remotePath: '/project' })
    expect(collision.error?.code).toBe('TARGET_EXISTS')
    expect(await fs.readFile(path.join(destination, 'project', '.bashrc'), 'utf8')).toBe('export LANG=C.UTF-8\n')
  })
})
