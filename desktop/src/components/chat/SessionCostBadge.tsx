import { useEffect, useState } from 'react'
import { sessionsApi } from '../../api/sessions'
import { formatCnyCost } from '../../lib/sessionUsageMetrics'
import { useTranslation } from '../../i18n'

/**
 * Session total-cost badge for the chat header.
 *
 * Cost only changes when a turn completes, but a turn can run for minutes while the user stares
 * at the header. So: one read on mount (the usageOnly single-control path, which is deliberately
 * cheap — no mcp/skills scan, no transcript cross-check), then a slow 10s poll while the session
 * is actively running. Inactive sessions never poll; a stale-but-true number beats a round-trip.
 *
 * Hidden until the session has produced tokens — a `$0.0000` badge before the first turn would
 * read as a measurement rather than an absence.
 */
const POLL_MS = 10_000

export function SessionCostBadge({
  sessionId,
  active = false,
  compact = false,
}: {
  sessionId: string
  active?: boolean
  /** Compact (mobile header) shows USD only to fit the narrow bar. */
  compact?: boolean
}) {
  const t = useTranslation()
  const [cost, setCost] = useState<{ usd: number; display: string } | null>(null)

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    let inFlight = false
    const load = () => {
      if (inFlight) return
      inFlight = true
      sessionsApi.getSessionUsage(sessionId)
        .then((inspection) => {
          if (cancelled) return
          const usage = inspection.usage
          if (!usage) return
          const produced =
            usage.totalInputTokens +
            usage.totalOutputTokens +
            usage.totalCacheReadInputTokens +
            usage.totalCacheCreationInputTokens
          if (produced === 0) return
          setCost({ usd: usage.totalCostUSD, display: usage.costDisplay })
        })
        .catch(() => {
          // A failed poll (CLI busy, control timeout) leaves the last good number on screen.
        })
        .finally(() => {
          inFlight = false
        })
    }
    load()
    if (!active) return () => { cancelled = true }
    const timer = setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sessionId, active])

  if (!cost) return null

  return (
    <span
      data-testid="session-cost-badge"
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container)] px-2 py-0.5 font-mono text-[11px] leading-none tabular-nums text-[var(--color-text-secondary)]"
      title={t('session.totalCost')}
    >
      <span className="text-[var(--color-text-primary)]">{cost.display}</span>
      {!compact && cost.usd > 0 && (
        <span className="text-[var(--color-text-tertiary)]">· {formatCnyCost(cost.usd)}</span>
      )}
    </span>
  )
}
