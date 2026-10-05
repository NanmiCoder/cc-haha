import { useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useTranslation } from '../../i18n'
import {
  toFrontmatterEntries,
  type FrontmatterEntry,
  type FrontmatterValue,
  type SkillFrontmatter,
} from '../../lib/skillFrontmatter'

/** Below this, the list always renders expanded — a toggle would be noise. */
const COLLAPSIBLE_THRESHOLD = 8

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center rounded-[var(--radius-xs)] bg-[var(--color-surface-container)] px-1.5 text-[11px] leading-5 text-[var(--color-text-secondary)] break-words">
      {children}
    </span>
  )
}

function ValueCell({ value }: { value: FrontmatterValue }) {
  if (Array.isArray(value)) {
    return (
      <span className="flex flex-wrap gap-1">
        {value.map((item, i) => (
          <Chip key={`${String(item)}-${i}`}>{String(item)}</Chip>
        ))}
      </span>
    )
  }

  if (typeof value === 'boolean') {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-[var(--radius-xs)] px-1.5 font-mono text-[11px] leading-5 ${
          value
            ? 'bg-[var(--color-success-container)] text-[var(--color-on-success-container)]'
            : 'bg-[var(--color-surface-container)] text-[var(--color-text-secondary)]'
        }`}
      >
        {value ? 'true' : 'false'}
      </span>
    )
  }

  if (typeof value === 'string' && value.includes('\n')) {
    return (
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-md)] bg-[var(--color-code-bg)] px-3 py-2 font-mono text-xs leading-5 text-[var(--color-text-secondary)]">
        {value}
      </pre>
    )
  }

  return <span className="break-words [overflow-wrap:anywhere]">{String(value)}</span>
}

function CollapseToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const t = useTranslation()
  return (
    <button
      type="button"
      data-testid="skill-frontmatter-toggle"
      aria-expanded={open}
      onClick={onToggle}
      className="-mr-1 inline-flex min-h-6 items-center gap-1 rounded-[var(--radius-sm)] px-1.5 text-xs font-normal text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
    >
      {open ? t('market.detail.metadataCollapse') : t('market.detail.metadataExpand')}
      <ChevronDown className={`transition-transform ${open ? 'rotate-180' : ''}`} size={14} strokeWidth={1.75} aria-hidden="true" />
    </button>
  )
}

/**
 * Sidebar form: rows that match the market meta list sitting above it, so a
 * skill's own declared attributes read as part of the same attribute block
 * rather than a separate widget. Short values sit opposite their label; arrays
 * and long text stack, because 300px cannot do both on one line.
 */
function SidebarRows({ entries }: { entries: FrontmatterEntry[] }) {
  return (
    <dl>
      {entries.map((entry) => {
        const stacked = entry.block || Array.isArray(entry.value)
        return (
          <div
            key={entry.key}
            data-testid={`skill-frontmatter-row-${entry.key}`}
            className={`min-w-0 border-b border-[var(--color-border)] px-4 py-2 last:border-b-0 ${
              stacked ? 'flex flex-col gap-1.5' : 'flex items-start justify-between gap-4'
            }`}
          >
            <dt
              className="min-w-0 font-mono text-[11px] leading-5 text-[var(--color-text-tertiary)] [overflow-wrap:anywhere]"
              title={entry.key}
            >
              {entry.key}
            </dt>
            <dd
              className={`min-w-0 text-[12px] leading-5 text-[var(--color-text-primary)] ${
                stacked ? '' : 'max-w-[62%] text-right font-medium'
              }`}
            >
              <ValueCell value={entry.value} />
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

/**
 * Wide form: an auto-fitting grid that keeps a dozen short fields to three or
 * four rows. Used inside the file preview, where the frontmatter genuinely is
 * the top of the file being read.
 */
function GridRows({ entries }: { entries: FrontmatterEntry[] }) {
  return (
    <dl className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,13rem),1fr))] gap-x-6 gap-y-3 pb-3.5">
      {entries.map((entry) => (
        <div
          key={entry.key}
          data-testid={`skill-frontmatter-row-${entry.key}`}
          className={`flex min-w-0 flex-col gap-1 ${entry.block ? 'col-span-full' : ''}`}
        >
          <dt className="truncate font-mono text-[11px] leading-4 text-[var(--color-text-tertiary)]" title={entry.key}>
            {entry.key}
          </dt>
          <dd className="min-w-0 text-[13px] leading-5 text-[var(--color-text-primary)]">
            <ValueCell value={entry.value} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * Structured view of a skill's YAML frontmatter.
 *
 * SKILL.md metadata is data, not prose — rendering it through the markdown
 * pipeline produced a wall of bold setext-heading text. It is also *reference*
 * material: it never precedes the document that explains what the skill does.
 * In `sidebar` it joins the attribute rail; in `grid` it heads the file preview.
 */
export function FrontmatterPanel({
  frontmatter,
  variant = 'grid',
  skipKeys,
  className,
  defaultOpen = true,
}: {
  frontmatter: SkillFrontmatter | null | undefined
  variant?: 'grid' | 'sidebar'
  /** Extra keys to hide, on top of the ones the detail header already shows. */
  skipKeys?: string[]
  className?: string
  defaultOpen?: boolean
}) {
  const t = useTranslation()
  const entries = useMemo(() => toFrontmatterEntries(frontmatter, { skipKeys }), [frontmatter, skipKeys])
  const [open, setOpen] = useState(defaultOpen)

  if (entries.length === 0) return null

  const collapsible = entries.length > COLLAPSIBLE_THRESHOLD
  const toggle = collapsible ? <CollapseToggle open={open} onToggle={() => setOpen((prev) => !prev)} /> : null

  if (variant === 'sidebar') {
    return (
      <section data-testid="skill-frontmatter-panel" className={className}>
        {/* Sticky: the rail scrolls on its own, and a bare list of `slug` /
            `xiaping_*` rows is meaningless without the heading in view. */}
        <div className="sticky top-0 z-[var(--z-raised)] flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-container)] px-4 py-1.5">
          <h3 className="flex-1 text-xs font-semibold text-[var(--color-text-tertiary)]">
            {t('market.detail.metadata')}
          </h3>
          {toggle}
        </div>
        {open && <SidebarRows entries={entries} />}
      </section>
    )
  }

  // Reads as the file's header block, not a card floating inside the preview
  // card — the frontmatter is part of the document being viewed.
  return (
    <section
      data-testid="skill-frontmatter-panel"
      className={`border-b border-[var(--color-border)] ${className ?? ''}`}
    >
      <div className="flex items-center gap-2 py-2">
        <h3 className="flex-1 text-xs font-semibold text-[var(--color-text-tertiary)]">
          {t('market.detail.metadata')}
        </h3>
        <span className="font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">{entries.length}</span>
        {toggle}
      </div>
      {open && <GridRows entries={entries} />}
    </section>
  )
}
