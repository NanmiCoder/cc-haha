import { afterEach, describe, expect, it } from 'bun:test'
import crypto from 'node:crypto'
import { sendWechatMedia } from '../media-upload.js'

const originalFetch = globalThis.fetch
const base = { baseUrl: 'https://ilinkai.weixin.qq.com', token: 'fixture-token', to: 'fixture-user', contextToken: 'fixture-context', fileName: 'report.bin', buffer: Buffer.from('media fixture'), clientId: 'delivery-1' }
afterEach(() => { globalThis.fetch = originalFetch })

describe('WeChat media upload and delivery', () => {
  for (const [kind, mediaType, itemType] of [['image', 1, 2], ['file', 3, 4], ['video', 2, 5]] as const) {
    it(`encrypts and sends ${kind} using the official wire shape`, async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = []
      let uploadRequest: Record<string, any> = {}
      let message: Record<string, any> = {}
      globalThis.fetch = (async (url, init) => {
        calls.push({ url: String(url), init })
        expect(init?.redirect).toBe('error')
        if (String(url).endsWith('getuploadurl')) {
          uploadRequest = JSON.parse(String(init?.body))
          expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-token')
          return Response.json({ ret: 0, upload_param: 'opaque+/=' })
        }
        if (String(url).includes('/c2c/upload')) {
          expect(new Headers(init?.headers).has('Authorization')).toBe(false)
          expect(new URL(String(url)).searchParams.get('encrypted_query_param')).toBe('opaque+/=')
          const cipher = Buffer.from(init?.body as Uint8Array)
          expect(cipher.length).toBe(uploadRequest.filesize)
          const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from(uploadRequest.aeskey, 'hex'), null)
          expect(Buffer.concat([decipher.update(cipher), decipher.final()])).toEqual(base.buffer)
          return new Response('', { headers: { 'x-encrypted-param': 'download-token' } })
        }
        message = JSON.parse(String(init?.body)).msg
        return Response.json({ ret: 0 })
      }) as typeof fetch
      await sendWechatMedia({ ...base, kind, mimeType: kind === 'image' ? 'image/png' : undefined })
      expect(calls).toHaveLength(3)
      expect(uploadRequest).toMatchObject({ media_type: mediaType, rawsize: base.buffer.length, no_need_thumb: true, to_user_id: base.to })
      expect(uploadRequest.rawfilemd5).toBe(crypto.createHash('md5').update(base.buffer).digest('hex'))
      expect(message).toMatchObject({ to_user_id: base.to, client_id: base.clientId, context_token: base.contextToken, message_type: 2, message_state: 2 })
      const item = message.item_list[0]
      expect(item.type).toBe(itemType)
      const payload = item.image_item ?? item.file_item ?? item.video_item
      expect(Buffer.from(payload.media.aes_key, 'base64').toString()).toBe(uploadRequest.aeskey)
      expect(payload.media).toMatchObject({ encrypt_query_param: 'download-token', encrypt_type: 1 })
      if (kind === 'file') expect(payload).toMatchObject({ file_name: 'report.bin', len: String(base.buffer.length) })
      else expect(payload[kind === 'image' ? 'mid_size' : 'video_size']).toBe(uploadRequest.filesize)
    })
  }

  it('prefers a trusted full upload URL over fallback parameters', async () => {
    const urls: string[] = []
    globalThis.fetch = (async (url) => {
      urls.push(String(url))
      if (urls.length === 1) return Response.json({ upload_full_url: 'https://novac2c.cdn.weixin.qq.com/custom?token=x', upload_param: 'ignored' })
      if (urls.length === 2) return new Response('', { headers: { 'x-encrypted-param': 'download' } })
      return Response.json({ ret: 0 })
    }) as typeof fetch
    await sendWechatMedia({ ...base, kind: 'file' })
    expect(urls[1]).toBe('https://novac2c.cdn.weixin.qq.com/custom?token=x')
  })

  it('does not send or retry after a missing upload confirmation', async () => {
    let calls = 0
    globalThis.fetch = (async () => ++calls === 1 ? Response.json({ upload_param: 'p' }) : new Response('')) as typeof fetch
    await expect(sendWechatMedia({ ...base, kind: 'file' })).rejects.toThrow('did not confirm')
    expect(calls).toBe(2)
  })

  it('rechecks the conversation after upload before sending its media reference', async () => {
    let calls = 0
    globalThis.fetch = (async () => ++calls === 1 ? Response.json({ upload_param: 'p' }) : new Response('', { headers: { 'x-encrypted-param': 'download' } })) as typeof fetch
    await expect(sendWechatMedia({ ...base, kind: 'file', beforeSend: () => { throw new Error('authorization revoked') } })).rejects.toThrow('authorization revoked')
    expect(calls).toBe(2)
  })

  it('does not resend an ambiguously delivered message', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) return Response.json({ upload_param: 'p' })
      if (calls === 2) return new Response('', { headers: { 'x-encrypted-param': 'download' } })
      throw new TypeError('connection lost after submission')
    }) as typeof fetch
    await expect(sendWechatMedia({ ...base, kind: 'file' })).rejects.toThrow('connection lost')
    expect(calls).toBe(3)
  })

  it('rejects a business error even when ret is zero and redacts response details', async () => {
    globalThis.fetch = (async () => Response.json({ ret: 0, errcode: 401, errmsg: 'secret URL or token' })) as typeof fetch
    await expect(sendWechatMedia({ ...base, kind: 'file' })).rejects.toThrow('getuploadurl returned 401')
  })

  it('rejects invalid API JSON rather than treating it as success', async () => {
    globalThis.fetch = (async () => new Response('<html>unavailable</html>')) as typeof fetch
    await expect(sendWechatMedia({ ...base, kind: 'file' })).rejects.toThrow('invalid JSON')
  })

  it('rejects untrusted upload endpoints before posting bytes', async () => {
    let calls = 0
    globalThis.fetch = (async () => { calls++; return Response.json({ upload_full_url: 'http://127.0.0.1/private' }) }) as typeof fetch
    await expect(sendWechatMedia({ ...base, kind: 'file' })).rejects.toThrow('Untrusted')
    expect(calls).toBe(1)
  })

  it('rejects oversized images and already cancelled jobs before network access', async () => {
    globalThis.fetch = (() => { throw new Error('network must not run') }) as typeof fetch
    await expect(sendWechatMedia({ ...base, kind: 'image', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) })).rejects.toThrow('图片过大')
    await expect(sendWechatMedia({ ...base, kind: 'file', signal: AbortSignal.abort() })).rejects.toHaveProperty('name', 'AbortError')
  })
})
