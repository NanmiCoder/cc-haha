/**
 * Telegram media service — wraps grammY download/upload helpers.
 *
 * Telegram file download flow:
 *   1. bot.api.getFile(file_id)  → { file_path }
 *   2. GET https://api.telegram.org/file/bot<token>/<file_path>
 */

import { InputFile, type Bot } from 'grammy'
import { AttachmentStore } from '../common/attachment/attachment-store.js'
import type { LocalAttachment } from '../common/attachment/attachment-types.js'

function extOf(fileName?: string): string {
  if (!fileName) return ''
  const m = /\.([^./\\]+)$/.exec(fileName)
  return m ? m[1]!.toLowerCase() : ''
}

function classifyKind(mime: string | undefined, fileName: string): 'image' | 'file' {
  if (mime?.startsWith('image/')) return 'image'
  const ext = extOf(fileName)
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'].includes(ext)) return 'image'
  return 'file'
}

export interface DownloadHint {
  fileName?: string
  mimeType?: string
}

export class TelegramMediaService {
  constructor(
    private readonly bot: Bot,
    private readonly store: AttachmentStore,
  ) {}

  async downloadFile(
    fileId: string,
    sessionId: string,
    hint: DownloadHint = {},
  ): Promise<LocalAttachment> {
    const file = await this.bot.api.getFile(fileId)
    if (!file.file_path) {
      throw new Error(`[TelegramMedia] getFile returned no file_path for ${fileId}`)
    }
    const token = (this.bot as unknown as { token: string }).token
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
    const resp = await fetch(url)
    if (!resp.ok) {
      throw new Error(`[TelegramMedia] fetch failed: ${resp.status} ${resp.statusText}`)
    }
    const buffer = Buffer.from(await resp.arrayBuffer())
    const mime = hint.mimeType ?? resp.headers.get('content-type') ?? undefined
    const fallbackName = file.file_path.split('/').pop() || fileId
    const name = hint.fileName ?? fallbackName
    const kind = classifyKind(mime, name)
    const target = this.store.resolvePath('telegram', sessionId, name)
    await this.store.write(target, buffer)
    return {
      kind,
      name,
      path: target,
      size: buffer.length,
      mimeType: mime ?? (kind === 'image' ? 'image/png' : 'application/octet-stream'),
      buffer,
    }
  }

  async sendPhoto(chatId: number, buffer: Buffer, caption?: string): Promise<void> {
    await this.bot.api.sendPhoto(
      chatId,
      new InputFile(buffer),
      caption ? { caption } : undefined,
    )
  }

  async sendDocument(
    chatId: number,
    buffer: Buffer,
    fileName: string,
    caption?: string,
  ): Promise<void> {
    await this.bot.api.sendDocument(
      chatId,
      new InputFile(buffer, fileName),
      caption ? { caption } : undefined,
    )
  }
}
