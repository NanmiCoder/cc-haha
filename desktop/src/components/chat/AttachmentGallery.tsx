import { useMemo, useState } from 'react'
import { ImageGalleryModal } from './ImageGalleryModal'

export type AttachmentPreview = {
  id?: string
  type: 'image' | 'file'
  name: string
  path?: string
  data?: string
  previewUrl?: string
  isDirectory?: boolean
  lineStart?: number
  lineEnd?: number
  note?: string
  quote?: string
}

type Props = {
  attachments: AttachmentPreview[]
  variant?: 'composer' | 'message'
  onRemove?: (id: string) => void
}

export function AttachmentGallery({ attachments, variant = 'message', onRemove }: Props) {
  const [activeImageIndex, setActiveImageIndex] = useState<number | null>(null)

  const images = useMemo(
    () =>
      attachments
        .filter((attachment) => attachment.type === 'image' && (attachment.previewUrl || attachment.data))
        .map((attachment) => ({
          src: attachment.previewUrl || attachment.data || '',
          name: attachment.name,
        })),
    [attachments],
  )

  if (attachments.length === 0) return null

  const isComposer = variant === 'composer'

  return (
    <>
      <div className={isComposer ? 'flex flex-wrap items-center gap-2' : 'flex flex-wrap justify-end gap-2'}>
        {attachments.map((attachment, index) => {
          if (attachment.type === 'image' && (attachment.previewUrl || attachment.data)) {
            const src = attachment.previewUrl || attachment.data || ''
            return (
              <div
                key={attachment.id || `${attachment.name}-${index}`}
                className={isComposer ? 'group relative' : ''}
              >
                <button
                  type="button"
                  onClick={() => setActiveImageIndex(images.findIndex((image) => image.src === src))}
                  className={
                    isComposer
                      ? 'overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)]'
                      : 'overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] text-left shadow-sm transition-transform hover:scale-[1.01]'
                  }
                >
                  <img
                    src={src}
                    alt={attachment.name}
                    className={
                      isComposer
                        ? 'h-16 w-16 object-cover'
                        : 'max-h-[340px] w-full max-w-[360px] object-cover'
                    }
                  />
                </button>
                {onRemove && attachment.id && (
                  <button
                    type="button"
                    onClick={() => onRemove(attachment.id!)}
                    className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-error)] text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label={`Remove ${attachment.name}`}
                  >
                    ×
                  </button>
                )}
              </div>
            )
          }

          const lineLabel = attachment.lineStart
            ? `:L${attachment.lineStart}${attachment.lineEnd && attachment.lineEnd !== attachment.lineStart ? `-L${attachment.lineEnd}` : ''}`
            : ''
          const quotePreview = attachment.quote?.trim().replace(/\s+/g, ' ')
          const hasQuotePreview = !!quotePreview

          return (
            <div
              key={attachment.id || `${attachment.name}-${index}`}
              className={[
                'group/file inline-flex max-w-full min-w-0 border border-[var(--color-border)]',
                'bg-[var(--color-surface-container-low)] text-[var(--color-text-secondary)] shadow-[0_1px_2px_rgba(0,0,0,0.04)]',
                hasQuotePreview
                  ? 'items-start gap-2 rounded-[8px] px-2.5 py-2'
                  : 'h-9 items-center gap-2 rounded-full px-3',
              ].join(' ')}
            >
              <span className={`material-symbols-outlined shrink-0 text-[17px] text-[var(--color-text-tertiary)] ${hasQuotePreview ? 'mt-0.5' : ''}`}>
                {hasQuotePreview ? 'chat_bubble' : attachment.isDirectory ? 'folder' : 'description'}
              </span>
              <span className="min-w-0">
                <span className="block min-w-0 max-w-[260px] truncate text-[13px] font-medium leading-5 text-[var(--color-text-primary)]">
                  {attachment.name}{lineLabel}
                </span>
                {hasQuotePreview && (
                  <span className="mt-0.5 block max-w-[320px] truncate font-[var(--font-mono)] text-[11px] leading-4 text-[var(--color-text-tertiary)]">
                    {quotePreview}
                  </span>
                )}
              </span>
              {onRemove && attachment.id && (
                <button
                  type="button"
                  onClick={() => onRemove(attachment.id!)}
                  className={`${hasQuotePreview ? 'mt-0.5' : 'ml-0.5'} flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)]`}
                  aria-label={`Remove ${attachment.name}`}
                >
                  <span className="material-symbols-outlined text-[17px]">close</span>
                </button>
              )}
            </div>
          )
        })}
      </div>

      {activeImageIndex !== null && activeImageIndex >= 0 && (
        <ImageGalleryModal
          open={activeImageIndex !== null}
          images={images}
          activeIndex={activeImageIndex}
          onClose={() => setActiveImageIndex(null)}
          onSelect={setActiveImageIndex}
        />
      )}
    </>
  )
}
