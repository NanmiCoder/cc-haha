import { useEffect } from 'react'
import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { Modal } from '@/components/ui/Modal'
import { ZoomableImage, type ZoomableImageProps } from '@/components/ui/ZoomableImage'
import { useAuthedImageFallback } from '../../lib/useAuthedImageFallback'
import { AuthedImage } from './AuthedImage'
import { getDesktopHost } from '@/lib/desktopHost'
import { isRootedLocalPath } from '@/lib/handlePreviewLink'
import { openLocalFileWithSystem, reportOpenFailure } from '@/lib/systemFileOpen'
import { useTranslation } from '../../i18n'

type GalleryImage = {
  src: string
  name: string
  /**
   * The file on disk, when the picture is one (a blob or inline image is not).
   * It is what "open in system app" hands to the operating system.
   */
  path?: string
}

type Props = {
  open: boolean
  images: GalleryImage[]
  activeIndex: number
  onClose: () => void
  onSelect: (index: number) => void
}

/** The lightbox picture, which also loads where a bare request is refused (web UI, H5). */
function AuthedZoomableImage({ src, onError, ...props }: ZoomableImageProps) {
  const image = useAuthedImageFallback(src, onError)
  return <ZoomableImage {...props} src={image.src ?? src} onError={image.onError} />
}

export function ImageGalleryModal({ open, images, activeIndex, onClose, onSelect }: Props) {
  const t = useTranslation()
  const activeImage = images[activeIndex]

  useEffect(() => {
    if (!open || images.length <= 1) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        onSelect((activeIndex - 1 + images.length) % images.length)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        onSelect((activeIndex + 1) % images.length)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [activeIndex, images.length, onSelect, open])

  if (!activeImage) return null

  // Only in the desktop app: in a browser the "system" is the machine the server
  // runs on, which is not the one the reader is looking at. (Same rule as the
  // attachment chips.)
  const host = getDesktopHost()
  const originalPath = activeImage.path && isRootedLocalPath(activeImage.path) && host.isDesktop && host.capabilities.shell
    ? activeImage.path
    : undefined

  return (
    <Modal open={open} onClose={onClose} title={activeImage.name} variant="media">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between px-3">
          <span className="font-mono text-xs tabular-nums text-[var(--color-media-muted)]">
            {activeIndex + 1} / {images.length}
          </span>
          <IconButton
            icon={<X />}
            label={t('workbench.close')}
            size="lg"
            tone="secondary"
            shape="circle"
            surface="media"
            onClick={onClose}
          />
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col px-4 pb-4">
          <AuthedZoomableImage
            // The size it measures belongs to one picture, and so does the zoom.
            key={activeImage.src}
            src={activeImage.src}
            alt={activeImage.name}
            surface="media"
            labels={{
              group: t('workspace.zoom.group'),
              zoomIn: t('workspace.zoom.in'),
              zoomOut: t('workspace.zoom.out'),
              fit: t('workspace.zoom.fitWindow'),
            }}
            actions={originalPath ? (
              <IconButton
                icon={<ExternalLink size={16} strokeWidth={1.9} />}
                label={t('workspace.openInSystemApp')}
                size="md"
                tone="secondary"
                surface="media"
                onClick={() => {
                  void openLocalFileWithSystem(originalPath).catch(() => reportOpenFailure(originalPath))
                }}
              />
            ) : undefined}
          />

          {images.length > 1 ? (
            <>
              <div className="absolute left-3 top-1/2 -translate-y-1/2">
                <IconButton
                  icon={<ChevronLeft size={20} strokeWidth={1.75} aria-hidden="true" />}
                  label={t('attachments.previousImage')}
                  size="xl"
                  tone="secondary"
                  shape="circle"
                  surface="media"
                  className="bg-[var(--color-media-header)] shadow-[var(--shadow-card)]"
                  onClick={() => onSelect((activeIndex - 1 + images.length) % images.length)}
                />
              </div>
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                <IconButton
                  icon={<ChevronRight size={20} strokeWidth={1.75} aria-hidden="true" />}
                  label={t('attachments.nextImage')}
                  size="xl"
                  tone="secondary"
                  shape="circle"
                  surface="media"
                  className="bg-[var(--color-media-header)] shadow-[var(--shadow-card)]"
                  onClick={() => onSelect((activeIndex + 1) % images.length)}
                />
              </div>
            </>
          ) : null}
        </div>

        {images.length > 1 && (
          <div className="flex shrink-0 justify-center gap-1.5 overflow-x-auto px-4 pb-3">
            {images.map((image, index) => (
              <button
                key={`${image.name}-${index}`}
                type="button"
                onClick={() => onSelect(index)}
                className={`overflow-hidden rounded-[var(--radius-md)] border transition-[border-color,opacity,transform] duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
                  index === activeIndex
                    ? 'border-[var(--color-media-fg)] opacity-100'
                    : 'border-[var(--color-media-border)] opacity-55 hover:opacity-90'
                }`}
              >
                <AuthedImage src={image.src} alt={image.name} className="h-12 w-12 object-cover" />
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
