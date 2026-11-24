import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Paperclip } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { UIMessage } from '../../types/chat'

export type ConversationNavigationSource = {
  message: UIMessage
  renderItemKey: string
  renderIndex: number
}

export type ConversationNavigationItem = {
  id: string
  renderItemKey: string
  renderIndex: number
  turnNumber: number
  preview: string
  attachmentCount: number
}

export type ConversationNavigationMode = 'full' | 'compact' | 'edge'

const NAVIGATION_MODE_STYLES: Record<ConversationNavigationMode, {
  position: string
  lane: string
  button: string
  restingWidth: number
  activeWidth: number
  expandedWidth: number
}> = {
  full: {
    position: 'left-2',
    lane: 'w-10',
    button: 'w-10 pl-1',
    restingWidth: 7,
    activeWidth: 14,
    expandedWidth: 22,
  },
  compact: {
    position: 'left-1',
    lane: 'w-7',
    button: 'w-7 pl-0.5',
    restingWidth: 6,
    activeWidth: 12,
    expandedWidth: 18,
  },
  edge: {
    position: 'left-0',
    lane: 'w-5',
    button: 'w-5 pl-0.5',
    restingWidth: 4,
    activeWidth: 10,
    expandedWidth: 12,
  },
}

const NAVIGATION_ITEM_HEIGHT_PX = 12
const NAVIGATION_ITEM_GAP_PX = 1
const NAVIGATION_LANE_PADDING_PX = 6
const NAVIGATION_WAVE_RADIUS_ITEMS = 2

function getMarkerWidth(
  restingWidth: number,
  expandedWidth: number,
  itemIndex: number,
  interactionIndex: number | null,
) {
  if (interactionIndex === null) return restingWidth
  const distance = Math.abs(itemIndex - interactionIndex)
  if (distance >= NAVIGATION_WAVE_RADIUS_ITEMS) return restingWidth

  const proximity = 1 - distance / NAVIGATION_WAVE_RADIUS_ITEMS
  const easedProximity = Math.sin(proximity * Math.PI / 2) ** 2
  return restingWidth + (expandedWidth - restingWidth) * easedProximity
}

function normalizePreview(content: string) {
  const normalized = content.slice(0, 2_000)
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/```[a-z0-9_-]*\s*/gi, ' ')
    .replace(/```/g, ' ')
    .replace(/[`*_>#~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (normalized.length <= 280) return normalized
  return `${normalized.slice(0, 279).trimEnd()}…`
}

export function buildConversationNavigationItems(
  sources: ConversationNavigationSource[],
): ConversationNavigationItem[] {
  const items: ConversationNavigationItem[] = []

  for (const { message, renderItemKey, renderIndex } of sources) {
    if (message.type !== 'user_text') continue
    const attachmentPreview = message.attachments?.map((attachment) => attachment.name).join(', ') ?? ''
    const preview = normalizePreview(message.content) || normalizePreview(attachmentPreview)
    if (!preview) continue

    items.push({
      id: message.id,
      renderItemKey,
      renderIndex,
      turnNumber: items.length + 1,
      preview,
      attachmentCount: message.attachments?.length ?? 0,
    })
  }

  return items
}

export function ConversationNavigator({
  mode,
  items,
  activeItemId,
  onNavigate,
}: {
  mode: ConversationNavigationMode
  items: ConversationNavigationItem[]
  activeItemId: string | null
  onNavigate: (item: ConversationNavigationItem) => void
}) {
  const t = useTranslation()
  const [previewItemId, setPreviewItemId] = useState<string | null>(null)
  const [previewPosition, setPreviewPosition] = useState({ left: 0, top: 0 })
  const [pointerIndex, setPointerIndex] = useState<number | null>(null)
  const [focusIndex, setFocusIndex] = useState<number | null>(null)
  const markerRefs = useRef(new Map<string, HTMLButtonElement>())
  const previewItem = items.find((item) => item.id === previewItemId) ?? null
  const modeStyles = NAVIGATION_MODE_STYLES[mode]
  const interactionIndex = pointerIndex ?? focusIndex

  const openPreview = (itemId: string, marker: HTMLButtonElement) => {
    const rect = marker.getBoundingClientRect()
    setPreviewPosition({
      left: rect.right + 6,
      top: Math.min(window.innerHeight - 88, Math.max(88, rect.top + rect.height / 2)),
    })
    setPreviewItemId(itemId)
  }

  useEffect(() => {
    if (!activeItemId) return
    markerRefs.current.get(activeItemId)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeItemId])

  return (
    <nav
      data-testid="conversation-navigator"
      data-mode={mode}
      aria-label={t('chat.conversationNavigator.label')}
      className={`absolute top-1/2 z-30 flex max-h-[64%] -translate-y-1/2 flex-col overflow-visible ${modeStyles.position}`}
    >
      <div
        className={`conversation-navigation-scroll flex max-h-full flex-col items-start gap-px overflow-y-auto overflow-x-hidden py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${modeStyles.lane}`}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          const firstItemCenter = NAVIGATION_LANE_PADDING_PX + NAVIGATION_ITEM_HEIGHT_PX / 2
          const pointerOffset = event.clientY - rect.top + event.currentTarget.scrollTop
          const nextPointerIndex = (pointerOffset - firstItemCenter) /
            (NAVIGATION_ITEM_HEIGHT_PX + NAVIGATION_ITEM_GAP_PX)
          setPointerIndex(Math.min(items.length - 1, Math.max(0, nextPointerIndex)))
        }}
        onMouseLeave={() => setPointerIndex(null)}
      >
        {items.map((item, itemIndex) => {
          const turnLabel = t('chat.conversationNavigator.turn', {
            current: item.turnNumber,
            total: items.length,
          })
          const isActive = item.id === activeItemId
          const isInteractionTarget = interactionIndex !== null && Math.round(interactionIndex) === itemIndex
          const restingMarkerWidth = getMarkerWidth(
            modeStyles.restingWidth,
            modeStyles.expandedWidth,
            itemIndex,
            interactionIndex,
          )
          const markerWidth = isActive ? modeStyles.activeWidth : restingMarkerWidth

          return (
            <div key={item.id} className="relative flex shrink-0 items-center">
              <button
                ref={(node) => {
                  if (node) markerRefs.current.set(item.id, node)
                  else markerRefs.current.delete(item.id)
                }}
                type="button"
                data-turn-number={item.turnNumber}
                aria-label={`${turnLabel}: ${item.preview}`}
                aria-current={isActive ? 'location' : undefined}
                aria-describedby={previewItemId === item.id ? 'conversation-navigation-preview' : undefined}
                onMouseEnter={(event) => openPreview(item.id, event.currentTarget)}
                onMouseLeave={(event) => {
                  if (document.activeElement !== event.currentTarget) setPreviewItemId(null)
                }}
                onFocus={(event) => {
                  setFocusIndex(itemIndex)
                  openPreview(item.id, event.currentTarget)
                }}
                onBlur={() => {
                  setFocusIndex(null)
                  setPreviewItemId(null)
                }}
                onClick={() => onNavigate(item)}
                className={`group flex h-3 items-center rounded-[var(--radius-sm)] focus-visible:outline-none ${modeStyles.button}`}
              >
                <span
                  aria-hidden="true"
                  className={[
                    'block origin-left rounded-full transition-[transform,background-color,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-focus-visible:ring-1 group-focus-visible:ring-[var(--color-border-focus)] group-focus-visible:ring-offset-1 group-focus-visible:ring-offset-[var(--color-surface)] motion-reduce:transition-none',
                    isActive
                      ? 'h-0.5 bg-[var(--color-brand)] opacity-100'
                      : isInteractionTarget
                      ? 'h-px bg-[var(--color-text-primary)] opacity-100'
                      : 'h-px bg-[var(--color-text-secondary)] opacity-65 group-hover:bg-[var(--color-text-primary)] group-hover:opacity-100 group-focus-visible:bg-[var(--color-text-primary)] group-focus-visible:opacity-100',
                  ].join(' ')}
                  style={{
                    width: modeStyles.restingWidth,
                    transform: `scaleX(${markerWidth / modeStyles.restingWidth})`,
                  }}
                />
              </button>

            </div>
          )
        })}
      </div>
      {previewItem ? createPortal(
        <div
          id="conversation-navigation-preview"
          data-testid="conversation-navigation-preview"
          role="tooltip"
          className="fixed z-[var(--z-tooltip)] w-[min(320px,calc(100vw-88px))] -translate-y-1/2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3.5 py-3 text-left shadow-[var(--shadow-overlay)]"
          style={{ left: previewPosition.left, top: previewPosition.top }}
        >
          <div className="mb-1 text-xs font-semibold tabular-nums text-[var(--color-text-tertiary)]">
            {t('chat.conversationNavigator.turn', {
              current: previewItem.turnNumber,
              total: items.length,
            })}
          </div>
          <p className="line-clamp-3 text-[13px] leading-5 text-[var(--color-text-primary)]">
            {previewItem.preview}
          </p>
          {previewItem.attachmentCount > 0 ? (
            <div
              aria-label={t('chat.conversationNavigator.attachments', { count: previewItem.attachmentCount })}
              className="mt-2 flex items-center gap-1 text-[11px] text-[var(--color-text-tertiary)]"
            >
              <Paperclip size={12} strokeWidth={2} aria-hidden="true" />
              <span>{previewItem.attachmentCount}</span>
            </div>
          ) : null}
        </div>,
        document.body,
      ) : null}
    </nav>
  )
}
