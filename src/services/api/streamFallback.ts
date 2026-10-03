export function shouldTriggerNonStreamingFallbackForEmptyStream({
  hasMessageStart,
  assistantMessageCount,
  stopReason,
}: {
  hasMessageStart: boolean
  assistantMessageCount: number
  stopReason: string | null
}): boolean {
  if (!hasMessageStart) return true
  if (assistantMessageCount > 0) return false
  return stopReason === null || stopReason === 'tool_use'
}

export type StreamEndedEarlyReason = 'no_events' | 'incomplete'

/**
 * A 200 SSE body that closed cleanly before the response completed: nothing
 * usable arrived (`no_events`), or it stopped short of message_stop and a
 * stop_reason, possibly with blocks still open (`incomplete`). The provider
 * never ruled on the request, so — like a reset socket — a re-send can clear it.
 */
export class StreamEndedEarlyError extends Error {
  constructor(readonly reason: StreamEndedEarlyReason) {
    super(
      reason === 'no_events'
        ? 'Stream ended without receiving any events'
        : 'Provider stream ended before completing the response',
    )
    this.name = 'StreamEndedEarlyError'
  }
}
