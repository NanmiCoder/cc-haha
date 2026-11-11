import { fetchServerImageBlobUrl } from '@/lib/authedImage'
import { toolResultImageToBlob } from '@/lib/toolResultContent'
import type { GalleryImage } from '@/components/chat/conversationImageGallery'

const IMAGE_EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
}

/** Download original pixels; the viewer's zoom and pan never affect the file. */
export async function downloadGalleryImage(image: GalleryImage): Promise<void> {
  let ownedUrl: string | undefined
  try {
    const src = image.inline
      ? (ownedUrl = URL.createObjectURL(toolResultImageToBlob(image.inline)))
      : /^(?:data:image\/|blob:)/i.test(image.src)
        ? image.src
        : (ownedUrl = await fetchServerImageBlobUrl(image.src))
    const name = (image.path ? image.path.split(/[\\/]/).pop() : image.name.replace(/[\\/]/g, '-')) || 'image'
    const mediaType = image.inline?.mediaType ?? /^data:(image\/[^;,]+)/i.exec(image.src)?.[1]
    const extension = mediaType ? IMAGE_EXTENSION_BY_MEDIA_TYPE[mediaType.toLowerCase()] : undefined
    const existingExtension = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i.exec(name)
    let downloadName = name
    if (!existingExtension) {
      downloadName = `${name}.${extension ?? 'png'}`
    } else if (extension && existingExtension[1]!.toLowerCase().replace('jpeg', 'jpg') !== extension) {
      // A Read result may contain JPEG pixels compressed from a PNG source.
      downloadName = `${name.slice(0, -existingExtension[0].length)}.${extension}`
    }
    const link = document.createElement('a')
    link.href = src
    link.download = downloadName
    document.body.appendChild(link)
    link.click()
    link.remove()
  } finally {
    // Chromium needs the object URL to outlive the initiating click.
    const url = ownedUrl
    if (url) setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
