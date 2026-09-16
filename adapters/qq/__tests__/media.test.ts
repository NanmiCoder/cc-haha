import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AttachmentStore } from '../../common/attachment/attachment-store.js'
import { normalizeQqAttachmentUrl, QqMediaService } from '../media.js'

let tmpDir: string
let store: AttachmentStore

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-media-test-'))
  store = new AttachmentStore({ root: tmpDir })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('normalizeQqAttachmentUrl', () => {
  it('adds the scheme QQ omits', () => {
    expect(normalizeQqAttachmentUrl('multimedia.nt.qq.com.cn/a.png')?.toString())
      .toBe('https://multimedia.nt.qq.com.cn/a.png')
  })

  it('upgrades an http reference to https', () => {
    expect(normalizeQqAttachmentUrl('http://multimedia.nt.qq.com.cn/a.png')?.protocol).toBe('https:')
  })

  // The URL comes from remote input and is fetched by this process, so
  // anything that is not a plain web URL must fail closed.
  it.each([
    ['file:///etc/passwd', 'file scheme'],
    ['https://user:pw@host/a.png', 'embedded credentials'],
    ['   ', 'blank'],
    [undefined, 'missing'],
  ])('rejects %s (%s)', (value) => {
    expect(normalizeQqAttachmentUrl(value as string | undefined)).toBeNull()
  })
})

describe('QqMediaService', () => {
  function fetchReturning(body: string, headers: Record<string, string> = {}) {
    return (async () =>
      new Response(body, { status: 200, headers })) as unknown as typeof fetch
  }

  it('stages an image and reports it as an image attachment', async () => {
    const service = new QqMediaService(store, fetchReturning('png-bytes'))

    const local = await service.downloadAttachment(
      { content_type: 'image/png', url: 'multimedia.example/a.png' },
      'session-1',
      'seed-0',
    )

    expect(local.kind).toBe('image')
    expect(local.mimeType).toBe('image/png')
    expect(local.name).toBe('qq-image-seed-0.png')
    expect(fs.readFileSync(local.path, 'utf8')).toBe('png-bytes')
  })

  it('keeps the filename QQ supplied', async () => {
    const service = new QqMediaService(store, fetchReturning('doc'))

    const local = await service.downloadAttachment(
      { content_type: 'application/pdf', url: 'multimedia.example/x', filename: 'spec.pdf' },
      'session-1',
      'seed-1',
    )

    expect(local.name).toBe('spec.pdf')
    expect(local.kind).toBe('file')
  })

  it('falls back to the response content type when the event omits one', async () => {
    const service = new QqMediaService(store, fetchReturning('gif', { 'content-type': 'image/gif; charset=binary' }))

    const local = await service.downloadAttachment(
      { url: 'multimedia.example/x' },
      'session-1',
      'seed-2',
    )

    expect(local.mimeType).toBe('image/gif')
    expect(local.kind).toBe('image')
  })

  it('surfaces a failed download instead of staging an empty file', async () => {
    const service = new QqMediaService(
      store,
      (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch,
    )

    await expect(
      service.downloadAttachment({ url: 'multimedia.example/x' }, 'session-1', 'seed-3'),
    ).rejects.toThrow(/403/)
  })

  it('refuses an attachment whose URL cannot be used', async () => {
    const service = new QqMediaService(store, fetchReturning('x'))

    await expect(
      service.downloadAttachment({ url: 'file:///etc/passwd' }, 'session-1', 'seed-4'),
    ).rejects.toThrow(/download URL/i)
  })
})
