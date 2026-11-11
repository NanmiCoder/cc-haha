import type { useProgressiveReveal } from '@/components/agentTeams/useProgressiveReveal'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '@/i18n'

/**
 * The end of a progressively mounted message list: an invisible sentinel the
 * scroll observer watches, or a button where no observer exists.
 */
export function AgentTeamsRevealMore({
  reveal,
  remaining,
}: {
  reveal: ReturnType<typeof useProgressiveReveal>
  /** Rows still unmounted, for the fallback button's label. */
  remaining: number
}) {
  const t = useTranslation()
  if (!reveal.hasMore) return null
  if (reveal.canAutoReveal) {
    return (
      <div
        ref={reveal.sentinelRef}
        data-testid="agent-teams-reveal-sentinel"
        aria-hidden="true"
        className="h-px"
      />
    )
  }
  return (
    <div className="flex justify-center px-3.5 py-2">
      <Button variant="ghost" size="sm" onClick={reveal.showMore}>
        {t('agentTeams.communication.showEarlier', { count: remaining })}
      </Button>
    </div>
  )
}
