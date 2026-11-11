import type { AttachmentRef } from '../../../../src/server/ws/events'

type PreviewAttachment = AttachmentRef & { id?: string; uri?: string }

export type PreviewImage = {
  id: string
  name: string
  uri: string
  attachmentIndex: number
}

export type ImagePreviewSelection = { images: PreviewImage[]; initialIndex: number }

export type ImagePreviewProps = ImagePreviewSelection & { onClose(): void }

/** Picked files have a local URI; replayed messages keep the uploaded bytes. */
export function attachmentImageUri(attachment: PreviewAttachment): string | undefined {
  if (attachment.type !== 'image') return undefined
  if (attachment.uri?.trim()) return attachment.uri
  if (!attachment.data?.trim()) return undefined
  if (attachment.data.startsWith('data:')) return attachment.data
  return `data:${attachment.mimeType || 'image/jpeg'};base64,${attachment.data}`
}

/** Retain attachment identity: files and duplicate image URIs must not shift it. */
export function attachmentImageSelection(
  attachments: readonly PreviewAttachment[],
  attachmentIndex: number
): ImagePreviewSelection | null {
  const images = attachments.flatMap((attachment, index): PreviewImage[] => {
    const uri = attachmentImageUri(attachment)
    return uri ? [{
      id: attachment.id || `attachment-${index}`,
      name: attachment.name || `图片 ${index + 1}`,
      uri,
      attachmentIndex: index,
    }] : []
  })
  const initialIndex = images.findIndex((image) => image.attachmentIndex === attachmentIndex)
  return initialIndex < 0 ? null : { images, initialIndex }
}
