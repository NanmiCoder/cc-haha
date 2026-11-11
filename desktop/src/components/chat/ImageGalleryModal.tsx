import { useContext, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Download, ExternalLink, X } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { Modal } from '@/components/ui/Modal'
import { ErrorState } from '@/components/ui/ErrorState'
import { ZoomableImage, type ZoomableImageProps } from '@/components/ui/ZoomableImage'
import { useAuthedImageFallback } from '../../lib/useAuthedImageFallback'
import { getDesktopHost } from '@/lib/desktopHost'
import { isRootedLocalPath } from '@/lib/handlePreviewLink'
import { openLocalFileWithSystem, reportOpenFailure } from '@/lib/systemFileOpen'
import { useTranslation } from '../../i18n'
import { downloadGalleryImage } from '@/components/chat/downloadGalleryImage'
import { useUIStore } from '@/stores/uiStore'
import { toolResultImageToBlob } from '@/lib/toolResultContent'
import { ConversationImageGalleryContext, sameGalleryImage, type GalleryImage } from '@/components/chat/conversationImageGallery'

type Props = {
  open: boolean
  images: GalleryImage[]
  activeIndex: number
  onClose: () => void
  onSelect: (index: number) => void
}

function useGalleryImageSource(image: GalleryImage) {
  const [decoded, setDecoded] = useState<{ image: GalleryImage; url: string | null } | null>(null)
  useEffect(() => {
    if (image.src || !image.inline) return
    try {
      const url = URL.createObjectURL(toolResultImageToBlob(image.inline))
      setDecoded({ image, url })
      return () => URL.revokeObjectURL(url)
    } catch {
      setDecoded({ image, url: null })
    }
  }, [image])
  return {
    src: image.src || (decoded?.image === image ? decoded.url ?? undefined : undefined),
    failed: decoded?.image === image && decoded.url === null,
  }
}

/** The lightbox picture, which also loads where a bare request is refused (web UI, H5). */
function AuthedZoomableImage({ image, onError, ...props }: Omit<ZoomableImageProps, 'src'> & { image: GalleryImage }) {
  const t = useTranslation()
  const { src, failed: decodeFailed } = useGalleryImageSource(image)
  const [failed, setFailed] = useState(false)
  const authed = useAuthedImageFallback(src, () => {
    setFailed(true)
    onError?.()
  })
  if (decodeFailed || failed) return <ErrorState title={t('chat.imageLoadFailed')} detail={image.name} />
  return src ? <ZoomableImage {...props} src={authed.src ?? src} onError={authed.onError} /> : null
}

export function ImageGalleryModal(props: Props) {
  const getConversationImages = useContext(ConversationImageGalleryContext)
  return getConversationImages && props.open
    ? <ConversationGalleryModal {...props} getImages={getConversationImages} />
    : <GalleryModal {...props} />
}

function mergeGalleryImages(history: GalleryImage[], local: GalleryImage[]): GalleryImage[] {
  const all = [...history]
  for (const image of local) {
    const index = all.findIndex((candidate) => sameGalleryImage(candidate, image))
    // A tool strip's blob belongs to that row; the viewer owns its decoded copy.
    const owned = image.inline ? { ...image, src: '' } : image
    if (index < 0) all.push(owned)
    else all[index] = owned
  }
  return all
}

function ConversationGalleryModal({ getImages, ...props }: Props & { getImages: () => GalleryImage[] | Promise<GalleryImage[]> }) {
  // Capture once per opening, including asynchronous disk-confirmed names. Show
  // the clicked picture immediately and keep the selection if navigation occurs
  // before the rest of the history resolves.
  const [opening] = useState(() => ({ result: getImages(), local: props.images }))
  const [selection, setSelection] = useState(() => {
    const images = mergeGalleryImages(Array.isArray(opening.result) ? opening.result : [], opening.local)
    const clicked = props.images[props.activeIndex]
    return { images, activeIndex: clicked ? images.findIndex((image) => sameGalleryImage(image, clicked)) : -1 }
  })
  useEffect(() => {
    if (Array.isArray(opening.result)) return
    let current = true
    void opening.result.then((history) => {
      if (!current) return
      setSelection((previous) => {
        const images = mergeGalleryImages(history, opening.local)
        const active = previous.images[previous.activeIndex]
        return { images, activeIndex: active ? images.findIndex((image) => sameGalleryImage(image, active)) : -1 }
      })
    }).catch(() => { /* The clicked message remains usable if history cannot resolve. */ })
    return () => { current = false }
  }, [opening])
  return <GalleryModal {...props} {...selection} onSelect={(activeIndex) => setSelection((previous) => ({ ...previous, activeIndex }))} />
}

function GalleryModal({ open, images, activeIndex, onClose, onSelect }: Props) {
  const t = useTranslation()
  const activeImage = images[activeIndex]
  const [downloading, setDownloading] = useState(false)
  const pointerStart = useRef<{ x: number; y: number; interactive: boolean } | null>(null)

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

  const download = async () => {
    if (downloading) return
    setDownloading(true)
    try {
      await downloadGalleryImage(activeImage)
    } catch {
      useUIStore.getState().addToast({ type: 'error', message: t('attachments.downloadFailed') })
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={activeImage.name} variant="lightbox">
      <div
        className="relative flex h-full min-h-0 flex-col"
        onPointerDownCapture={(event) => {
          pointerStart.current = {
            x: event.clientX,
            y: event.clientY,
            interactive: event.target instanceof Element && !!event.target.closest('img, button, a, [role="alert"]'),
          }
        }}
        onClick={(event) => {
          const start = pointerStart.current
          pointerStart.current = null
          // The full-screen content covers Modal's backdrop. Its empty stage
          // still dismisses, but image clicks and captured pan gestures do not.
          if (event.target instanceof Element && event.target.closest('img, button, a, [role="alert"]')) return
          if (start?.interactive || (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4)) return
          onClose()
        }}
      >
        <div className="flex h-20 shrink-0 items-center justify-between px-4 sm:px-6">
          <span className="font-mono text-xs tabular-nums text-[var(--color-media-fg)]">
            {activeIndex + 1} / {images.length}
          </span>
          <div className="flex items-center gap-2">
            {originalPath ? (
              <IconButton
                icon={<ExternalLink size={20} strokeWidth={1.75} />}
                label={t('workspace.openInSystemApp')}
                size="2xl"
                shape="circle"
                surface="lightbox"
                onClick={() => {
                  void openLocalFileWithSystem(originalPath).catch(() => reportOpenFailure(originalPath))
                }}
              />
            ) : null}
            <IconButton
              icon={<Download size={20} strokeWidth={1.75} />}
              label={t('attachments.downloadImage')}
              size="2xl"
              shape="circle"
              surface="lightbox"
              loading={downloading}
              onClick={() => { void download() }}
            />
            <IconButton
              icon={<X size={22} strokeWidth={1.75} />}
              label={t('workbench.close')}
              size="2xl"
              shape="circle"
              surface="lightbox"
              onClick={onClose}
            />
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-12 sm:px-20">
          <AuthedZoomableImage
            key={`${activeIndex}:${activeImage.src}`}
            image={activeImage}
            alt={activeImage.name}
            surface="lightbox"
            labels={{
              group: t('workspace.zoom.group'),
              zoomIn: t('workspace.zoom.in'),
              zoomOut: t('workspace.zoom.out'),
              fit: t('workspace.zoom.fitWindow'),
            }}
          />
        </div>

        {images.length > 1 ? (
          <>
            <div className="absolute left-2 top-1/2 -translate-y-1/2 sm:left-4">
              <IconButton
                icon={<ArrowLeft size={22} strokeWidth={1.75} aria-hidden="true" />}
                label={t('attachments.previousImage')}
                size="2xl"
                shape="circle"
                surface="lightbox"
                onClick={() => onSelect((activeIndex - 1 + images.length) % images.length)}
              />
            </div>
            <div className="absolute right-2 top-1/2 -translate-y-1/2 sm:right-4">
              <IconButton
                icon={<ArrowRight size={22} strokeWidth={1.75} aria-hidden="true" />}
                label={t('attachments.nextImage')}
                size="2xl"
                shape="circle"
                surface="lightbox"
                onClick={() => onSelect((activeIndex + 1) % images.length)}
              />
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  )
}
