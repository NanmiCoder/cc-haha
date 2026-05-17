import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Code2, FolderOpen } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useOpenTargetStore, type OpenTarget } from '../../stores/openTargetStore'

type Props = {
  path: string | null | undefined
}

function getFallbackIcon(kind: 'ide' | 'file_manager', size = 17) {
  if (kind === 'file_manager') {
    return <FolderOpen size={size} strokeWidth={1.9} />
  }
  return <Code2 size={size} strokeWidth={1.9} />
}

function TargetIcon({ target, size = 18 }: { target: OpenTarget; size?: number }) {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [target.iconUrl])

  if (target.iconUrl && !failed) {
    return (
      <img
        src={target.iconUrl}
        alt=""
        aria-hidden="true"
        draggable={false}
        onError={() => setFailed(true)}
        className="block shrink-0 object-contain"
        style={{ width: size, height: size }}
      />
    )
  }

  return getFallbackIcon(target.kind, Math.max(16, size - 1))
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

  useEffect(() => {
    if (!open) return

    const handleDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', handleDocumentMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

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
        className={`inline-flex h-8 items-center justify-center gap-1 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] text-[var(--color-text-tertiary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
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
          className="fixed z-50 min-w-[220px] overflow-hidden rounded-[12px] border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-[var(--shadow-dropdown)]"
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
