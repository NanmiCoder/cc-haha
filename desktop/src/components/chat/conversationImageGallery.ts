import { createContext } from 'react'
import type { InlineToolResultImage } from '@/lib/toolResultContent'

export type GalleryImage = {
  src: string
  name: string
  /** The original file, for opening in the system application. */
  path?: string
  /** Tool pixels are decoded only while their gallery thumbnail or preview is mounted. */
  inline?: InlineToolResultImage
  /** Stored capture pixels addressed by a server reference, not the live file. */
  captured?: boolean
}

/** Snapshot loaded history when a viewer opens, including virtualized-away rows. */
export const ConversationImageGalleryContext = createContext<(() => GalleryImage[] | Promise<GalleryImage[]>) | null>(null)

function hasCapturedPixels(image: GalleryImage): boolean {
  return Boolean(image.inline || image.captured) || /^(?:data|blob):/i.test(image.src)
}

export function sameGalleryImage(left: GalleryImage, right: GalleryImage): boolean {
  if (left.inline && right.inline) {
    return left.inline.mediaType === right.inline.mediaType && left.inline.data === right.inline.data
  }
  return Boolean(left.src && left.src === right.src)
    // A capture keeps its pixels even after the source file is overwritten. Only
    // live file references can use their shared path as the image identity.
    || Boolean(left.path && left.path === right.path && !hasCapturedPixels(left) && !hasCapturedPixels(right))
}
