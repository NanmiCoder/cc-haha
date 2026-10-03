import { getBaseUrl } from '../api/client'
import { filesystemImageUrl, isAbsoluteLocalPath } from './handlePreviewLink'

/**
 * Extensions that count as an inline image attachment.
 *
 * Deliberately kept in sync with `ConversationService.shouldInlineImageAttachment`
 * (src/server/services/conversationService.ts): the server inlines exactly these
 * as base64 image blocks. Promoting anything else to `type: 'image'` would make
 * the server inline a media type the API rejects (e.g. `image/svg`), so the wider
 * set that `/api/filesystem/file` can serve is intentionally NOT used here.
 */
const INLINE_IMAGE_EXTENSION_RE = /\.(png|jpe?g|gif|webp)$/i

export function isInlineImagePath(pathOrName: string | undefined): boolean {
  return !!pathOrName && INLINE_IMAGE_EXTENSION_RE.test(pathOrName)
}

/** Host-managed ImageGen results already render through their dedicated result card. */
export function isManagedGeneratedImagePath(filePath: string): boolean {
  return /(?:^|\/)cc-haha\/generated-images\//.test(filePath.replaceAll('\\', '/'))
}

/** Serves a local absolute image path through the local server. */
export function localImageFileUrl(filePath: string): string {
  return filesystemImageUrl(getBaseUrl(), filePath)
}

type ImageSourceCandidate = {
  previewUrl?: string
  data?: string
  path?: string
  isDirectory?: boolean
}

/**
 * Resolves what an image attachment should render from.
 *
 * Desktop attachments are path-only by design (see `fix: keep desktop attachments
 * path-only`), so a pasted image usually carries neither `previewUrl` nor `data`
 * and has to be streamed back from the local server instead of being inlined into
 * the websocket payload.
 */
export function attachmentImageSource(attachment: ImageSourceCandidate): string | undefined {
  if (attachment.previewUrl) return attachment.previewUrl
  if (attachment.data) return attachment.data
  if (attachment.isDirectory) return undefined

  const filePath = attachment.path
  if (!filePath || !isAbsoluteLocalPath(filePath) || !isInlineImagePath(filePath)) {
    return undefined
  }

  return localImageFileUrl(filePath)
}
