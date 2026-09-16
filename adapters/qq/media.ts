/**
 * QQ inbound media download.
 *
 * QQ delivers attachments as CDN URLs that are already signed, and often with
 * the scheme omitted (`multimedia.nt.qq.com.cn/...`). This module normalizes
 * those URLs, refuses anything that is not a plain HTTPS fetch, and stages the
 * bytes under the shared attachment store.
 */

import type { AttachmentStore } from '../common/attachment/attachment-store.js'
import type { LocalAttachment } from '../common/attachment/attachment-types.js'
import {
  attachmentKindForMime,
  imageExtensionForMime,
  inferMimeFromFileName,
} from '../common/attachment/mime.js'
import type { QqInboundAttachment } from './extract-payload.js'

const DOWNLOAD_TIMEOUT_MS = 30_000

/**
 * Force a QQ attachment reference onto HTTPS.
 *
 * Returns null for anything that is not a host/path URL — QQ has no reason to
 * hand us a `file:` or credentialed URL, and fetching one would be an SSRF
 * primitive driven by remote input.
 */
export function normalizeQqAttachmentUrl(raw: string | undefined): URL | null {
  const value = raw?.trim()
  if (!value) return null
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password) return null
  // QQ CDN serves plain HTTP for some resources; upgrade rather than refuse.
  url.protocol = 'https:'
  return url
}

function fileNameFor(attachment: QqInboundAttachment, mime: string | undefined, seed: string): string {
  const provided = attachment.filename?.trim()
  if (provided) return provided
  if (mime?.startsWith('image/')) return `qq-image-${seed}.${imageExtensionForMime(mime)}`
  return `qq-file-${seed}`
}

export class QqMediaService {
  constructor(
    private readonly store: AttachmentStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async downloadAttachment(
    attachment: QqInboundAttachment,
    sessionId: string,
    seed: string,
  ): Promise<LocalAttachment> {
    const url = normalizeQqAttachmentUrl(attachment.url)
    if (!url) throw new Error('QQ attachment has no usable download URL')

    const response = await this.fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`QQ attachment download failed: ${response.status} ${response.statusText}`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())

    const headerMime = response.headers.get('content-type')?.split(';')[0]?.trim()
    const mimeType = attachment.content_type?.split(';')[0]?.trim()
      || headerMime
      || inferMimeFromFileName(attachment.filename)
      || 'application/octet-stream'
    const name = fileNameFor(attachment, mimeType, seed)

    const target = this.store.resolvePath('qq', sessionId, name)
    const path = await this.store.write(target, buffer)

    return {
      kind: attachmentKindForMime(mimeType),
      name,
      path,
      buffer,
      size: buffer.length,
      mimeType,
    }
  }
}
