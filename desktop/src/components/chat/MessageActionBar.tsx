import { CopyButton } from '../shared/CopyButton'

type MessageAction = {
  label: string
  displayLabel: string
  onClick: () => void
  disabled?: boolean
  tone?: 'default' | 'danger'
}

type Props = {
  copyText?: string
  copyLabel: string
  align?: 'start' | 'end'
  actions?: MessageAction[]
}

export function MessageActionBar({
  copyText,
  copyLabel,
  align = 'start',
  actions = [],
}: Props) {
  const hasCopy = Boolean(copyText?.trim())
  const hasActions = actions.length > 0

  if (!hasCopy && !hasActions) return null

  const buttonClass =
    'inline-flex min-h-7 items-center rounded-full border border-[var(--color-border)]/70 bg-[var(--color-surface-container-low)] px-2.5 text-[11px] font-medium text-[var(--color-text-tertiary)] transition-colors hover:border-[var(--color-brand)]/35 hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/35 disabled:cursor-not-allowed disabled:opacity-50'

  return (
    <div
      data-message-actions
      data-align={align}
      className={`flex w-full opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100 ${
        align === 'end' ? 'justify-end' : 'justify-start'
      }`}
    >
      <div className="flex items-center gap-1.5">
        {hasCopy && (
          <CopyButton
            text={copyText!}
            label={copyLabel}
            displayLabel="Copy"
            displayCopiedLabel="Copied"
            className={buttonClass}
          />
        )}
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={action.onClick}
            disabled={action.disabled}
            aria-label={action.label}
            title={action.label}
            className={`${buttonClass} ${
              action.tone === 'danger'
                ? 'hover:border-[var(--color-error)]/45 hover:text-[var(--color-error)]'
                : ''
            }`}
          >
            {action.displayLabel}
          </button>
        ))}
      </div>
    </div>
  )
}
