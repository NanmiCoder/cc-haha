import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'

import { Switch } from '@/components/ui/Switch'
import { cx } from '@/lib/cx'

/**
 * The settings page skeleton (「素 Porcelain」).
 *
 * Every settings pane is built from the same five pieces, so all of them read
 * as one page rather than sixteen hand-laid ones:
 *
 *   <SettingsPageHeader title=… description=… action=… />   22px title + 13px line
 *   <SettingsSection title=…>                                13px semibold label
 *     <SettingsGroup>                                        white card, hairline rows
 *       <SettingsRow title=… description=…>{control}</SettingsRow>
 *       <SettingsSwitchRow title=… checked=… onChange=… />
 *       <SettingsBlock>{free-form content}</SettingsBlock>
 *     </SettingsGroup>
 *   </SettingsSection>
 *
 * The page frame itself — fluid up to `max-w-[1120px]`, centred, 40px gutters, 36px top —
 * is owned by the scroll container in `pages/Settings.tsx`, so a pane never
 * sets its own width. Panes rendered outside that shell (the touch H5 settings)
 * get their padding from their own host.
 */

export type SettingsPageHeaderProps = {
  title: ReactNode
  description?: ReactNode
  /** Right-aligned slot, normally the pane's primary ink button. */
  action?: ReactNode
  /** Id for the `<h2>`, when a surrounding region is labelled by it. */
  titleId?: string
  className?: string
}

/**
 * The pane's title row. The title is the nav label verbatim, so the rail and
 * the page never name the same place twice in two different words.
 */
export function SettingsPageHeader({ title, description, action, titleId, className }: SettingsPageHeaderProps) {
  return (
    <header className={cx('flex flex-wrap items-end gap-x-4 gap-y-3', className)}>
      <div className="min-w-0 flex-1">
        <h2 id={titleId} className="text-[22px] font-semibold leading-tight tracking-[-0.015em] text-[var(--color-text-primary)]">
          {title}
        </h2>
        {description ? (
          <p className="mt-1.5 max-w-[72ch] text-[13px] leading-5 text-[var(--color-text-tertiary)]">{description}</p>
        ) : null}
      </div>
      {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
    </header>
  )
}

export type SettingsSectionProps = {
  title: ReactNode
  /** Optional 12px line under the label, for sections whose rows need context. */
  description?: ReactNode
  /** Right-aligned slot beside the label, e.g. a small "Reset" button. */
  action?: ReactNode
  className?: string
  children?: ReactNode
}

/**
 * One labelled block of a pane: a 13px semibold secondary label sitting on top
 * of (normally) one `SettingsGroup`. Sections are spaced 28px apart and from
 * the page header.
 */
export function SettingsSection({ title, description, action, className, children }: SettingsSectionProps) {
  return (
    <section className={cx('mt-7', className)}>
      <div className="mb-2 flex items-end justify-between gap-3 px-0.5">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold leading-5 text-[var(--color-text-secondary)]">{title}</h3>
          {description ? (
            <p className="mt-0.5 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">{description}</p>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  )
}

export type SettingsGroupProps = {
  className?: string
  children?: ReactNode
} & Pick<HTMLAttributes<HTMLDivElement>, 'id' | 'role' | 'aria-label' | 'aria-labelledby'>

/**
 * The white card that holds a section's rows, with a hairline between each.
 *
 * Deliberately not `overflow-hidden`: rows host `Dropdown`s, whose menus are
 * absolutely positioned inside the row and would be clipped by the card.
 * Rows paint no background of their own, so the corners stay clean without it.
 */
export function SettingsGroup({ className, children, ...rest }: SettingsGroupProps) {
  return (
    <div
      {...rest}
      className={cx(
        'rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]',
        'divide-y divide-[var(--color-border)]',
        className,
      )}
    >
      {children}
    </div>
  )
}

export type SettingsRowProps = {
  title: ReactNode
  description?: ReactNode
  /** The control, pinned right. */
  children?: ReactNode
  /** Content under the title/control line, full row width (inline errors, expanded fields). */
  footer?: ReactNode
  /**
   * `inline` keeps the control beside the text at every width; `stack` puts
   * the control under the text (wide controls such as a full-width picker).
   * `responsive` (default) stacks only on narrow panes.
   */
  layout?: 'inline' | 'stack' | 'responsive'
  /** Renders the title as a `<label htmlFor>` for a single bare input control. */
  htmlFor?: string
  titleId?: string
  descriptionId?: string
  className?: string
  'data-testid'?: string
}

const ROW_LAYOUT = {
  inline: 'flex-row items-center',
  stack: 'flex-col items-stretch',
  responsive: 'flex-col items-stretch sm:flex-row sm:items-center',
} as const

const CONTROL_LAYOUT = {
  inline: 'shrink-0',
  stack: 'w-full',
  responsive: 'w-full sm:w-auto sm:shrink-0',
} as const

/**
 * One setting: 13px medium title and 12px tertiary description on the left,
 * the control on the right, at least 52px tall.
 */
export function SettingsRow({
  title,
  description,
  children,
  footer,
  layout = 'responsive',
  htmlFor,
  titleId,
  descriptionId,
  className,
  'data-testid': testId,
}: SettingsRowProps) {
  const TitleTag = htmlFor ? 'label' : 'div'
  return (
    <div data-testid={testId} className={cx('min-h-[52px] px-4 py-3', className)}>
      <div className={cx('flex gap-x-6 gap-y-2.5', ROW_LAYOUT[layout])}>
        <div className="min-w-0 flex-1">
          <TitleTag
            id={titleId}
            htmlFor={htmlFor}
            className="block text-[13px] font-medium leading-5 text-[var(--color-text-primary)]"
          >
            {title}
          </TitleTag>
          {description ? (
            // Capped so a description stays a readable line on the wide frame.
            <div id={descriptionId} className="mt-0.5 max-w-[68ch] text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
              {description}
            </div>
          ) : null}
        </div>
        {children ? (
          <div className={cx('flex min-w-0 flex-wrap items-center gap-2', CONTROL_LAYOUT[layout])}>{children}</div>
        ) : null}
      </div>
      {footer ? <div className="mt-3">{footer}</div> : null}
    </div>
  )
}

export type SettingsSwitchRowProps = {
  /** Visible title; also the switch's accessible name. */
  title: string
  description?: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  footer?: ReactNode
  className?: string
  'data-testid'?: string
}

/**
 * A row whose control is a `Switch`. The switch is named by the title, so a
 * screen reader hears the same words a sighted user reads.
 */
export function SettingsSwitchRow({
  title,
  description,
  checked,
  onChange,
  disabled,
  footer,
  className,
  'data-testid': testId,
}: SettingsSwitchRowProps) {
  return (
    <SettingsRow
      title={title}
      description={description}
      footer={footer}
      layout="inline"
      className={className}
      data-testid={testId}
    >
      <Switch checked={checked} onChange={onChange} disabled={disabled} label={title} labelHidden />
    </SettingsRow>
  )
}

/** A padded free-form cell inside a `SettingsGroup`, for content that is not a title/control row. */
export function SettingsBlock({ className, children }: { className?: string; children?: ReactNode }) {
  return <div className={cx('px-4 py-3', className)}>{children}</div>
}

export type SettingsPillProps = {
  selected: boolean
  /**
   * Which selected look to wear. `ink` is the solid primary fill for a choice
   * that applies immediately; `terracotta` is the soft selection outline used
   * where the pill only pre-fills a form (provider presets), so it does not
   * compete with the dialog's real primary button.
   */
  tone?: 'ink' | 'terracotta'
  onClick: () => void
  className?: string
  children: ReactNode
} & Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'disabled'>

const PILL_SELECTED = {
  ink: 'bg-[var(--color-btn-primary-bg)] text-[var(--color-btn-primary-fg)] border-transparent',
  terracotta:
    'bg-[var(--color-brand-soft)] text-[var(--color-on-brand-soft)] border-[var(--color-primary-fixed-dim)]',
} as const

/** A `rounded-full` single-choice chip, for option sets that wrap onto several lines. */
export function SettingsPill({
  selected,
  tone = 'ink',
  onClick,
  className,
  children,
  ...props
}: SettingsPillProps) {
  return (
    <button
      type="button"
      {...props}
      onClick={onClick}
      aria-pressed={selected}
      className={cx(
        'inline-flex h-7 items-center justify-center gap-1.5 rounded-full border px-3 text-xs font-medium',
        'transition-[background-color,color,border-color] duration-150 ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        selected
          ? PILL_SELECTED[tone]
          : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-outline)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]',
        className,
      )}
    >
      {children}
    </button>
  )
}

export type SettingsStatProps = {
  label: ReactNode
  value: ReactNode
  hint?: ReactNode
  className?: string
}

/** A KPI tile: 12px label over a 22px tabular number. */
export function SettingsStat({ label, value, hint, className }: SettingsStatProps) {
  return (
    <div
      className={cx(
        'grid min-w-0 gap-1 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-4 py-3.5',
        className,
      )}
    >
      <div className="truncate text-xs text-[var(--color-text-tertiary)]">{label}</div>
      <div className="text-[22px] font-semibold leading-tight tracking-[-0.02em] tabular-nums text-[var(--color-text-primary)]">
        {value}
      </div>
      {hint ? <div className="truncate text-xs text-[var(--color-text-tertiary)]">{hint}</div> : null}
    </div>
  )
}
