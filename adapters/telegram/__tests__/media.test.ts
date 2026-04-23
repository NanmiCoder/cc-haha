import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { TelegramMediaService } from '../media.js'
import { AttachmentStore } from '../../common/attachment/attachment-store.js'

let tmpRoot: string
let originalFetch: typeof fetch

function makeMockBot() {
  const fetchMock = mock(async (url: string | URL) => {
    const u = typeof url === 'string' ? url : url.toString()
    expect(u).toContain('/file/botFAKE_TOKEN/photos/abc.jpg')
    return new Response(Buffer.from('PHOTODATA'), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    })
  })
  ;(globalThis as any).fetch = fetchMock
  return {
    token: 'FAKE_TOKEN',
    api: {
      getFile: mock(async (fileId: string) => ({
        file_id: fileId,
        file_unique_id: 'unique',
        file_path: 'photos/abc.jpg',
      })),
      sendPhoto: mock(async () => ({ message_id: 1 })),
      sendDocument: mock(async () => ({ message_id: 2 })),
    },
    fetchMock,
  }
}

beforeEach(async () => {
  originalFetch = globalThis.fetch
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-media-test-'))
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('TelegramMediaService', () => {
  it('downloadFile fetches the real URL and stores a LocalAttachment', async () => {
    const bot = makeMockBot()
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    const svc = new TelegramMediaService(bot as any, store)
    const local = await svc.downloadFile('fid_123', 'sess-1', {
      fileName: 'abc.jpg',
      mimeType: 'image/jpeg',
    })
    expect(local.kind).toBe('image')
    expect(local.name).toBe('abc.jpg')
    expect(local.size).toBe('PHOTODATA'.length)
    expect(local.buffer.toString()).toBe('PHOTODATA')
    const onDisk = await fs.readFile(local.path)
    expect(onDisk.toString()).toBe('PHOTODATA')
  })

  it('sendPhoto calls bot.api.sendPhoto with InputFile-like payload', async () => {
    const bot = makeMockBot()
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    const svc = new TelegramMediaService(bot as any, store)
    await svc.sendPhoto(42, Buffer.from('IMG'), 'caption text')
    expect(bot.api.sendPhoto).toHaveBeenCalledTimes(1)
    const args = (bot.api.sendPhoto as any).mock.calls[0]
    expect(args[0]).toBe(42)
    // grammY InputFile wraps the buffer; just verify it's an object.
    expect(args[1]).toBeDefined()
    expect(args[2]?.caption).toBe('caption text')
  })

  it('sendDocument calls bot.api.sendDocument', async () => {
    const bot = makeMockBot()
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    const svc = new TelegramMediaService(bot as any, store)
    await svc.sendDocument(42, Buffer.from('DOC'), 'spec.pdf')
    expect(bot.api.sendDocument).toHaveBeenCalledTimes(1)
    const args = (bot.api.sendDocument as any).mock.calls[0]
    expect(args[0]).toBe(42)
    expect(args[1]).toBeDefined()
  })
})
