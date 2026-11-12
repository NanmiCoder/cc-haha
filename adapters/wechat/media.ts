import crypto from 'node:crypto'
import { AttachmentStore } from '../common/attachment/attachment-store.js'
import type { LocalAttachment } from '../common/attachment/attachment-types.js'
import type { WechatMessageItem } from './protocol.js'
import { checkAttachmentLimit, IMAGE_MAX_BYTES, FILE_MAX_BYTES } from '../common/attachment/attachment-limits.js'
import { fetchWechatMediaResource } from './media-network.js'

export type WechatMediaCandidate = {
  kind: 'image' | 'file'
  mediaKind?: 'video'
  name: string
  mimeType?: string
  url?: string
  encryptQueryParam?: string
  aesKey?: string
  declaredBytes?: number
}

const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c/download'

/** Keep diagnostics actionable without exposing signed URLs, keys or file paths. */
export class WechatMediaDownloadError extends Error {
  constructor(readonly stage: 'download' | 'decrypt' | 'save', readonly detail: string) {
    super(`附件${stage === 'download' ? '下载' : stage === 'decrypt' ? '解密' : '保存'}失败：${detail}`)
    this.name = 'WechatMediaDownloadError'
  }
}

function downloadFailure(error: unknown, stage: 'download' | 'decrypt' | 'save'): WechatMediaDownloadError {
  const message = error instanceof Error ? error.message : ''
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  const status = /^WeChat media HTTP (\d{3})$/.exec(message)?.[1]
  let detail = '处理异常，请查看桌面诊断后重发'
  if (stage === 'decrypt') detail = '微信图片或文件的加密数据未能解码，请重发附件'
  else if (stage === 'save') detail = code === 'ENOSPC' ? '电脑磁盘空间不足' : '电脑未能写入附件缓存，请检查目录权限和可用空间'
  else if (message === 'Untrusted WeChat media URL') detail = '微信返回的媒体地址未通过校验'
  else if (message === 'Invalid WeChat media URL' || message.includes('missing a download URL')) detail = '微信消息缺少有效媒体地址'
  else if (message.includes('size limit')) detail = '附件超过大小上限'
  else if (status) detail = `微信媒体服务返回 HTTP ${status}`
  else if (error instanceof Error && error.name === 'TimeoutError') detail = '连接微信媒体服务超时'
  else if (/CERT|TLS|SSL/.test(code)) detail = '微信媒体服务的安全连接失败'
  else if (['ENOTFOUND', 'EAI_AGAIN', 'DNS_RESOLUTION_FAILED'].includes(code)) detail = '无法解析微信媒体服务器地址'
  else if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ConnectionRefused', 'ConnectionClosed'].includes(code)) detail = '无法连接微信媒体服务，请检查电脑网络或代理'
  return new WechatMediaDownloadError(stage, detail)
}

export function wechatMediaFailureNotice(error: unknown): string {
  return error instanceof WechatMediaDownloadError ? error.message : '附件处理失败，请检查大小限制后重发'
}

export function wechatMediaDownloadHost(candidate: WechatMediaCandidate): string {
  try { return new URL(candidate.url || DEFAULT_CDN_BASE_URL).hostname } catch { return 'invalid' }
}

export function collectWechatMediaCandidates(items?: WechatMessageItem[]): WechatMediaCandidate[] {
  const candidates: WechatMediaCandidate[] = []
  for (const item of items ?? []) {
    if (item.type === 2 && item.image_item?.media) {
      const media = item.image_item.media
      candidates.push({
        kind: 'image',
        name: `wechat-image-${item.msg_id ?? Date.now()}.jpg`,
        mimeType: 'image/jpeg',
        url: media.full_url || item.image_item.url,
        encryptQueryParam: media.encrypt_query_param,
        aesKey: item.image_item.aeskey
          ? Buffer.from(item.image_item.aeskey, 'hex').toString('base64')
          : media.aes_key,
      })
    } else if (item.type === 4 && item.file_item?.media) {
      const media = item.file_item.media
      candidates.push({
        kind: 'file',
        name: item.file_item.file_name || `wechat-file-${item.msg_id ?? Date.now()}`,
        mimeType: inferMime(item.file_item.file_name),
        url: media.full_url,
        encryptQueryParam: media.encrypt_query_param,
        aesKey: media.aes_key,
        declaredBytes: item.file_item.len ? Number(item.file_item.len) : undefined,
      })
    } else if (item.type === 5 && item.video_item?.media) {
      const media = item.video_item.media
      candidates.push({
        kind: 'file',
        mediaKind: 'video',
        name: `wechat-video-${item.msg_id ?? Date.now()}.mp4`,
        mimeType: 'video/mp4',
        url: media.full_url,
        encryptQueryParam: media.encrypt_query_param,
        aesKey: media.aes_key,
      })
    }
  }
  return candidates
}

export class WechatMediaService {
  constructor(private readonly store: AttachmentStore) {}

  async downloadCandidate(
    candidate: WechatMediaCandidate,
    sessionId: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<LocalAttachment> {
    if (candidate.declaredBytes !== undefined) {
      if (!Number.isFinite(candidate.declaredBytes) || candidate.declaredBytes < 0) throw new Error('Invalid WeChat attachment size')
      const limit = checkAttachmentLimit(candidate.kind, candidate.declaredBytes, candidate.mimeType)
      if (!limit.ok) throw new Error(limit.hint)
    }
    let encrypted: Buffer
    try { encrypted = await fetchWechatMediaBytes(candidate, options) } catch (error) {
      options.signal?.throwIfAborted()
      throw downloadFailure(error, 'download')
    }
    let buffer: Buffer
    try { buffer = candidate.aesKey ? decryptAesEcb(encrypted, parseAesKey(candidate.aesKey)) : encrypted } catch (error) {
      throw downloadFailure(error, 'decrypt')
    }
    const limit = checkAttachmentLimit(candidate.kind, buffer.length, candidate.mimeType)
    if (!limit.ok) throw new Error(limit.hint)
    options.signal?.throwIfAborted()
    let path: string
    try {
      const target = this.store.resolvePath('wechat', sessionId, candidate.name)
      path = await this.store.write(target, buffer)
    } catch (error) { throw downloadFailure(error, 'save') }
    return {
      kind: candidate.kind,
      name: candidate.name,
      path,
      buffer,
      size: buffer.length,
      mimeType: candidate.mimeType ?? (candidate.kind === 'image' ? 'image/jpeg' : 'application/octet-stream'),
    }
  }
}

async function fetchWechatMediaBytes(candidate: WechatMediaCandidate, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<Buffer> {
  const url = candidate.url || buildCdnDownloadUrl(candidate.encryptQueryParam)
  if (!url) throw new Error('WeChat media item is missing a download URL')
  const resp = await fetchWechatMediaResource({
    url,
    service: 'cdn',
    maxBytes: (candidate.kind === 'image' ? IMAGE_MAX_BYTES : FILE_MAX_BYTES) + (candidate.aesKey ? 16 : 0),
    ...options,
  })
  return resp.bytes
}

function buildCdnDownloadUrl(encryptQueryParam?: string): string | null {
  if (!encryptQueryParam) return null
  return `${DEFAULT_CDN_BASE_URL}?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`
}

function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new Error(`WeChat AES key must decode to 16 bytes, got ${decoded.length}`)
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function inferMime(fileName?: string): string | undefined {
  const ext = fileName?.split('.').pop()?.toLowerCase()
  if (!ext) return undefined
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'pdf') return 'application/pdf'
  if (ext === 'txt') return 'text/plain'
  if (ext === 'mp4') return 'video/mp4'
  if (ext === 'webm') return 'video/webm'
  if (ext === 'mov') return 'video/quicktime'
  if (ext === 'mp3') return 'audio/mpeg'
  if (ext === 'wav') return 'audio/wav'
  return undefined
}
