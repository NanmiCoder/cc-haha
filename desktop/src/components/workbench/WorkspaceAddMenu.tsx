import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition } from '@/hooks/useAnchoredPosition'
import { useDismissable } from '@/hooks/useDismissable'
import { useTranslation } from '@/i18n'
import type { WorkspaceDock, WorkspaceTabKind } from '@/lib/workspace/types'
import { useMenuKeyboard } from './menuKeyboard'
import { WorkspaceLauncher } from './WorkspaceLauncher'

export type WorkspaceAddMenuProps = {
  id: string
  anchorRef: RefObject<HTMLButtonElement>
  dock: WorkspaceDock
  initialFocus?: 'first' | 'last'
  reviewUnavailableReason?: string | null
  sideChatAvailable?: boolean
  onSelect: (kind: WorkspaceTabKind) => void
  onClose: () => void
}

/** The empty dock owns a launcher; the + button owns a menu over its current content. */
export function WorkspaceAddMenu({
  id, anchorRef, dock, initialFocus, reviewUnavailableReason, sideChatAvailable, onSelect, onClose,
}: WorkspaceAddMenuProps) {
  const t = useTranslation()
  const menuRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({
    open: true, anchorRef, floatingRef: menuRef,
    placement: 'bottom-start', offset: 1, viewportMargin: 6, clampHeight: true,
  })
  const dismiss = useCallback((reason: string) => {
    if (reason === 'escape') anchorRef.current?.focus({ preventScroll: true })
    onClose()
  }, [anchorRef, onClose])
  useDismissable({
    open: true, refs: [menuRef], triggerRef: anchorRef, onDismiss: dismiss,
    stopEscapePropagation: true, closeOnViewportChange: true,
  })
  const onKeyDown = useMenuKeyboard({
    // Hidden elements cannot take focus in Chromium. Wait for the measured
    // position to be committed instead of focusing the invisible first frame.
    open: position.ready, menuRef, triggerRef: anchorRef, onClose, initialFocus, loop: false,
  })
  useEffect(() => {
    window.addEventListener('blur', onClose)
    return () => window.removeEventListener('blur', onClose)
  }, [onClose])

  return createPortal(
    <div
      ref={menuRef}
      id={id}
      role="menu"
      aria-label={t('workspace.tabAdd')}
      data-testid="workspace-add-menu"
      data-placement={position.placement}
      onKeyDown={onKeyDown}
      style={position.style}
      className="z-[var(--z-dropdown)] w-[260px] max-w-[calc(100vw-12px)] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-1 shadow-[var(--shadow-dropdown)]"
    >
      <WorkspaceLauncher variant="menu" dock={dock} onSelect={onSelect} reviewUnavailableReason={reviewUnavailableReason} sideChatAvailable={sideChatAvailable} />
    </div>,
    document.body,
  )
}
