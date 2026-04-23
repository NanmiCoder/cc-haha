import { CopyButton } from '../shared/CopyButton'

type Props = {
  copyText?: string
  copyLabel: string
}

export function MessageActionBar({
  copyText,
  copyLabel,
}: Props) {
  const hasCopy = Boolean(copyText?.trim())

  if (!hasCopy) return null

  return (
    <div className="shrink-0 pb-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
      <CopyButton
        text={copyText!}
        label={copyLabel}
        displayLabel="Copy"
        displayCopiedLabel="Copied"
        className="inline-flex min-h-7 items-center rounded-full border border-[var(--color-border)]/70 bg-[var(--color-surface)] px-2.5 text-[11px] font-medium text-[var(--color-text-tertiary)] transition-colors hover:border-[var(--color-brand)]/35 hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/35"
      />
    </div>
  )
}
