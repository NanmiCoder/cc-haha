import { useEffect } from 'react'
import { X } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { Modal } from '@/components/ui/Modal'
import { useOverlayStore } from '../../stores/overlayStore'
import { useTranslation } from '../../i18n'

type GalleryImage = {
  src: string
  name: string
}

type Props = {
  open: boolean
  images: GalleryImage[]
  activeIndex: number
  onClose: () => void
  onSelect: (index: number) => void
}

export function ImageGalleryModal({ open, images, activeIndex, onClose, onSelect }: Props) {
  const t = useTranslation()
  const activeImage = images[activeIndex]

  // Native child webviews (e.g. the in-app browser preview) always render
  // ABOVE the DOM, so this fullscreen overlay would be partially covered.
  // Bump the overlay count while open so BrowserSurface can hide the webview.
  useEffect(() => {
    if (!open) return
    const { push, pop } = useOverlayStore.getState()
    push()
    return () => pop()
  }, [open])

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

  return (
    <Modal open={open} onClose={onClose} title={activeImage.name} variant="media">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between px-3">
          <span className="font-mono text-xs tabular-nums text-[var(--color-terminal-muted)]">
            {activeIndex + 1} / {images.length}
          </span>
          <IconButton
            icon={<X />}
            label={t('workbench.close')}
            size="lg"
            tone="secondary"
            shape="circle"
            surface="terminal"
            onClick={onClose}
          />
        </div>

        <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-4">
          <img
            src={activeImage.src}
            alt={activeImage.name}
            className="max-h-full max-w-full rounded-[var(--radius-md)] object-contain"
          />

          {images.length > 1 ? (
            <>
              <div className="absolute left-3 top-1/2 -translate-y-1/2">
                <IconButton
                  icon="chevron_left"
                  label={t('attachments.previousImage')}
                  size="xl"
                  tone="secondary"
                  shape="circle"
                  surface="terminal"
                  className="bg-[var(--color-terminal-header)] shadow-[var(--shadow-card)]"
                  onClick={() => onSelect((activeIndex - 1 + images.length) % images.length)}
                />
              </div>
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                <IconButton
                  icon="chevron_right"
                  label={t('attachments.nextImage')}
                  size="xl"
                  tone="secondary"
                  shape="circle"
                  surface="terminal"
                  className="bg-[var(--color-terminal-header)] shadow-[var(--shadow-card)]"
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
                    ? 'border-[var(--color-terminal-fg)] opacity-100'
                    : 'border-[var(--color-terminal-border)] opacity-55 hover:opacity-90'
                }`}
              >
                <img src={image.src} alt={image.name} className="h-12 w-12 object-cover" />
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
