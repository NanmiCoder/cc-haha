/**
 * Enterprise WeChat inbound media.
 *
 * WeCom hands the bot an encrypted CDN URL plus a per-download AES key; the
 * SDK's `downloadFile` does the fetch and the decryption. This module only
 * decides *what* to download (from a message body) and where to stage it, so
 * the extraction rules can be tested without a live WebSocket client.
 */

import type { AttachmentStore } from '../common/attachment/attachment-store.js'
import type { LocalAttachment } from '../common/attachment/attachment-types.js'
import { attachmentKindForMime, inferMimeFromFileName } from '../common/attachment/mime.js'

export type WecomMediaCandidate = {
  kind: 'image' | 'file'
  /** Fallback name; the real one may arrive with the download. */
  name: string
  url: string
  aesKey?: string
  mimeType?: string
}

type WecomMediaBody = {
  msgid?: string
  msgtype?: string
  image?: { url?: string; aeskey?: string }
  file?: { url?: string; aeskey?: string }
  mixed?: { msg_item?: Array<{ msgtype?: string; image?: { url?: string; aeskey?: string } }> }
  /** Listed so the deliberate omission is visible: WeCom delivers voice notes
   *  already transcribed, so they belong in the text path, not here. */
  voice?: { content?: string }
}

export type WecomDownload = (
  url: string,
  aesKey?: string,
) => Promise<{ buffer: Buffer; filename?: string }>

function imageCandidate(
  media: { url?: string; aeskey?: string } | undefined,
  seed: string,
): WecomMediaCandidate | null {
  if (!media?.url) return null
  return {
    kind: 'image',
    name: `wecom-image-${seed}.jpg`,
    url: media.url,
    aesKey: media.aeskey,
    mimeType: 'image/jpeg',
  }
}

/**
 * Downloadable attachments carried by one inbound message.
 *
 * Voice messages are deliberately absent: WeCom delivers them already
 * transcribed as `voice.content`, so they belong in the text path, not here.
 */
export function collectWecomMediaCandidates(body: WecomMediaBody | undefined): WecomMediaCandidate[] {
  if (!body) return []
  const seed = body.msgid || String(Date.now())
  const candidates: WecomMediaCandidate[] = []

  const image = imageCandidate(body.image, seed)
  if (image) candidates.push(image)

  if (body.file?.url) {
    candidates.push({
      kind: 'file',
      name: `wecom-file-${seed}`,
      url: body.file.url,
      aesKey: body.file.aeskey,
    })
  }

  body.mixed?.msg_item?.forEach((item, index) => {
    if (item.msgtype !== 'image') return
    const mixedImage = imageCandidate(item.image, `${seed}-${index}`)
    if (mixedImage) candidates.push(mixedImage)
  })

  return candidates
}

export class WecomMediaService {
  constructor(
    private readonly store: AttachmentStore,
    private readonly download: WecomDownload,
  ) {}

  async downloadCandidate(
    candidate: WecomMediaCandidate,
    sessionId: string,
  ): Promise<LocalAttachment> {
    const { buffer, filename } = await this.download(candidate.url, candidate.aesKey)
    const name = filename?.trim() || candidate.name
    const mimeType = candidate.mimeType
      ?? inferMimeFromFileName(name)
      ?? (candidate.kind === 'image' ? 'image/jpeg' : 'application/octet-stream')
    const target = this.store.resolvePath('wecom', sessionId, name)
    const path = await this.store.write(target, buffer)
    return {
      // Trust the resolved MIME over the candidate's guess: a `file` message
      // carrying a .png is an image to the Agent, and the limits differ.
      kind: attachmentKindForMime(mimeType),
      name,
      path,
      buffer,
      size: buffer.length,
      mimeType,
    }
  }
}
