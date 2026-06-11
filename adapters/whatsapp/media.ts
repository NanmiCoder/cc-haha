import * as path from 'node:path'
import {
  downloadMediaMessage,
  normalizeMessageContent,
  type WAMessage,
  type proto,
} from '@whiskeysockets/baileys'
import type { WhatsAppSocket } from './session.js'
import { AttachmentStore } from '../common/attachment/attachment-store.js'
import type { LocalAttachment } from '../common/attachment/attachment-types.js'

function unwrapMessage(message: proto.IMessage | undefined): proto.IMessage | undefined {
  return normalizeMessageContent(message)
}

function resolveMediaMime(message: proto.IMessage): string | undefined {
  return message.imageMessage?.mimetype
    ?? message.videoMessage?.mimetype
    ?? message.documentMessage?.mimetype
    ?? message.audioMessage?.mimetype
    ?? message.stickerMessage?.mimetype
    ?? (message.audioMessage ? 'audio/ogg; codecs=opus' : undefined)
    ?? (message.imageMessage ? 'image/jpeg' : undefined)
    ?? (message.videoMessage ? 'video/mp4' : undefined)
    ?? (message.stickerMessage ? 'image/webp' : undefined)
}

function resolveMediaName(message: proto.IMessage, mimeType: string): string {
  const explicit = message.documentMessage?.fileName
  if (explicit?.trim()) return path.basename(explicit)
  if (message.imageMessage) return `whatsapp-image.${extensionForMime(mimeType, 'jpg')}`
  if (message.videoMessage) return `whatsapp-video.${extensionForMime(mimeType, 'mp4')}`
  if (message.audioMessage) return `whatsapp-audio.${extensionForMime(mimeType, 'ogg')}`
  if (message.stickerMessage) return `whatsapp-sticker.${extensionForMime(mimeType, 'webp')}`
  return `whatsapp-file.${extensionForMime(mimeType, 'bin')}`
}

function extensionForMime(mimeType: string, fallback: string): string {
  const normalized = mimeType.split(';')[0]!.trim().toLowerCase()
  switch (normalized) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    case 'video/mp4':
      return 'mp4'
    case 'audio/ogg':
      return 'ogg'
    case 'audio/mpeg':
      return 'mp3'
    case 'application/pdf':
      return 'pdf'
    default:
      return fallback
  }
}

export class WhatsAppMediaService {
  constructor(
    private sock: WhatsAppSocket,
    private store: AttachmentStore,
  ) {}

  async downloadMessageMedia(message: proto.IWebMessageInfo, sessionId: string): Promise<LocalAttachment | null> {
    const content = unwrapMessage(message.message as proto.IMessage | undefined)
    if (!content) return null
    const hasMedia = Boolean(
      content.imageMessage ||
      content.videoMessage ||
      content.documentMessage ||
      content.audioMessage ||
      content.stickerMessage,
    )
    if (!hasMedia) return null

    const mimeType = resolveMediaMime(content) ?? 'application/octet-stream'
    const buffer = await downloadMediaMessage(
      message as WAMessage,
      'buffer',
      {},
      {
        reuploadRequest: this.sock.updateMediaMessage,
        logger: this.sock.logger,
      },
    ) as Buffer
    const kind = mimeType.startsWith('image/') ? 'image' : 'file'
    const name = resolveMediaName(content, mimeType)
    const target = this.store.resolvePath('whatsapp', sessionId, name)
    await this.store.write(target, buffer)
    return {
      kind,
      name,
      path: target,
      size: buffer.length,
      mimeType,
      buffer,
    }
  }

  async sendMedia(jid: string, buffer: Buffer, mimeType: string, caption?: string, fileName?: string): Promise<void> {
    if (mimeType.startsWith('image/')) {
      await this.sock.sendMessage(jid, { image: buffer, caption, mimetype: mimeType })
      return
    }
    if (mimeType.startsWith('video/')) {
      await this.sock.sendMessage(jid, { video: buffer, caption, mimetype: mimeType })
      return
    }
    if (mimeType.startsWith('audio/')) {
      const effective = mimeType === 'audio/ogg' ? 'audio/ogg; codecs=opus' : mimeType
      await this.sock.sendMessage(jid, { audio: buffer, ptt: true, mimetype: effective })
      return
    }
    await this.sock.sendMessage(jid, {
      document: buffer,
      fileName: fileName || 'file',
      caption,
      mimetype: mimeType || 'application/octet-stream',
    })
  }
}
