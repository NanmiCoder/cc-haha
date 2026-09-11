import crypto from 'node:crypto'
import { AttachmentStore } from '../common/attachment/attachment-store.js'
import type { LocalAttachment } from '../common/attachment/attachment-types.js'
import type { WechatMessageItem } from './protocol.js'

type WechatMediaCandidate = {
  kind: 'image' | 'file'
  name: string
  mimeType?: string
  url?: string
  encryptQueryParam?: string
  aesKey?: string
}

const DEFAULT_CDN_BASE_URL = 'https://findermp.video.qq.com/251/20304/stodownload'

export function collectWechatMediaCandidates(items?: WechatMessageItem[]): WechatMediaCandidate[] {
  const candidates: WechatMediaCandidate[] = []
  for (const item of items ?? []) {
    if (item.type === 2 && item.image_item?.media) {
      const media = item.image_item.media
      const messageId = String(item.msg_id ?? Date.now()).replaceAll(':', '_')
      candidates.push({
        kind: 'image',
        name: `wechat-image-${messageId}.jpg`,
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
  ): Promise<LocalAttachment> {
    const encrypted = await fetchWechatMediaBytes(candidate)
    const buffer = candidate.aesKey ? decryptAesEcb(encrypted, parseAesKey(candidate.aesKey)) : encrypted
    const target = this.store.resolvePath('wechat', sessionId, candidate.name)
    const path = await this.store.write(target, buffer)
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

async function fetchWechatMediaBytes(candidate: WechatMediaCandidate): Promise<Buffer> {
  const url = candidate.url || buildCdnDownloadUrl(candidate.encryptQueryParam)
  if (!url) throw new Error('WeChat media item is missing a download URL')
  const resp = await fetch(url)
  if (!resp.ok) {
    throw new Error(`WeChat media download failed: ${resp.status} ${resp.statusText}`)
  }
  return Buffer.from(await resp.arrayBuffer())
}

function buildCdnDownloadUrl(encryptQueryParam?: string): string | null {
  if (!encryptQueryParam) return null
  return `${DEFAULT_CDN_BASE_URL}?${encryptQueryParam}`
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
  return undefined
}
