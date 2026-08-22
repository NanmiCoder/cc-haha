import { useMemo, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { ChevronDown, MessageSquare, X } from 'lucide-react'
import { useTranslation, type TranslationKey } from '../../i18n'
import { attachmentImageSource } from '../../lib/attachmentImages'
import { getDesktopHost } from '../../lib/desktopHost'
import { isAbsoluteLocalPath } from '../../lib/handlePreviewLink'
import { buildOpenWithItems, describeFileType, type OpenWithItem } from '../../lib/openWithItems'
import { useOpenTargetStore } from '../../stores/openTargetStore'
import { useUIStore } from '../../stores/uiStore'
import { OpenWithMenu } from '@/components/composite/OpenWithMenu'
import { Badge } from '@/components/ui/Badge'
import { IconButton } from '@/components/ui/IconButton'
import { Tooltip } from '@/components/ui/Tooltip'
import { ImageGalleryModal } from './ImageGalleryModal'

export type AttachmentPreview = {
  id?: string
  type: 'image' | 'file'
  name: string
  path?: string
  data?: string
  mimeType?: string
  previewUrl?: string
  isDirectory?: boolean
  lineStart?: number
  lineEnd?: number
  diffSide?: 'old' | 'new'
  hunkId?: string
  note?: string
  quote?: string
  selectionNumber?: number
}

const FILE_ICON_ACCENTS: Record<string, string> = {
  picture_as_pdf: '#d14343',
  docs: '#3f6ecf',
  markdown: '#4d6b8a',
  text_snippet: '#667085',
  table_chart: '#24845b',
  slideshow: '#c85b2b',
  folder_zip: '#a46a17',
  code: '#7656b5',
  audio_file: '#ad477c',
  video_file: '#6655b8',
  html: '#c05d2c',
  image: '#24899a',
  folder: '#a46a17',
  insert_drive_file: '#667085',
}

function fileIconAccent(icon: string): string {
  return FILE_ICON_ACCENTS[icon] ?? FILE_ICON_ACCENTS.insert_drive_file!
}

type Props = {
  attachments: AttachmentPreview[]
  variant?: 'composer' | 'message'
  onRemove?: (id: string) => void
}

export function AttachmentGallery({ attachments, variant = 'message', onRemove }: Props) {
  const t = useTranslation()
  const [activeImageIndex, setActiveImageIndex] = useState<number | null>(null)
  const [openWith, setOpenWith] = useState<{ items: OpenWithItem[]; anchor: DOMRect; triggerEl: HTMLElement } | null>(null)
  // A path-backed preview can fail (file moved, or outside the paths the local
  // server is allowed to serve); those attachments fall back to the file card.
  const [unloadableImageSources, setUnloadableImageSources] = useState<ReadonlySet<string>>(() => new Set())
  const desktopHost = getDesktopHost()

  const images = useMemo(
    () =>
      attachments.flatMap((attachment) => {
        if (attachment.type !== 'image') return []
        const src = attachmentImageSource(attachment)
        if (!src || unloadableImageSources.has(src)) return []
        return [{ src, name: attachment.name }]
      }),
    [attachments, unloadableImageSources],
  )
  // Keep the layout decision tied to the authored attachment set, not to
  // transient load failures. Otherwise a two-image thumbnail row jumps to a
  // large single-image layout when one source errors and falls back to a card.
  const previewableImageCount = useMemo(
    () => attachments.filter((attachment) => (
      attachment.type === 'image' && Boolean(attachmentImageSource(attachment))
    )).length,
    [attachments],
  )

  const markImageUnloadable = (src: string) => {
    setUnloadableImageSources((previous) => {
      if (previous.has(src)) return previous
      const next = new Set(previous)
      next.add(src)
      return next
    })
  }

  if (attachments.length === 0) return null

  const isComposer = variant === 'composer'
  const isSelectionBatch = !isComposer && attachments.length > 1 && attachments.every((attachment) =>
    attachment.type === 'image' && typeof attachment.selectionNumber === 'number')

  const showOpenFailure = (name: string) => {
    useUIStore.getState().addToast({
      type: 'error',
      message: t('attachments.openFailed', { name }),
    })
  }

  const openLocalAttachment = (attachment: AttachmentPreview) => {
    if (!attachment.path) return
    void desktopHost.shell.openPath(attachment.path).catch(() => showOpenFailure(attachment.name))
  }

  const openAttachmentWith = (
    event: ReactMouseEvent<HTMLButtonElement>,
    attachment: AttachmentPreview,
  ) => {
    event.stopPropagation()
    if (!attachment.path) return
    if (openWith) {
      setOpenWith(null)
      return
    }

    const triggerEl = event.currentTarget
    const anchor = triggerEl.getBoundingClientRect()
    void (async () => {
      const targets = await useOpenTargetStore.getState().getTargetsForPath(attachment.path!)
      const items = buildOpenWithItems(
        { kind: 'file', absolutePath: attachment.path! },
        targets,
        {
          openInAppBrowser: () => {},
          openSystem: (path) => {
            void desktopHost.shell.openPath(path).catch(() => showOpenFailure(attachment.name))
          },
          openWorkspacePreview: () => {},
          openTarget: (targetId, path) => {
            void useOpenTargetStore.getState().openTarget(targetId, path)
              .catch(() => showOpenFailure(attachment.name))
          },
          t: (key, vars) => t(key as TranslationKey, vars),
        },
      )
      if (items.length > 0) setOpenWith({ items, anchor, triggerEl })
    })()
  }

  return (
    <>
      {isSelectionBatch ? (
        <div
          data-testid="preview-selection-batch"
          aria-label={t('attachments.selectionBatch', { count: attachments.length })}
          className="grid w-full max-w-[520px] grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-border)] shadow-[var(--shadow-card)]"
        >
          {attachments.map((attachment, index) => {
            const src = attachmentImageSource(attachment)
            if (!src || unloadableImageSources.has(src)) return null
            const isLastOddItem = attachments.length % 2 === 1 && index === attachments.length - 1
            const note = attachment.note?.trim()
            return (
              <button
                key={attachment.id || `${attachment.name}-${index}`}
                type="button"
                data-selection-number={attachment.selectionNumber}
                aria-label={t('attachments.selectionItem', {
                  number: attachment.selectionNumber!,
                  name: attachment.name,
                })}
                title={note || attachment.name}
                onClick={() => setActiveImageIndex(images.findIndex((image) => image.src === src))}
                className={[
                  'group/selection min-w-0 bg-[var(--color-surface-container-low)] text-left',
                  'focus-visible:relative focus-visible:z-[1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]',
                  isLastOddItem ? 'col-span-2' : '',
                ].join(' ')}
              >
                <span className="relative block h-28 overflow-hidden bg-[var(--color-surface)]">
                  <img
                    src={src}
                    alt=""
                    onError={() => markImageUnloadable(src)}
                    className="h-full w-full object-cover transition-transform duration-150 group-hover/selection:scale-[1.015] motion-reduce:transition-none"
                  />
                  <Badge
                    tone="brand"
                    size="sm"
                    pill={false}
                    mono
                    bordered
                    className="absolute left-2 top-2 shadow-[var(--shadow-card)]"
                  >
                    {attachment.selectionNumber}
                  </Badge>
                </span>
                <span className="flex min-h-11 min-w-0 items-center gap-2 border-t border-[var(--color-border)] px-2.5 py-1.5">
                  <span className="shrink-0 font-mono text-[11px] font-semibold text-[var(--color-text-secondary)]">
                    {attachment.name}
                  </span>
                  {note && (
                    <span className="min-w-0 truncate text-[11px] text-[var(--color-text-tertiary)]">
                      {note}
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      ) : (
      <div className={isComposer ? 'flex flex-wrap items-center gap-2' : 'flex max-w-full flex-wrap justify-end gap-2'}>
        {attachments.map((attachment, index) => {
          const imageSrc = attachment.type === 'image' ? attachmentImageSource(attachment) : undefined

          if (imageSrc && !unloadableImageSources.has(imageSrc)) {
            const src = imageSrc
            const selectionNote = attachment.note?.trim()
            const hasSelectionNote = !isComposer && !!selectionNote
            return (
              <div
                key={attachment.id || `${attachment.name}-${index}`}
                className={isComposer ? 'group relative' : 'relative flex max-w-full flex-col items-end gap-1.5'}
              >
                <button
                  type="button"
                  aria-label={t('attachments.open', { name: attachment.name })}
                  onClick={() => setActiveImageIndex(images.findIndex((image) => image.src === src))}
                  className={
                    isComposer
                      ? 'overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)]'
                      : 'overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] text-left shadow-[var(--shadow-card)] transition-transform hover:scale-[1.01] motion-reduce:transition-none'
                  }
                >
                  <img
                    src={src}
                    alt={attachment.name}
                    onError={() => markImageUnloadable(src)}
                    className={
                      isComposer
                        ? 'h-16 w-16 object-cover'
                        : previewableImageCount === 1
                          ? 'max-h-[340px] w-full max-w-[360px] object-cover'
                          : 'h-28 w-28 object-cover'
                    }
                  />
                </button>
                {hasSelectionNote && (
                  // `delay={0}` reproduces the CSS-transition tooltip this
                  // replaced, which appeared the moment the pointer landed.
                  <Tooltip
                    placement="top-end"
                    delay={0}
                    className="max-w-[min(340px,calc(100vw-3rem))] text-[13px]"
                    content={
                      <>
                        <span className="block text-[11px] font-medium uppercase tracking-wide opacity-70">
                          {t('attachments.selectionNoteTitle')}
                        </span>
                        <span className="mt-1 block whitespace-pre-wrap break-words">
                          {selectionNote}
                        </span>
                      </>
                    }
                  >
                    <span
                      aria-label={t('attachments.selectionNote', { note: selectionNote })}
                      title={selectionNote}
                      tabIndex={0}
                      className={[
                        'inline-flex h-7 max-w-[260px] items-center gap-1.5 rounded-full border',
                        'border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-2.5',
                        'text-[12px] font-medium leading-none text-[var(--color-text-primary)] shadow-[var(--shadow-card)]',
                        'transition-colors hover:border-[var(--color-primary-fixed-dim)] hover:bg-[var(--color-surface-container)]',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2',
                      ].join(' ')}
                    >
                      <span className="material-symbols-outlined text-[15px] text-[var(--color-text-tertiary)]">
                        ads_click
                      </span>
                      <span className="min-w-0 truncate">{attachment.name}</span>
                    </span>
                  </Tooltip>
                )}
                {onRemove && attachment.id && (
                  <button
                    type="button"
                    onClick={() => onRemove(attachment.id!)}
                    className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-error)] text-[10px] text-[var(--color-on-error)] opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={t('attachments.remove', { name: attachment.name })}
                  >
                    ×
                  </button>
                )}
              </div>
            )
          }

          if (attachment.diffSide) {
            const lineRange = attachment.lineStart
              ? `L${attachment.lineStart}${attachment.lineEnd && attachment.lineEnd !== attachment.lineStart ? `-L${attachment.lineEnd}` : ''}`
              : ''
            const location = [
              attachment.path || attachment.name,
              '·',
              t(`workspace.diffReview.side.${attachment.diffSide}`),
              lineRange,
            ]
              .filter(Boolean)
              .join(' ')
            const note = attachment.note?.trim()
            const quotePreview = attachment.quote?.trim().replace(/\s+/g, ' ')

            return (
              <div
                key={attachment.id || `${attachment.name}-${index}`}
                data-testid="diff-comment-card"
                className="group/diff-comment flex max-w-[min(420px,100%)] min-w-[240px] items-start gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-2.5 py-2 text-left shadow-[var(--shadow-card)]"
              >
                <MessageSquare aria-hidden="true" size={15} className="mt-0.5 shrink-0 text-[var(--color-text-tertiary)]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-medium text-[var(--color-text-tertiary)]">
                    {location}
                  </span>
                  {note && (
                    <span className="mt-0.5 block text-[13px] font-medium leading-5 text-[var(--color-text-primary)]">
                      {note}
                    </span>
                  )}
                  {quotePreview && (
                    <span className="mt-0.5 block truncate font-mono text-[11px] leading-4 text-[var(--color-text-tertiary)]">
                      {quotePreview}
                    </span>
                  )}
                </span>
                {onRemove && attachment.id && (
                  <IconButton
                    icon={<X aria-hidden="true" size={14} />}
                    label={t('attachments.remove', { name: attachment.name })}
                    size="2xs"
                    tone="muted"
                    onClick={() => onRemove(attachment.id!)}
                  />
                )}
              </div>
            )
          }

          const lineLabel = attachment.lineStart
            ? `:L${attachment.lineStart}${attachment.lineEnd && attachment.lineEnd !== attachment.lineStart ? `-L${attachment.lineEnd}` : ''}`
            : ''
          const quotePreview = attachment.quote?.trim().replace(/\s+/g, ' ')
          const hasQuotePreview = !!quotePreview
          const typeInfo = describeFileType(attachment.path || attachment.name)
          const fileIcon = attachment.isDirectory ? 'folder' : typeInfo.icon
          const typeLabel = attachment.isDirectory
            ? t('openWith.fileType.file')
            : typeInfo.ext || t(typeInfo.categoryKey as TranslationKey)
          const canOpenLocally =
            !isComposer &&
            !!attachment.path &&
            isAbsoluteLocalPath(attachment.path) &&
            desktopHost.isDesktop &&
            desktopHost.capabilities.shell

          const fileVisual = (
            <>
              <span
                aria-hidden="true"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-surface)] shadow-[inset_0_0_0_1px_var(--color-border)]"
                style={{ color: fileIconAccent(fileIcon) }}
              >
                <span className="material-symbols-outlined text-[19px]">{fileIcon}</span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block min-w-0 max-w-[260px] truncate text-[13px] font-semibold leading-5 text-[var(--color-text-primary)]">
                  {attachment.name}{lineLabel}
                </span>
                <span className="block truncate text-[10px] font-semibold uppercase leading-3 tracking-[0.08em] text-[var(--color-text-tertiary)]">
                  {typeLabel}
                </span>
                {hasQuotePreview && (
                  <span className="mt-0.5 block max-w-[320px] truncate font-mono text-[11px] leading-4 text-[var(--color-text-tertiary)]">
                    {quotePreview}
                  </span>
                )}
              </span>
            </>
          )

          if (canOpenLocally) return (
            <div
              key={attachment.id || `${attachment.name}-${index}`}
              data-file-extension={typeInfo.ext || undefined}
              className={[
                'group/file inline-flex max-w-full min-w-[220px] items-stretch overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)]',
                'bg-[var(--color-surface-container-low)] text-[var(--color-text-secondary)] shadow-[var(--shadow-card)]',
                'transition-colors hover:border-[var(--color-outline)] hover:bg-[var(--color-surface-container)]',
              ].join(' ')}
            >
              <button
                type="button"
                onClick={() => openLocalAttachment(attachment)}
                aria-label={t('attachments.open', { name: attachment.name })}
                title={attachment.path}
                className="flex min-h-12 min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
              >
                {fileVisual}
              </button>
              <button
                type="button"
                onClick={(event) => openAttachmentWith(event, attachment)}
                aria-label={t('openWith.title')}
                title={t('openWith.title')}
                className="flex w-9 shrink-0 items-center justify-center border-l border-[var(--color-border)] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
              >
                <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          )

          return (
            <div
              key={attachment.id || `${attachment.name}-${index}`}
              data-file-extension={typeInfo.ext || undefined}
              className={[
                'group/file inline-flex max-w-full min-w-0 items-center gap-2.5 border border-[var(--color-border)]',
                'rounded-[var(--radius-lg)] bg-[var(--color-surface-container-low)] px-2.5 py-1.5 text-[var(--color-text-secondary)]',
                'shadow-[var(--shadow-card)]',
              ].join(' ')}
            >
              {fileVisual}
              {onRemove && attachment.id && (
                <IconButton
                  icon={<span className="material-symbols-outlined text-[17px]" aria-hidden="true">close</span>}
                  label={t('attachments.remove', { name: attachment.name })}
                  size="2xs"
                  tone="muted"
                  shape="circle"
                  className={hasQuotePreview ? 'mt-0.5' : 'ml-0.5'}
                  onClick={() => onRemove(attachment.id!)}
                />
              )}
            </div>
          )
        })}
      </div>
      )}

      {activeImageIndex !== null && activeImageIndex >= 0 && (
        <ImageGalleryModal
          open={activeImageIndex !== null}
          images={images}
          activeIndex={activeImageIndex}
          onClose={() => setActiveImageIndex(null)}
          onSelect={setActiveImageIndex}
        />
      )}
      {openWith && (
        <OpenWithMenu
          items={openWith.items}
          anchor={openWith.anchor}
          triggerEl={openWith.triggerEl}
          onClose={() => setOpenWith(null)}
        />
      )}
    </>
  )
}
