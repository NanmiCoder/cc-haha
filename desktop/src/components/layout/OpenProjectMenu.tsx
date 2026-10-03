import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useOpenTargetStore } from '../../stores/openTargetStore'
import { useDismissable } from '@/hooks/useDismissable'
import { TargetIcon } from '@/components/composite/TargetIcon'

type Props = {
  path: string | null | undefined
}

export function OpenProjectMenu({ path }: Props) {
  const t = useTranslation()
  const targets = useOpenTargetStore((state) => state.targets)
  const primaryTargetId = useOpenTargetStore((state) => state.primaryTargetId)
  const ensureTargets = useOpenTargetStore((state) => state.ensureTargets)
  const openTarget = useOpenTargetStore((state) => state.openTarget)
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!path) {
      setOpen(false)
      return
    }
    void ensureTargets()
  }, [ensureTargets, path])

  const handleDismiss = useCallback(() => setOpen(false), [])

  useDismissable({
    open,
    refs: [menuRef],
    triggerRef: buttonRef,
    onDismiss: handleDismiss,
  })

  const primaryTarget = useMemo(
    () => targets.find((target) => target.id === primaryTargetId) ?? targets[0] ?? null,
    [primaryTargetId, targets],
  )
  const hasMenu = targets.length > 1

  const handleOpenTarget = async (targetId: string) => {
    if (!path) return
    try {
      await openTarget(targetId, path)
    } catch {
      // Store state already records the failure; keep the control responsive.
    } finally {
      setOpen(false)
    }
  }

  if (!path || !primaryTarget) return null

  const buttonLabel = hasMenu
    ? t('openProject.openProject')
    : t('openProject.openIn', { target: primaryTarget.label })

  const rect = buttonRef.current?.getBoundingClientRect()

  return (
    <div className="relative flex items-center">
      <button
        ref={buttonRef}
        type="button"
        aria-label={buttonLabel}
        aria-haspopup={hasMenu ? 'menu' : undefined}
        aria-expanded={hasMenu ? open : undefined}
        title={buttonLabel}
        onClick={() => {
          if (hasMenu) {
            setOpen((value) => !value)
            return
          }
          void handleOpenTarget(primaryTarget.id)
        }}
        className={`inline-flex h-8 items-center justify-center gap-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] text-[var(--color-text-tertiary)] transition-[background-color,color,border-color,box-shadow] duration-150 ease-out hover:border-[var(--color-outline)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] ${
          hasMenu
            ? 'min-w-[2.75rem] px-2 hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
            : 'w-8 hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
        }`}
      >
        <TargetIcon target={primaryTarget} />
        {hasMenu && <ChevronDown size={14} strokeWidth={1.9} />}
      </button>

      {open && hasMenu && rect ? createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="glass-panel fixed z-[var(--z-dropdown)] min-w-[220px] overflow-hidden rounded-[var(--radius-lg)] py-1"
          style={{ top: rect.bottom + 6, right: Math.max(12, window.innerWidth - rect.right) }}
        >
          {targets.map((target) => (
            <button
              key={target.id}
              type="button"
              role="menuitem"
              onClick={() => void handleOpenTarget(target.id)}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:bg-[var(--color-surface-hover)]"
            >
              <span className="flex h-7 w-7 items-center justify-center text-[var(--color-text-secondary)]">
                <TargetIcon target={target} size={24} />
              </span>
              <span className="min-w-0 truncate">{target.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </div>
  )
}
