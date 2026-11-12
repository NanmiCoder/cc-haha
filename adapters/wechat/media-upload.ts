import crypto from 'node:crypto'
import { checkAttachmentLimit } from '../common/attachment/attachment-limits.js'
import { requestWechatMediaApi } from './protocol.js'
import { fetchWechatMediaResource } from './media-network.js'

/** Official wire shapes: Tencent/openclaw-weixin src/cdn/upload.ts and src/messaging/send.ts. */
export async function sendWechatMedia(params: {
  baseUrl: string
  token: string
  to: string
  contextToken?: string
  kind: 'image' | 'file' | 'video'
  buffer: Buffer
  fileName: string
  mimeType?: string
  clientId?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** Recheck conversation authorization after the potentially long upload. */
  beforeSend?: () => void
}): Promise<void> {
  params.signal?.throwIfAborted()
  const limit = checkAttachmentLimit(params.kind === 'image' ? 'image' : 'file', params.buffer.length, params.mimeType)
  if (!limit.ok) throw new Error(limit.hint)
  if (!params.buffer.length) throw new Error('Cannot send an empty WeChat attachment')
  const key = crypto.randomBytes(16)
  const fileKey = crypto.randomBytes(16).toString('hex')
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
  const encrypted = Buffer.concat([cipher.update(params.buffer), cipher.final()])
  const request = { baseUrl: params.baseUrl, token: params.token, timeoutMs: params.timeoutMs, signal: params.signal }
  const upload = await requestWechatMediaApi({
    ...request,
    endpoint: 'getuploadurl',
    payload: {
      filekey: fileKey,
      media_type: params.kind === 'image' ? 1 : params.kind === 'video' ? 2 : 3,
      to_user_id: params.to,
      rawsize: params.buffer.length,
      rawfilemd5: crypto.createHash('md5').update(params.buffer).digest('hex'),
      filesize: encrypted.length,
      no_need_thumb: true,
      aeskey: key.toString('hex'),
    },
  })
  const fullUrl = typeof upload.upload_full_url === 'string' ? upload.upload_full_url.trim() : ''
  const uploadParam = typeof upload.upload_param === 'string' ? upload.upload_param : ''
  if (!fullUrl && !uploadParam) throw new Error('WeChat upload URL is missing')
  const fallback = new URL('https://novac2c.cdn.weixin.qq.com/c2c/upload')
  fallback.searchParams.set('encrypted_query_param', uploadParam)
  fallback.searchParams.set('filekey', fileKey)
  const uploaded = await fetchWechatMediaResource({
    url: fullUrl || fallback.toString(),
    service: 'cdn',
    init: { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(encrypted) },
    maxBytes: 64 * 1024,
    timeoutMs: params.timeoutMs ?? 60_000,
    signal: params.signal,
  })
  const downloadParam = uploaded.headers.get('x-encrypted-param')
  if (uploaded.status !== 200 || !downloadParam?.trim()) throw new Error('WeChat CDN did not confirm the upload')
  const media = {
    encrypt_query_param: downloadParam,
    // The official sender encodes the ASCII hex key, not its 16 raw bytes.
    aes_key: Buffer.from(key.toString('hex')).toString('base64'),
    encrypt_type: 1,
  }
  const item = params.kind === 'image'
    ? { type: 2, image_item: { media, mid_size: encrypted.length } }
    : params.kind === 'video'
      ? { type: 5, video_item: { media, video_size: encrypted.length } }
      : { type: 4, file_item: { media, file_name: params.fileName, len: String(params.buffer.length) } }
  // No automatic retry: a timeout may mean WeChat accepted the message already.
  params.signal?.throwIfAborted()
  params.beforeSend?.()
  await requestWechatMediaApi({
    ...request,
    endpoint: 'sendmessage',
    payload: {
      msg: {
        from_user_id: '', to_user_id: params.to,
        client_id: params.clientId ?? `claude-code-haha-wechat-${crypto.randomUUID()}`,
        message_type: 2, message_state: 2,
        context_token: params.contextToken,
        item_list: [item],
      },
    },
  })
}
