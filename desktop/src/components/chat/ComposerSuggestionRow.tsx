import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'

type Props = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  id: string
  label: string
  description?: string
  details?: ReactNode
  icon?: ReactNode
  trailing?: ReactNode
  selected?: boolean
}

/** Shared dense row for composer capability and reference suggestions. */
export const ComposerSuggestionRow = forwardRef<HTMLDivElement, Props>(function ComposerSuggestionRow({
  id, label, description, details, icon, trailing, selected = false, className = '', ...rest
}, ref) {
  return <div ref={ref} id={id} role="option" tabIndex={-1} aria-selected={selected}
    aria-labelledby={`${id}-label`} aria-describedby={description || details ? `${id}-description` : undefined}
    className={`flex min-w-0 cursor-default items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${selected ? 'bg-[var(--color-surface-hover)]' : 'hover:bg-[var(--color-surface-hover)]'} ${className}`} {...rest}>
    {icon}
    {details ? <span className="min-w-0 flex-1 space-y-1">
      <span id={`${id}-label`} title={label} className="block truncate text-sm font-medium text-[var(--color-text-primary)]">{label}</span>
      <span id={`${id}-description`} className="flex min-w-0 items-center gap-2 text-[11px] leading-4 text-[var(--color-text-tertiary)]">{details}</span>
    </span> : <>
    <span id={`${id}-label`} className={`${description ? 'max-w-[45%] shrink-0' : 'min-w-0 flex-1'} truncate text-sm font-medium text-[var(--color-text-primary)]`}>{label}</span>
    {description ? <span id={`${id}-description`} className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-tertiary)]">{description}</span> : null}
    </>}
    {trailing}
  </div>
})
