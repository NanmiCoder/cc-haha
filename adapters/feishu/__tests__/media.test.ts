import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { FeishuMediaService } from '../media.js'
import { AttachmentStore } from '../../common/attachment/attachment-store.js'

function makeMockClient() {
  return {
    im: {
      messageResource: {
        get: mock(async () => ({
          // node-sdk returns an object with a `.writeFile(path)` helper
          // that dumps the underlying stream. We fake that here.
          writeFile: async (target: string) => {
            await fs.writeFile(target, Buffer.from('DOWNLOADED'))
          },
        })),
      },
      image: {
        create: mock(async (_req: any) => ({
          data: { image_key: 'img_fake_123' },
        })),
      },
      file: {
        create: mock(async (_req: any) => ({
          data: { file_key: 'file_fake_456' },
        })),
      },
      message: {
        create: mock(async (_req: any) => ({
          data: { message_id: 'om_fake' },
        })),
      },
    },
  }
}

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-media-test-'))
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('FeishuMediaService', () => {
  it('downloadResource writes a local file and returns LocalAttachment', async () => {
    const client = makeMockClient()
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    const svc = new FeishuMediaService(client as any, store)
    const local = await svc.downloadResource({
      messageId: 'om_msg_1',
      fileKey: 'img_key_1',
      kind: 'image',
      fileName: 'cat.png',
      sessionId: 'sess-1',
    })
    expect(local.kind).toBe('image')
    expect(local.name).toBe('cat.png')
    expect(local.size).toBe('DOWNLOADED'.length)
    expect(local.path).toContain(path.join('feishu', 'sess-1'))
    const onDisk = await fs.readFile(local.path)
    expect(onDisk.toString()).toBe('DOWNLOADED')
    expect(client.im.messageResource.get).toHaveBeenCalledTimes(1)
    const call = (client.im.messageResource.get as any).mock.calls[0][0]
    expect(call.path.message_id).toBe('om_msg_1')
    expect(call.path.file_key).toBe('img_key_1')
    expect(call.params.type).toBe('image')
  })

  it('uploadImage returns an image_key and sends the buffer through', async () => {
    const client = makeMockClient()
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    const svc = new FeishuMediaService(client as any, store)
    const key = await svc.uploadImage(Buffer.from('PNGDATA'), 'image/png')
    expect(key).toBe('img_fake_123')
    expect(client.im.image.create).toHaveBeenCalledTimes(1)
    const call = (client.im.image.create as any).mock.calls[0][0]
    expect(call.data.image_type).toBe('message')
    expect(call.data.image).toBeDefined()
  })

  it('uploadFile returns a file_key and uses stream file_type mapping', async () => {
    const client = makeMockClient()
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    const svc = new FeishuMediaService(client as any, store)
    const key = await svc.uploadFile(Buffer.from('PDFDATA'), 'report.pdf')
    expect(key).toBe('file_fake_456')
    const call = (client.im.file.create as any).mock.calls[0][0]
    expect(call.data.file_name).toBe('report.pdf')
    expect(call.data.file_type).toBe('pdf')
  })

  it('sendImageMessage posts msg_type=image', async () => {
    const client = makeMockClient()
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    const svc = new FeishuMediaService(client as any, store)
    await svc.sendImageMessage('oc_chat_1', 'img_fake_123')
    const call = (client.im.message.create as any).mock.calls[0][0]
    expect(call.params.receive_id_type).toBe('chat_id')
    expect(call.data.receive_id).toBe('oc_chat_1')
    expect(call.data.msg_type).toBe('image')
    const content = JSON.parse(call.data.content)
    expect(content.image_key).toBe('img_fake_123')
  })

  it('sendFileMessage posts msg_type=file', async () => {
    const client = makeMockClient()
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    const svc = new FeishuMediaService(client as any, store)
    await svc.sendFileMessage('oc_chat_1', 'file_fake_456')
    const call = (client.im.message.create as any).mock.calls[0][0]
    expect(call.data.msg_type).toBe('file')
    const content = JSON.parse(call.data.content)
    expect(content.file_key).toBe('file_fake_456')
  })
})
