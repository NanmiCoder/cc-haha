import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation } from '../../i18n'

/**
 * The floating card the local slash commands (/mcp, /skills, /help, /save-workflow)
 * open above the composer. Same shell as every other composer popover — white,
 * hairline border, `--radius-lg`, `--shadow-dropdown` — with a header band and a
 * scrolling body instead of `p-1` menu padding, because it holds content rather
 * than a list of choices.
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
  return (
    <div className="absolute bottom-full left-0 right-0 z-[var(--z-dropdown)] mb-2 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-dropdown)]">
      <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-snug text-[var(--color-text-primary)]">{title}</h3>
          <p className="mt-0.5 truncate text-xs text-[var(--color-text-tertiary)]">{subtitle}</p>
        </div>
        <IconButton
          icon={<X size={16} strokeWidth={1.75} aria-hidden="true" />}
          label={t('tabs.close')}
          size="sm"
          tone="muted"
          onClick={onClose}
        />
      </div>
      <div className="max-h-[min(620px,72vh)] overflow-y-auto p-4">{children}</div>
    </div>
  )
}
