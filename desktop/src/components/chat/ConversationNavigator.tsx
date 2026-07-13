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
  role: 'user' | 'assistant'
  preview: string
  attachmentCount: number
}

export type ConversationNavigationMode = 'full' | 'compact' | 'edge'

const NAVIGATION_MODE_STYLES: Record<ConversationNavigationMode, {
  position: string
  lane: string
  button: string
  restingWidth: number
  expandedWidth: number
}> = {
  full: {
    position: 'left-2',
    lane: 'w-16',
    button: 'w-16 pl-1.5',
    restingWidth: 12,
    expandedWidth: 52,
  },
  compact: {
    position: 'left-1',
    lane: 'w-9',
    button: 'w-9 pl-1',
    restingWidth: 10,
    expandedWidth: 32,
  },
  edge: {
    position: 'left-0',
    lane: 'w-6',
    button: 'w-6 pl-0.5',
    restingWidth: 6,
    expandedWidth: 20,
  },
}

const NAVIGATION_ITEM_HEIGHT_PX = 16
const NAVIGATION_ITEM_GAP_PX = 2
const NAVIGATION_LANE_PADDING_PX = 8
const NAVIGATION_WAVE_RADIUS_ITEMS = 4

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
  return sources.flatMap(({ message, renderItemKey, renderIndex }) => {
    if (message.type !== 'user_text' && message.type !== 'assistant_text') return []
    const preview = normalizePreview(message.content)
    if (!preview) return []

    return [{
      id: message.id,
      renderItemKey,
      renderIndex,
      role: message.type === 'user_text' ? 'user' : 'assistant',
      preview,
      attachmentCount: message.type === 'user_text' ? message.attachments?.length ?? 0 : 0,
    }]
  })
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
        className={`conversation-navigation-scroll flex max-h-full flex-col items-start gap-0.5 overflow-y-auto overflow-x-hidden py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${modeStyles.lane}`}
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
          const roleLabel = item.role === 'user'
            ? t('chat.userMessageReference')
            : t('chat.assistantMessageReference')
          const isActive = item.id === activeItemId
          const isInteractionTarget = interactionIndex !== null && Math.round(interactionIndex) === itemIndex
          const markerWidth = getMarkerWidth(
            modeStyles.restingWidth,
            modeStyles.expandedWidth,
            itemIndex,
            interactionIndex,
          )

          return (
            <div key={item.id} className="relative flex shrink-0 items-center">
              <button
                ref={(node) => {
                  if (node) markerRefs.current.set(item.id, node)
                  else markerRefs.current.delete(item.id)
                }}
                type="button"
                data-role={item.role}
                aria-label={`${roleLabel}: ${item.preview}`}
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
                className={`group flex h-4 items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/35 ${modeStyles.button}`}
              >
                <span
                  aria-hidden="true"
                  className={[
                    'block h-0.5 rounded-full transition-[width,background-color,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                    isInteractionTarget
                      ? 'bg-[var(--color-text-primary)] opacity-100'
                      : isActive
                      ? 'bg-[var(--color-brand)] opacity-100'
                      : item.role === 'user'
                        ? 'bg-[var(--color-text-secondary)] opacity-75 group-hover:bg-[var(--color-text-primary)] group-hover:opacity-100 group-focus-visible:bg-[var(--color-text-primary)] group-focus-visible:opacity-100'
                        : 'bg-[var(--color-outline)] opacity-65 group-hover:bg-[var(--color-text-secondary)] group-hover:opacity-100 group-focus-visible:bg-[var(--color-text-secondary)] group-focus-visible:opacity-100',
                  ].join(' ')}
                  style={{ width: markerWidth }}
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
          className="fixed z-50 w-[min(320px,calc(100vw-88px))] -translate-y-1/2 rounded-xl border border-[var(--color-border)]/80 bg-[var(--color-surface-container-lowest)] px-3.5 py-3 text-left shadow-[var(--shadow-dropdown)]"
          style={{ left: previewPosition.left, top: previewPosition.top }}
        >
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
            {previewItem.role === 'user' ? t('chat.userMessageReference') : t('chat.assistantMessageReference')}
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
