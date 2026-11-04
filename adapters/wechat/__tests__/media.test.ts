import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AttachmentStore } from '../../common/attachment/attachment-store.js'
import { collectWechatMediaCandidates, WechatMediaService, wechatMediaFailureNotice, wechatMediaDownloadHost } from '../media.js'
import { assertWechatMediaUrl, fetchWechatMediaResource } from '../media-network.js'

const originalFetch = globalThis.fetch
let temp: string
beforeEach(async () => { temp = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-media-test-')) })
afterEach(async () => { globalThis.fetch = originalFetch; await fs.rm(temp, { recursive: true, force: true }) })

describe('WeChat media downloads', () => {
  it('decrypts an image with a colon-bearing message ID into a visible regular file', async () => {
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const plaintext = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const [candidate] = collectWechatMediaCandidates([{ type: 2, msg_id: 'v1:fixture:image', image_item: {
      aeskey: key.toString('hex'), media: { encrypt_query_param: 'fixture' },
    } }])
    globalThis.fetch = (async () => new Response(encrypted)) as typeof fetch
    const result = await new WechatMediaService(new AttachmentStore({ root: temp })).downloadCandidate(candidate!, 'session')
    expect(path.basename(result.path)).toBe('wechat-image-v1_fixture_image.jpg')
    expect((await fs.stat(result.path)).size).toBe(plaintext.length)
    expect(await fs.readFile(result.path)).toEqual(plaintext)
    expect(await fs.readdir(path.dirname(result.path))).toEqual([path.basename(result.path)])
  })

  it('reports an HTTP download failure without leaking a signed URL or response body', async () => {
    const candidate = { kind: 'image' as const, name: 'image.jpg', url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?secret=signed-fixture' }
    globalThis.fetch = (async () => new Response('private response', { status: 403 })) as typeof fetch
    const service = new WechatMediaService(new AttachmentStore({ root: temp }))
    let failure: unknown
    try { await service.downloadCandidate(candidate, 's') } catch (error) { failure = error }
    expect(wechatMediaFailureNotice(failure)).toContain('HTTP 403')
    expect(wechatMediaFailureNotice(failure)).not.toContain('private')
    expect(wechatMediaFailureNotice(failure)).not.toContain('secret')
    expect(wechatMediaDownloadHost(candidate)).toBe('novac2c.cdn.weixin.qq.com')
    expect(await fs.readdir(temp)).toEqual([])
  })

  it('distinguishes address validation, decryption and local saving failures', async () => {
    const store = new AttachmentStore({ root: temp })
    const service = new WechatMediaService(store)
    await expect(service.downloadCandidate({ kind: 'image', name: 'image.jpg', url: 'https://unknown.invalid/secret' }, 's')).rejects.toThrow('媒体地址未通过校验')
    globalThis.fetch = (async () => new Response('fixture')) as typeof fetch
    await expect(service.downloadCandidate({ kind: 'image', name: 'image.jpg', aesKey: 'invalid-key', encryptQueryParam: 'fixture' }, 's')).rejects.toThrow('解密失败')
    store.write = async () => { throw Object.assign(new Error('private path'), { code: 'ENOSPC' }) }
    await expect(service.downloadCandidate({ kind: 'image', name: 'image.jpg', encryptQueryParam: 'fixture' }, 's')).rejects.toThrow('磁盘空间不足')
    expect(wechatMediaFailureNotice(new Error('secret'))).not.toContain('secret')
  })

  it('receives encrypted video through the existing file attachment contract', async () => {
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const plaintext = Buffer.from('video fixture')
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const [candidate] = collectWechatMediaCandidates([{ type: 5, msg_id: 'v1', video_item: { media: { encrypt_query_param: 'opaque+/=', aes_key: Buffer.from(key.toString('hex')).toString('base64') } } }])
    expect(candidate).toMatchObject({ kind: 'file', mediaKind: 'video', mimeType: 'video/mp4' })
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe('https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=opaque%2B%2F%3D')
      expect(init?.redirect).toBe('error')
      return new Response(encrypted)
    }) as typeof fetch
    const result = await new WechatMediaService(new AttachmentStore({ root: temp })).downloadCandidate(candidate!, 'session')
    expect(result).toMatchObject({ kind: 'file', mimeType: 'video/mp4', name: 'wechat-video-v1.mp4' })
    expect(await fs.readFile(result.path)).toEqual(plaintext)
  })

  it('rejects claimed oversized files before downloading or writing', async () => {
    globalThis.fetch = (() => { throw new Error('must not download') }) as typeof fetch
    const service = new WechatMediaService(new AttachmentStore({ root: temp }))
    await expect(service.downloadCandidate({ kind: 'file', name: 'huge.bin', declaredBytes: 31 * 1024 * 1024 }, 's')).rejects.toThrow('文件过大')
    expect(await fs.readdir(temp)).toEqual([])
  })

  it('bounds streamed bytes even with no Content-Length and cancels the stream', async () => {
    let cancelled = false
    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(8)) },
      cancel() { cancelled = true },
    }))) as typeof fetch
    await expect(fetchWechatMediaResource({ url: 'https://novac2c.cdn.weixin.qq.com/c2c/download', service: 'cdn', maxBytes: 10 })).rejects.toThrow('size limit')
    expect(cancelled).toBe(true)
  })

  it('times out a stalled response body', async () => {
    globalThis.fetch = (async () => new Response(new ReadableStream({ start() {} }))) as typeof fetch
    await expect(fetchWechatMediaResource({ url: 'https://novac2c.cdn.weixin.qq.com/c2c/download', service: 'cdn', maxBytes: 10, timeoutMs: 5 })).rejects.toHaveProperty('name', 'TimeoutError')
  })

  it('cancels an in-progress download', async () => {
    const controller = new AbortController()
    globalThis.fetch = (async () => new Response(new ReadableStream({ start() { queueMicrotask(() => controller.abort()) } }))) as typeof fetch
    await expect(fetchWechatMediaResource({ url: 'https://novac2c.cdn.weixin.qq.com/c2c/download', service: 'cdn', maxBytes: 10, signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError')
  })

  it('rejects private, lookalike, credential-bearing and non-HTTPS URLs', () => {
    for (const url of ['https://127.0.0.1/file', 'https://novac2c.cdn.weixin.qq.com.evil.test/file', 'http://novac2c.cdn.weixin.qq.com/file', 'https://user@novac2c.cdn.weixin.qq.com/file', 'https://novac2c.cdn.weixin.qq.com:1234/file']) {
      expect(() => assertWechatMediaUrl(url, 'cdn')).toThrow('Untrusted')
    }
  })
})
