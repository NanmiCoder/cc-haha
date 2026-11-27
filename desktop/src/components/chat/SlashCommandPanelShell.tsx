import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { Kbd } from '@/components/ui/Kbd'
import { useTranslation } from '../../i18n'
import { useRoomAbove } from '@/hooks/useRoomAbove'

/**
 * The docked frosted-glass card local slash commands (/mcp, /skills, /help, /save-workflow)
 * open above the composer. Uses the shared `.dropdown-glass` + `.popover-motion` surface
 * with `--radius-2xl` corners so it feels physically docked onto the floating composer.
 */
export function SlashCommandPanelShell({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: string
  subtitle: string
  children: ReactNode
  onClose: () => void
}) {
  const t = useTranslation()
  const [roomRef, roomAbove] = useRoomAbove<HTMLDivElement>()
  return (
    <div ref={roomRef} style={{ maxHeight: roomAbove }} className="dropdown-glass popover-motion absolute bottom-full left-0 right-0 z-[var(--z-dropdown)] mb-1.5 flex flex-col overflow-hidden rounded-[var(--radius-xl)]">
      <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-snug text-[var(--color-text-primary)]">{title}</h3>
          <p className="mt-0.5 truncate text-xs text-[var(--color-text-tertiary)]">{subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Kbd size="xs" appearance="subtle">Esc</Kbd>
          <IconButton
            icon={<X size={16} strokeWidth={1.75} aria-hidden="true" />}
            label={t('tabs.close')}
            size="sm"
            tone="muted"
            onClick={onClose}
          />
        </div>
      </div>
      <div className="scrollbar-autohide min-h-0 max-h-[min(620px,72vh)] overflow-y-auto p-4">{children}</div>
    </div>
  )
}
