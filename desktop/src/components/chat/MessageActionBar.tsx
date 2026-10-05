import { Check, Copy, GitFork, Pencil } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { formatExactMessageTimestamp, formatMessageHoverTime } from '../../lib/formatMessageTimestamp'
import { CopyButton } from '@/components/ui/CopyButton'
import { IconButton } from '@/components/ui/IconButton'

export type MessageBranchAction = {
  label: string
  loading?: boolean
  onBranch: () => void
}

export type MessageEditAction = {
  label: string
  disabled?: boolean
  /** Shown on hover while disabled, so the action says why rather than vanishing. */
  disabledReason?: string
  onEdit: () => void
}

/**
 * The copy chip and the branch chip sit side by side and must look identical.
 * The branch one is an `IconButton size="xs" tone="muted"`; `CopyButton` is
 * styled by className, so its shell is mirrored here.
 */
const ACTION_CHIP_CLASS = [
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)]',
  'text-[var(--color-text-tertiary)] transition-colors duration-150 cursor-pointer',
  'hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]',
].join(' ')

const ICON_SIZE = 14
const ICON_STROKE = 1.75

type Props = {
  copyText?: string
  copyLabel: string
  branchAction?: MessageBranchAction
  editAction?: MessageEditAction
  align?: 'start' | 'end'
  timestamp?: number
  /** Inline metadata that shares the same compact row as the actions. */
  metadata?: ReactNode
  /**
   * Skip the hover gate. For bars that are already rare and deliberate — the
   * reply that closes a turn — where hiding them until hover only makes a
   * present affordance hard to find.
   */
  alwaysVisible?: boolean
  /**
   * `overlay` hangs the bar just under its message, absolutely positioned, so a
   * hover-only bar never holds the transcript open by its own height. The
   * caller's shell must be `relative`; the space it lands in is the turn gap
   * that `.chat-turn-rail--none` already reserves, not something the bar adds.
   */
  placement?: 'inline' | 'overlay'
}

export function MessageActionBar({
  copyText,
  copyLabel,
  branchAction,
  editAction,
  align = 'start',
  timestamp,
  metadata,
  alwaysVisible = false,
  placement = 'inline',
}: Props) {
  const locale = useSettingsStore((state) => state.locale)
  const editReasonId = useId()
  const hasCopy = Boolean(copyText?.trim())
  const hoverTimeLabel = typeof timestamp === 'number'
    ? formatMessageHoverTime(timestamp, locale)
    : ''
  const exactTimeLabel = typeof timestamp === 'number'
    ? formatExactMessageTimestamp(timestamp, locale)
    : ''

  if (!hasCopy && !branchAction && !editAction && !metadata) return null

  return (
    <div
      data-message-actions
      data-align={align}
      data-placement={placement}
      className={[
        'flex h-6 transition-opacity duration-150',
        placement === 'overlay'
          ? `absolute top-full ${align === 'end' ? 'right-0' : 'left-0'}`
          : 'mt-1.5 w-full',
        alwaysVisible
          ? ''
          : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100',
        align === 'end' ? 'justify-end' : 'justify-start',
      ].filter(Boolean).join(' ')}
    >
      <div className="flex min-h-6 min-w-0 items-center gap-0.5">
        {hasCopy ? (
          <CopyButton
            text={copyText!}
            label={copyLabel}
            displayLabel={<Copy size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
            displayCopiedLabel={<Check size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
            onPointerUp={(event) => event.currentTarget.blur()}
            className={ACTION_CHIP_CLASS}
          />
        ) : null}
        {branchAction ? (
          <IconButton
            icon={<GitFork size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
            label={branchAction.label}
            size="xs"
            tone="muted"
            disabled={branchAction.loading}
            onClick={branchAction.onBranch}
            onPointerUp={(event) => event.currentTarget.blur()}
          />
        ) : null}
        {editAction?.disabled && editAction.disabledReason ? (
          // A disabled button takes no pointer events, so its own title would
          // never show. The reason hangs on a wrapper that still hovers.
          <span className="inline-flex" title={editAction.disabledReason}>
            <IconButton
              icon={<Pencil size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
              label={editAction.label}
              showTooltip={false}
              size="xs"
              tone="muted"
              disabled
              aria-describedby={editReasonId}
            />
            <span id={editReasonId} className="sr-only">{editAction.disabledReason}</span>
          </span>
        ) : editAction ? (
          <IconButton
            icon={<Pencil size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
            label={editAction.label}
            size="xs"
            tone="muted"
            disabled={editAction.disabled}
            onClick={editAction.onEdit}
            onPointerUp={(event) => event.currentTarget.blur()}
          />
        ) : null}
        {metadata ? (
          <span className={hasCopy || branchAction || editAction ? 'ml-2 min-w-0' : 'min-w-0'}>
            {metadata}
          </span>
        ) : null}
        {hoverTimeLabel ? (
          <span
            className="ml-1.5 inline-flex items-center whitespace-nowrap text-xs tabular-nums text-[var(--color-text-tertiary)]"
            title={exactTimeLabel || hoverTimeLabel}
          >
            {hoverTimeLabel}
          </span>
        ) : null}
      </div>
    </div>
  )
}
