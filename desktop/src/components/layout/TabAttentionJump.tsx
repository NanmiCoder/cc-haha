import { CircleAlert } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'

/**
 * "Some sessions are waiting for you — take me to the next one."
 *
 * The mark on a tab says which tab; this says how many, and turns "find them
 * in a strip that scrolls" into one press. A person coming back to a run of
 * reviewers all stopped on the same kind of card can clear them one after
 * another without hunting for each.
 *
 * `count` is the waiting sessions other than the one on screen — the places a
 * press can actually go — and the caller only renders this when it is above
 * zero. The pill is a `Badge` so it borrows the warning container pair that
 * the contrast tests already cover, inside a real button that owns the focus
 * ring and the press. Static: the pulse is the tab mark's, and a second thing
 * breathing at the other end of the strip would only compete with it.
 */
export function TabAttentionJump({
  count,
  label,
  onJump,
}: {
  count: number
  label: string
  onJump: () => void
}) {
  return (
    <button
      type="button"
      onClick={onJump}
      aria-label={label}
      title={label}
      data-testid="tab-attention-jump"
      className="tab-bar-interactive flex-shrink-0 rounded-full transition-[filter] hover:brightness-95 active:brightness-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
    >
      <Badge
        tone="warning"
        size="sm"
        bordered
        className="tabular-nums"
        icon={<CircleAlert aria-hidden="true" size={12} strokeWidth={2} />}
      >
        {count > 9 ? '9+' : count}
      </Badge>
    </button>
  )
}
