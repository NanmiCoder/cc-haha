import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Trash2 } from 'lucide-react'
import { useTranslation } from '../../../i18n'
import { useSelectionPopoverDismiss } from '../../../hooks/useSelectionPopoverDismiss'
import { Button } from '@/components/ui/Button'

export type ChatAnnotationEditorProps = {
  /** Viewport rect of the trigger: a transcript badge, or a composer chip. */
  anchorRect: DOMRect
  quote: string
  initialNote: string
  onSave: (note: string) => void
  /** Absent while creating an annotation — there is nothing to delete yet. */
  onDelete?: () => void
  onClose: () => void
}

const EDITOR_WIDTH = 340
/**
 * The editor's own box, used to pick the side of the trigger it fits on. It is
 * a constant rather than a measurement because the popover has a fixed shape
 * (two-line quote, one-line field, one button row) and measuring after paint
 * would first place it on the wrong side for a frame.
 */
const EDITOR_HEIGHT = 176
const ANCHOR_OFFSET = 8
const VIEWPORT_MARGIN = 12

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function getEditorPosition(anchorRect: DOMRect) {
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || EDITOR_WIDTH + VIEWPORT_MARGIN * 2
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || EDITOR_HEIGHT + VIEWPORT_MARGIN * 2
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - EDITOR_WIDTH - VIEWPORT_MARGIN)
  const maxTop = Math.max(VIEWPORT_MARGIN, viewportHeight - EDITOR_HEIGHT - VIEWPORT_MARGIN)
  const left = clamp(anchorRect.left, VIEWPORT_MARGIN, maxLeft)
  const below = anchorRect.bottom + ANCHOR_OFFSET
  if (below <= maxTop) return { left, top: below }
  return { left, top: clamp(anchorRect.top - EDITOR_HEIGHT - ANCHOR_OFFSET, VIEWPORT_MARGIN, maxTop) }
}

/**
 * The one editor behind every annotation affordance: creating one from the
 * text-selection menu, and editing or deleting an existing one from its
 * transcript badge or its composer chip. Mount it under a key that changes with
 * the annotation so switching targets reseeds the field.
 */
export function ChatAnnotationEditor({
  anchorRect,
  quote,
  initialNote,
  onSave,
  onDelete,
  onClose,
}: ChatAnnotationEditorProps) {
  const t = useTranslation()
  const [note, setNote] = useState(initialNote)
  const popoverRef = useRef<HTMLDivElement>(null)
  const fieldId = useId()
  const trimmedNote = note.trim()
  const { left, top } = getEditorPosition(anchorRect)

  useSelectionPopoverDismiss({ active: true, popoverRef, onDismiss: onClose })

  const save = () => {
    // An annotation with no note is just a plain reference; the user can reach
    // that with "Add to chat", so a blank save is not a meaningful action here.
    if (trimmedNote) onSave(trimmedNote)
  }

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={t('chat.annotationEditorLabel')}
      className="fixed z-[var(--z-popover)] w-[340px] rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-2.5 shadow-[var(--shadow-overlay)]"
      style={{ left, top }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
          return
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          save()
        }
      }}
    >
      <div className="mb-2 line-clamp-2 border-l-2 border-[var(--color-selection-bg)] pl-2.5 text-[12px] leading-5 text-[var(--color-text-secondary)]">
        {quote}
      </div>
      <label htmlFor={fieldId} className="sr-only">{t('chat.annotationEditorLabel')}</label>
      <textarea
        id={fieldId}
        autoFocus
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder={t('chat.annotationNotePlaceholder')}
        className="h-[52px] w-full resize-none rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-2.5 py-2 text-[13px] leading-5 text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-brand)] focus:ring-2 focus:ring-[var(--color-brand-soft)]"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-[var(--color-text-tertiary)]">{t('chat.annotationSaveHint')}</span>
        <div className="flex items-center gap-1">
          {onDelete && (
            <Button
              variant="danger-ghost"
              size="sm"
              icon={<Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />}
              onClick={onDelete}
            >
              {t('chat.annotationDelete')}
            </Button>
          )}
          <Button variant="primary" size="sm" disabled={!trimmedNote} onClick={save}>
            {t('chat.annotationSave')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
