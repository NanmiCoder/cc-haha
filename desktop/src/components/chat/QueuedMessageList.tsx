import { useState, type CSSProperties } from 'react'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  sortableKeyboardCoordinates,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowDown, ArrowUp, CornerDownRight, GripVertical, Pencil, Trash2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation } from '@/i18n'
import { useChatStore, type QueuedUserMessage } from '@/stores/chatStore'

/**
 * Prompts waiting behind the running turn. Order is the send order: rows can
 * be dragged (mouse on desktop, pointer/touch on the H5 shell) or moved with
 * the up/down buttons, which also serve keyboard and one-handed use. Moving a
 * row never sends it; only the turn completing, the guide button, or an
 * explicit send does.
 */
export function QueuedMessageList({
  sessionId,
  messages,
  pausedReason,
  guideDisabled,
}: {
  sessionId: string
  messages: QueuedUserMessage[]
  pausedReason?: string
  guideDisabled: boolean
}) {
  const { updateQueuedUserMessage, removeQueuedUserMessage, reorderQueuedUserMessage, sendQueuedUserMessage } =
    useChatStore(useShallow((store) => ({
      updateQueuedUserMessage: store.updateQueuedUserMessage,
      removeQueuedUserMessage: store.removeQueuedUserMessage,
      reorderQueuedUserMessage: store.reorderQueuedUserMessage,
      sendQueuedUserMessage: store.sendQueuedUserMessage,
    })))
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const ids = messages.map((message) => message.id)

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const targetIndex = ids.indexOf(String(over.id))
    if (targetIndex === -1) return
    reorderQueuedUserMessage(sessionId, String(active.id), targetIndex)
  }

  const startEditing = (message: QueuedUserMessage) => {
    setEditingId(message.id)
    setEditingText(message.displayContent)
  }
  const cancelEditing = () => {
    setEditingId(null)
    setEditingText('')
  }
  const saveEditing = () => {
    if (!editingId) return
    const nextContent = editingText.trim()
    if (!nextContent) return
    updateQueuedUserMessage(sessionId, editingId, nextContent)
    cancelEditing()
  }

  return (
    // Docked top seam banner inset past the composer's 16px rounded top corners.
    <div
      data-testid="pending-user-message-list"
      className="surface-glass composer-seam-above relative z-[var(--z-base)] mx-5 -mb-4 flex flex-col gap-1.5 rounded-t-[var(--radius-2xl)] border border-b-0 border-[var(--color-surface-glass-border)] px-3 pb-5 pt-2.5"
    >
      {pausedReason ? (
        <p
          role="status"
          className="rounded-[var(--radius-sm)] bg-[var(--color-warning-container)] px-2 py-1 text-xs leading-[1.5] text-[var(--color-on-warning-container)]"
        >
          {pausedReason}
        </p>
      ) : null}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {messages.map((message, index) => (
            <SortableQueuedMessageRow
              key={message.id}
              message={message}
              index={index}
              count={messages.length}
              editing={editingId === message.id}
              editingText={editingText}
              onEditingTextChange={setEditingText}
              onSaveEditing={saveEditing}
              onCancelEditing={cancelEditing}
              onStartEditing={() => startEditing(message)}
              onGuide={() => sendQueuedUserMessage(sessionId, message.id)}
              guideDisabled={guideDisabled}
              onDelete={() => {
                if (editingId === message.id) cancelEditing()
                removeQueuedUserMessage(sessionId, message.id)
              }}
              onMove={(toIndex) => reorderQueuedUserMessage(sessionId, message.id, toIndex)}
            />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  )
}

function SortableQueuedMessageRow({
  message,
  index,
  count,
  editing,
  editingText,
  onEditingTextChange,
  onSaveEditing,
  onCancelEditing,
  onStartEditing,
  onGuide,
  guideDisabled,
  onDelete,
  onMove,
}: {
  message: QueuedUserMessage
  index: number
  count: number
  editing: boolean
  editingText: string
  onEditingTextChange: (text: string) => void
  onSaveEditing: () => void
  onCancelEditing: () => void
  onStartEditing: () => void
  onGuide: () => void
  guideDisabled: boolean
  onDelete: () => void
  onMove: (toIndex: number) => void
}) {
  const t = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: message.id,
    disabled: editing || count < 2,
  })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 'var(--z-raised)' : undefined,
  }
  const moveUpLabel = t('chat.pendingMessageMoveUp')
  const moveDownLabel = t('chat.pendingMessageMoveDown')

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid="pending-user-message"
      className={[
        'flex min-h-9 min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] py-1 pl-1 pr-1',
        'border border-dashed border-[var(--color-outline)] bg-[var(--color-surface-container-low)]',
        'text-[13px] text-[var(--color-text-secondary)]',
        isDragging ? 'opacity-90 shadow-[var(--shadow-dropdown)]' : '',
      ].join(' ')}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t('chat.pendingMessageReorderHandle')}
        title={t('chat.pendingMessageReorderHandle')}
        disabled={editing || count < 2}
        style={{ touchAction: 'none' }}
        className="flex h-6 w-4 shrink-0 cursor-grab items-center justify-center rounded-[var(--radius-xs)] text-[var(--color-text-tertiary)] transition-opacity duration-150 hover:text-[var(--color-text-secondary)] focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
      >
        <GripVertical size={13} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <span className="shrink-0 text-xs text-[var(--color-text-tertiary)]">
        {t('chat.pendingMessageQueuedLabel')}
      </span>
      {editing ? (
        <>
          <input
            value={editingText}
            onChange={(event) => onEditingTextChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                onSaveEditing()
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                onCancelEditing()
              }
            }}
            aria-label={t('chat.pendingMessageEditInput')}
            className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-border-focus)]"
            autoFocus
          />
          <Button
            variant="primary"
            size="sm"
            onClick={onSaveEditing}
            disabled={!editingText.trim()}
            className="shrink-0"
          >
            {t('common.save')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancelEditing} className="shrink-0">
            {t('common.cancel')}
          </Button>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate font-medium" title={message.displayContent}>
            {message.displayContent}
          </span>
          <IconButton
            icon={<ArrowUp size={13} strokeWidth={1.75} aria-hidden="true" />}
            label={moveUpLabel}
            size="xs"
            tone="muted"
            disabled={index === 0}
            onClick={() => onMove(index - 1)}
          />
          <IconButton
            icon={<ArrowDown size={13} strokeWidth={1.75} aria-hidden="true" />}
            label={moveDownLabel}
            size="xs"
            tone="muted"
            disabled={index === count - 1}
            onClick={() => onMove(index + 1)}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={guideDisabled}
            onClick={onGuide}
            aria-label={t('chat.pendingMessageGuideNow')}
            title={t('chat.pendingMessageGuideNow')}
            className="shrink-0"
            icon={<CornerDownRight size={14} strokeWidth={1.75} aria-hidden="true" />}
          >
            {t('chat.pendingMessageGuide')}
          </Button>
          <IconButton
            icon={<Pencil size={14} strokeWidth={1.75} aria-hidden="true" />}
            label={t('chat.pendingMessageEdit')}
            size="sm"
            tone="muted"
            onClick={onStartEditing}
          />
          <IconButton
            icon={<Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />}
            label={t('chat.pendingMessageDelete')}
            size="sm"
            tone="muted"
            hoverTone="danger"
            onClick={onDelete}
          />
        </>
      )}
    </div>
  )
}
