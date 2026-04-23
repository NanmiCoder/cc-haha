/**
 * Feishu media service — wraps im.messageResource / im.image / im.file
 * so adapters/feishu/index.ts stays focused on flow control.
 *
 * References:
 *  - Feishu OpenAPI:   POST /open-apis/im/v1/images
 *                      POST /open-apis/im/v1/files
 *                      GET  /open-apis/im/v1/messages/{message_id}/resources/{file_key}
 *  - OpenClaw impl:    openclaw-lark/src/messaging/outbound/media.ts:226,281,323,423,454
 */

import * as Lark from '@larksuiteoapi/node-sdk'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { AttachmentStore } from '../common/attachment/attachment-store.js'
import type { LocalAttachment } from '../common/attachment/attachment-types.js'

type LarkClient = InstanceType<typeof Lark.Client>

/** Map a filename extension to Feishu's file_type enum. */
function detectFeishuFileType(
  fileName: string,
): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  const ext = path.extname(fileName).toLowerCase().replace(/^\./, '')
  switch (ext) {
    case 'opus':
      return 'opus'
    case 'mp4':
      return 'mp4'
    case 'pdf':
      return 'pdf'
    case 'doc':
    case 'docx':
      return 'doc'
    case 'xls':
    case 'xlsx':
      return 'xls'
    case 'ppt':
    case 'pptx':
      return 'ppt'
    default:
      return 'stream'
  }
}

function guessMime(fileName: string, kind: 'image' | 'file'): string {
  const ext = path.extname(fileName).toLowerCase().replace(/^\./, '')
  if (kind === 'image') {
    return (
      ({
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        heic: 'image/heic',
      } as Record<string, string>)[ext] || 'image/png'
    )
  }
  return (
    ({
      pdf: 'application/pdf',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      txt: 'text/plain',
      json: 'application/json',
    } as Record<string, string>)[ext] || 'application/octet-stream'
  )
}

export interface DownloadParams {
  messageId: string
  fileKey: string
  kind: 'image' | 'file'
  fileName?: string
  sessionId: string
}

export class FeishuMediaService {
  constructor(
    private readonly client: LarkClient,
    private readonly store: AttachmentStore,
  ) {}

  /** Download an image or file the user sent in Feishu into the local stage. */
  async downloadResource(params: DownloadParams): Promise<LocalAttachment> {
    const { messageId, fileKey, kind, sessionId } = params
    const fallbackName = `${fileKey}${kind === 'image' ? '.png' : ''}`
    const name = params.fileName || fallbackName
    const target = this.store.resolvePath('feishu', sessionId, name)

    // node-sdk returns an object with a `.writeFile(target)` helper
    // that dumps the underlying stream. See OpenClaw media.ts:147 and :237.
    const resp: any = await (this.client.im as any).messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: kind },
    })

    if (typeof resp?.writeFile === 'function') {
      await resp.writeFile(target)
    } else if (resp?.data instanceof Buffer) {
      await this.store.write(target, resp.data)
    } else if (resp instanceof Buffer) {
      await this.store.write(target, resp)
    } else {
      throw new Error('[FeishuMedia] Unknown downloadResource response shape')
    }

    const buffer = await fs.readFile(target)
    return {
      kind,
      name,
      path: target,
      size: buffer.length,
      mimeType: guessMime(name, kind),
      buffer,
    }
  }

  /** Upload an image buffer, returns image_key.
   *  The Lark node-sdk type for `image` accepts `Buffer | ReadStream`,
   *  so passing the buffer directly is the simplest path. */
  async uploadImage(buffer: Buffer, _mime: string): Promise<string> {
    const resp: any = await this.client.im.image.create({
      data: {
        image_type: 'message',
        image: buffer,
      },
    })
    const key = resp?.data?.image_key
    if (!key) throw new Error('[FeishuMedia] uploadImage: missing image_key')
    return key
  }

  /** Upload a non-image file, returns file_key. */
  async uploadFile(buffer: Buffer, fileName: string): Promise<string> {
    const resp: any = await this.client.im.file.create({
      data: {
        file_type: detectFeishuFileType(fileName),
        file_name: fileName,
        file: buffer,
      },
    })
    const key = resp?.data?.file_key
    if (!key) throw new Error('[FeishuMedia] uploadFile: missing file_key')
    return key
  }

  /** Send an image message to a chat. See OpenClaw media.ts:435. */
  async sendImageMessage(chatId: string, imageKey: string): Promise<void> {
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      },
    })
  }

  /** Send a file message to a chat. See OpenClaw media.ts:466. */
  async sendFileMessage(chatId: string, fileKey: string): Promise<void> {
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      },
    })
  }
}
