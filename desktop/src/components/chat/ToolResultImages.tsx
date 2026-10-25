import { useEffect, useState } from 'react'
import { useTranslation } from '@/i18n'
import { isRootedLocalPath } from '@/lib/handlePreviewLink'
import { toolResultImageToBlob, type ToolResultImage } from '@/lib/toolResultContent'
import { ImageGalleryModal } from './ImageGalleryModal'

type Props = {
  images: ToolResultImage[]
  /** Image blocks the tool sent that could not be shown (see `extractToolResultImages`). */
  omitted?: number
  /**
   * The local file the pictures were read from (the `Read` tool). A rooted path is
   * handed to the lightbox so it can offer the original in the system app.
   */
  originalPath?: string
  toolName?: string
  /** Outer spacing, decided by the chrome this strip sits in. */
  className?: string
}

/** Object URLs made for one exact array of images; `null` marks one that would not decode. */
type ObjectUrls = { sources: ToolResultImage[]; urls: Array<string | null> }

/**
 * The pictures a tool returned, as a strip of thumbnails under the tool row.
 * Clicking one opens the lightbox.
 *
 * The bytes live in the message store as base64. Each picture is decoded into a
 * Blob and shown through an object URL, which keeps megabytes of base64 out of
 * `src` attributes. Object URLs pin their Blob until revoked, so the URLs are made
 * in an effect and revoked by that same effect's cleanup: remounting, changing
 * images and StrictMode's double mount all release exactly what they created.
 * A thumbnail that fails to decode or to load is dropped rather than shown broken.
 */
export function ToolResultImages({ images, omitted = 0, originalPath, toolName, className = '' }: Props) {
  const t = useTranslation()
  const sources = useStableImages(images)
  const [objectUrls, setObjectUrls] = useState<ObjectUrls | null>(null)
  const [brokenUrls, setBrokenUrls] = useState<ReadonlySet<string>>(() => new Set())
  const [activeUrl, setActiveUrl] = useState<string | null>(null)

  useEffect(() => {
    if (sources.length === 0) return
    const created: string[] = []
    const urls = sources.map((image) => {
      try {
        const url = URL.createObjectURL(toolResultImageToBlob(image))
        created.push(url)
        return url
      } catch {
        return null
      }
    })
    setObjectUrls({ sources, urls })
    return () => {
      for (const url of created) URL.revokeObjectURL(url)
    }
  }, [sources])

  // URLs made for an earlier array are revoked by now; never hand them to an <img>.
  const urls = objectUrls?.sources === sources ? objectUrls.urls : null
  const count = sources.length
  const slots = sources
    .map((_, index) => ({ index, url: urls?.[index] ?? null }))
    // Waiting on the effect keeps a placeholder so the row does not grow later;
    // once URLs exist, a picture without a usable one is simply not shown.
    .filter(({ url }) => urls === null || (url !== null && !brokenUrls.has(url)))
  const shown = slots.flatMap(({ index, url }) => (url === null ? [] : [{ index, url }]))

  const galleryPath = originalPath && isRootedLocalPath(originalPath) ? originalPath : undefined
  const originalName = originalPath ? fileNameOf(originalPath) : ''
  const galleryImages = shown.map(({ index, url }) => ({
    src: url,
    name: originalName || t('chat.toolResultImage.alt', { index: index + 1, count }),
    ...(galleryPath ? { path: galleryPath } : {}),
    inline: sources[index],
  }))
  const activeIndex = activeUrl === null ? -1 : galleryImages.findIndex((image) => image.src === activeUrl)

  if (slots.length === 0 && omitted <= 0) return null

  return (
    <>
      <div
        role="group"
        aria-label={toolName ? t('tool.result', { toolName }) : t('tool.resultGeneric')}
        data-tool-result-images=""
        className={`flex flex-wrap items-center gap-2 ${className}`}
      >
        {slots.map(({ index, url }) => (url === null ? (
          <span
            key={index}
            aria-hidden="true"
            className="h-24 w-24 shrink-0 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)]"
          />
        ) : (
          <button
            key={index}
            type="button"
            aria-label={t('chat.toolResultImage.open', { index: index + 1, count })}
            onClick={() => setActiveUrl(url)}
            className="flex h-24 shrink-0 overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] transition-colors hover:border-[var(--color-primary-fixed-dim)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] motion-reduce:transition-none"
          >
            <img
              src={url}
              alt={t('chat.toolResultImage.alt', { index: index + 1, count })}
              onError={() => setBrokenUrls((previous) => new Set(previous).add(url))}
              className="block h-full w-auto min-w-[64px] max-w-[240px] object-cover"
            />
          </button>
        )))}
        {omitted > 0 ? (
          <span className="text-[12px] text-[var(--color-text-tertiary)]">
            {t('chat.toolResultImage.omitted', { count: omitted })}
          </span>
        ) : null}
      </div>

      {activeIndex >= 0 ? (
        <ImageGalleryModal
          open
          images={galleryImages}
          activeIndex={activeIndex}
          onClose={() => setActiveUrl(null)}
          onSelect={(next) => setActiveUrl(galleryImages[next]?.src ?? null)}
        />
      ) : null}
    </>
  )
}

/**
 * Keep the first array for as long as its contents stay the same. A parent that
 * hands over an equal but new array on every render (history reloaded, a wrapper
 * rebuilt) would otherwise decode every picture again and swap every `src`.
 */
function useStableImages(images: ToolResultImage[]): ToolResultImage[] {
  const [stable, setStable] = useState(images)
  if (stable !== images && !sameImages(stable, images)) {
    setStable(images)
    return images
  }
  return stable
}

function sameImages(a: ToolResultImage[], b: ToolResultImage[]): boolean {
  return a.length === b.length && a.every((image, index) => (
    image.mediaType === b[index]!.mediaType && image.data === b[index]!.data
  ))
}

function fileNameOf(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath
}
