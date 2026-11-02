/** One row of a sidebar menu: a tertiary glyph and a label, or both in error ink. */
export function SidebarMenuItem({
  icon,
  children,
  onClick,
  disabled = false,
  danger = false,
  title,
}: {
  icon: React.ReactNode
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
  /** Explains a disabled item, which has no other way to say why. */
  title?: string
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={disabled ? undefined : onClick}
      className={`flex h-8 w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:bg-[var(--color-surface-hover)] disabled:cursor-default disabled:opacity-45 ${
        danger
          ? 'text-[var(--color-error)] enabled:hover:bg-[var(--color-error-container)]'
          : 'text-[var(--color-text-primary)] enabled:hover:bg-[var(--color-surface-hover)]'
      }`}
    >
      <span className={`flex h-4 w-4 shrink-0 items-center justify-center ${danger ? 'text-current' : 'text-[var(--color-text-tertiary)]'}`}>
        {icon}
      </span>
      <span className="min-w-0 truncate">{children}</span>
    </button>
  )
}
