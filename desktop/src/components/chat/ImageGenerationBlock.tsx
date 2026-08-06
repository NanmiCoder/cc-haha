import { useState } from 'react'
import { ImageIcon, Maximize2, TriangleAlert } from 'lucide-react'

import { Skeleton, SkeletonGroup } from '@/components/ui/Skeleton'
import { useTranslation } from '@/i18n'
import { localImageFileUrl } from '@/lib/attachmentImages'
import { ImageGalleryModal } from './ImageGalleryModal'

type GeneratedImage = {
  path: string
  mimeType: string
  revisedPrompt?: string
}

type ImageGenerationResult = {
  type: 'image_generation_result'
  operation: 'generate' | 'edit'
  inputImageCount: number
  providerId: string
  providerKind: string
  model: string
  prompt: string
  images: GeneratedImage[]
  durationMs: number
}

type Props = {
  input: unknown
  result?: { content: unknown; isError: boolean } | null
  compact?: boolean
  isPending?: boolean
  durationMs?: number
}

export type ImageGenerationItem = {
  id: string
  input: unknown
  result?: { content: unknown; isError: boolean } | null
  durationMs?: number
}

type ImageGenerationGroupProps = {
  items: ImageGenerationItem[]
}

type ImageSlot = {
  key: string
  state: 'pending' | 'complete' | 'error'
  image?: GeneratedImage
  galleryIndex?: number
  message?: string
}

const THUMBNAIL_RAIL_CLASS = 'grid max-w-full grid-flow-col auto-cols-[9.5rem] justify-start gap-2 overflow-x-auto pb-1 sm:auto-cols-[11rem]'

export function ImageGenerationBlock({
  input,
  result,
  compact = false,
  durationMs,
}: Props) {
  return (
    <ImageGenerationCollection
      compact={compact}
      items={[{
        id: 'image-generation',
        input,
        result,
        durationMs,
      }]}
    />
  )
}

export function ImageGenerationGroup({ items }: ImageGenerationGroupProps) {
  return <ImageGenerationCollection compact items={items} />
}

function ImageGenerationCollection({
  items,
  compact,
}: {
  items: ImageGenerationItem[]
  compact: boolean
}) {
  const t = useTranslation()
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const itemViews = items.map((item) => {
    const inputRecord = isRecord(item.input) ? item.input : {}
    const parsedResult = item.result && !item.result.isError
      ? parseImageGenerationResult(item.result.content)
      : null
    const requestedCount = integerInRange(inputRecord.count, 1, 4)
    const slotCount = Math.max(requestedCount ?? 0, parsedResult?.images.length ?? 0, 1)
    const isEdit = (
      Array.isArray(inputRecord.referenced_image_paths) && inputRecord.referenced_image_paths.length > 0
    ) || (
      // Persisted calls from before the generation/edit contract split.
      Array.isArray(inputRecord.input_images) && inputRecord.input_images.length > 0
    ) || parsedResult?.operation === 'edit'

    return {
      ...item,
      inputRecord,
      parsedResult,
      slotCount,
      isEdit,
    }
  })
  const allEdits = itemViews.length > 0 && itemViews.every((item) => item.isEdit)
  const totalSlotCount = itemViews.reduce((sum, item) => sum + item.slotCount, 0)
  const galleryImages: Array<{ src: string; name: string }> = []
  const slots: ImageSlot[] = []

  for (const item of itemViews) {
    const errorText = item.result?.isError ? contentText(item.result.content) : ''
    for (let index = 0; index < item.slotCount; index++) {
      const image = item.parsedResult?.images[index]
      if (image) {
        const galleryIndex = galleryImages.length
        galleryImages.push({
          src: localImageFileUrl(image.path),
          name: fileName(image.path) || t('tool.generatedImageAlt', { index: galleryIndex + 1 }),
        })
        slots.push({
          key: `${item.id}-${index}`,
          state: 'complete',
          image,
          galleryIndex,
        })
      } else if (!item.result) {
        slots.push({ key: `${item.id}-${index}`, state: 'pending' })
      } else {
        slots.push({
          key: `${item.id}-${index}`,
          state: 'error',
          message: errorText || t('tool.imageGenerationMissing'),
        })
      }
    }
  }

  const hasPending = slots.some((slot) => slot.state === 'pending')
  const hasError = slots.some((slot) => slot.state === 'error')
  const waitingLabel = allEdits
    ? totalSlotCount === 1
      ? t('tool.imageGenerationEditingOne')
      : t('tool.imageGenerationEditing', { count: totalSlotCount })
    : totalSlotCount === 1
      ? t('tool.imageGenerationGeneratingOne')
      : t('tool.imageGenerationGenerating', { count: totalSlotCount })
  const completeCount = galleryImages.length
  const completeLabel = allEdits
    ? completeCount === 1
      ? t('tool.imageGenerationEditCompleteOne')
      : t('tool.imageGenerationEditComplete', { count: completeCount })
    : completeCount === 1
      ? t('tool.imageGenerationCompleteOne')
      : t('tool.imageGenerationComplete', { count: completeCount })
  const failedLabel = allEdits
    ? t('tool.imageGenerationEditFailed')
    : t('tool.imageGenerationFailed')
  const statusLabel = hasPending
    ? waitingLabel
    : hasError
      ? failedLabel
      : completeLabel
  const firstItem = itemViews[0]
  const firstPrompt = stringValue(firstItem?.inputRecord.prompt) ?? firstItem?.parsedResult?.prompt ?? ''
  const firstResult = firstItem?.parsedResult
  const visibleDuration = items.length === 1
    ? items[0]?.durationMs ?? firstResult?.durationMs
    : undefined
  const isFailed = !hasPending && hasError

  const railContent = slots.map((slot) => {
    if (slot.state === 'complete' && slot.image && slot.galleryIndex !== undefined) {
      const src = localImageFileUrl(slot.image.path)
      return (
        <button
          key={slot.key}
          type="button"
          data-testid="image-generation-slot"
          data-state="complete"
          onClick={() => setActiveIndex(slot.galleryIndex!)}
          className="group/image relative aspect-square w-full overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border-separator)] bg-[var(--color-surface-container-low)] text-left shadow-[var(--shadow-card)] transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-[var(--color-outline)] hover:shadow-[var(--shadow-composer)] active:translate-y-0 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
        >
          <img
            src={src}
            alt={t('tool.generatedImageAlt', { index: slot.galleryIndex + 1 })}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover/image:scale-[1.025]"
          />
          <span className="absolute bottom-2 right-2 flex h-7 w-7 translate-y-1 items-center justify-center rounded-full border border-[var(--color-border-separator)] bg-[var(--color-surface)] text-[var(--color-text-primary)] opacity-0 shadow-[var(--shadow-card)] transition-[opacity,transform] duration-200 group-hover/image:translate-y-0 group-hover/image:opacity-100 group-focus-visible/image:translate-y-0 group-focus-visible/image:opacity-100">
            <Maximize2 aria-hidden size={14} strokeWidth={1.75} />
          </span>
        </button>
      )
    }

    if (slot.state === 'pending') {
      return (
        <div
          key={slot.key}
          data-testid="image-generation-slot"
          data-state="pending"
          className="aspect-square w-full overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border-separator)] bg-[var(--color-surface-container-low)]"
        >
          <Skeleton shape="block" width="100%" height="100%" radius="lg" tone="strong" />
        </div>
      )
    }

    return (
      <div
        key={slot.key}
        data-testid="image-generation-slot"
        data-state="error"
        data-error="true"
        title={slot.message}
        className="flex aspect-square w-full flex-col items-center justify-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-error)] bg-[var(--color-error-container)] p-3 text-center text-[11px] leading-relaxed text-[var(--color-on-error-container)]"
      >
        <TriangleAlert aria-hidden size={17} strokeWidth={1.75} className="shrink-0" />
        <span className="line-clamp-4">{slot.message}</span>
      </div>
    )
  })

  return (
    <div
      data-testid="image-generation-block"
      data-layout="thumbnail-rail"
      className={`min-w-0 ${compact ? 'mb-0' : 'mb-3'}`}
    >
      <div
        className="mb-2 flex min-h-5 items-center gap-1.5 text-[12px] text-[var(--color-text-tertiary)]"
        title={firstResult
          ? `${firstResult.model} · ${firstResult.providerId}${firstPrompt ? ` · ${firstPrompt}` : ''}`
          : firstPrompt || undefined}
      >
        {isFailed ? (
          <TriangleAlert aria-hidden size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-error)]" />
        ) : (
          <ImageIcon aria-hidden size={14} strokeWidth={1.75} className="shrink-0" />
        )}
        <span className={isFailed ? 'text-[var(--color-on-error-container)]' : undefined}>
          {statusLabel}
        </span>
        {hasPending ? (
          <span
            aria-hidden
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-text-tertiary)]"
          />
        ) : null}
        {!hasPending && typeof visibleDuration === 'number' ? (
          <span className="font-mono tabular-nums text-[var(--color-outline)]">
            {formatDuration(visibleDuration)}
          </span>
        ) : null}
      </div>

      <div data-testid="image-generation-rail">
        {hasPending ? (
          <SkeletonGroup label={waitingLabel} className={THUMBNAIL_RAIL_CLASS}>
            {railContent}
          </SkeletonGroup>
        ) : (
          <div className={THUMBNAIL_RAIL_CLASS}>
            {railContent}
          </div>
        )}
      </div>

      {activeIndex !== null && galleryImages[activeIndex] ? (
        <ImageGalleryModal
          open
          images={galleryImages}
          activeIndex={activeIndex}
          onClose={() => setActiveIndex(null)}
          onSelect={setActiveIndex}
        />
      ) : null}
    </div>
  )
}

export function parseImageGenerationResult(content: unknown): ImageGenerationResult | null {
  const value = parseContentValue(content)
  if (
    !isRecord(value) ||
    value.type !== 'image_generation_result' ||
    typeof value.providerId !== 'string' ||
    typeof value.providerKind !== 'string' ||
    typeof value.model !== 'string' ||
    typeof value.prompt !== 'string' ||
    typeof value.durationMs !== 'number' ||
    !Array.isArray(value.images)
  ) {
    return null
  }

  const images = value.images.flatMap((item): GeneratedImage[] => {
    if (!isRecord(item) || typeof item.path !== 'string' || typeof item.mimeType !== 'string') {
      return []
    }
    return [{
      path: item.path,
      mimeType: item.mimeType,
      ...(typeof item.revisedPrompt === 'string'
        ? { revisedPrompt: item.revisedPrompt }
        : {}),
    }]
  })
  if (images.length === 0) return null

  return {
    type: 'image_generation_result',
    operation: value.operation === 'edit' ? 'edit' : 'generate',
    inputImageCount: typeof value.inputImageCount === 'number'
      ? value.inputImageCount
      : 0,
    providerId: value.providerId,
    providerKind: value.providerKind,
    model: value.model,
    prompt: value.prompt,
    images,
    durationMs: value.durationMs,
  }
}

function parseContentValue(content: unknown): unknown {
  if (isRecord(content)) return content
  const text = contentText(content)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((item) => typeof item === 'string'
        ? item
        : isRecord(item) && typeof item.text === 'string'
          ? item.text
          : '')
      .filter(Boolean)
      .join('\n')
  }
  return isRecord(content) ? JSON.stringify(content) : ''
}

function integerInRange(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`
  const seconds = Math.round(durationMs / 100) / 10
  return `${seconds}s`
}
