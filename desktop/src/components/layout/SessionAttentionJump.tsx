import { CircleAlert } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'

/**
 * "Some sessions are waiting for you — take me to the next one."
 *
 * The mark on a sidebar row says which session; this says how many, from
 * anywhere in the app, and turns "find them in a long list" into one press. A
 * person coming back to a run of reviewers all stopped on the same kind of
 * card can clear them one after another without hunting for each.
 *
 * `count` is the waiting sessions other than the one on screen — the places a
 * press can actually go — and the caller only renders this when it is above
 * zero. `format` turns the shown number ("9+" past nine) into the pill's text;
 * without it the pill shows the bare number. The pill is a `Badge` so it
 * borrows the warning container pair that the contrast tests already cover,
 * inside a real button that owns the focus ring and the press. Static: the
 * pulse belongs to the mark on the row.
 */
export function SessionAttentionJump({
  count,
  label,
  format,
  onJump,
}: {
  count: number
  label: string
  format?: (shown: string) => string
  onJump: () => void
}) {
  const shown = count > 9 ? '9+' : String(count)
  return (
    <button
      type="button"
      onClick={onJump}
      aria-label={label}
      title={label}
      data-testid="session-attention-jump"
      className="tab-bar-interactive flex-shrink-0 rounded-full transition-[filter] hover:brightness-95 active:brightness-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
    >
      <Badge
        tone="warning"
        size="sm"
        bordered
        className="tabular-nums"
        icon={<CircleAlert aria-hidden="true" size={12} strokeWidth={2} />}
      >
        {format ? format(shown) : shown}
      </Badge>
    </button>
  )
}
