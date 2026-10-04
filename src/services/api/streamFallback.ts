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
 * What the attempt had received when the body closed. It tells a provider
 * that cut the reply mid-block apart from one that only dropped message_stop.
 */
export type StreamEndedEarlyEvidence = {
  eventCount: number
  lastEventType: string | null
  stopReason: string | null
  messageStopReceived: boolean
  openBlockCount: number
  elapsedMs: number
}

/**
 * A 200 SSE body that closed cleanly before the response completed: nothing
 * usable arrived (`no_events`), or it stopped short of message_stop and a
 * stop_reason, possibly with blocks still open (`incomplete`). The provider
 * never ruled on the request, so — like a reset socket — a re-send can clear it.
 */
export class StreamEndedEarlyError extends Error {
  constructor(
    readonly reason: StreamEndedEarlyReason,
    readonly evidence?: StreamEndedEarlyEvidence,
  ) {
    super(
      reason === 'no_events'
        ? 'Stream ended without receiving any events'
        : 'Provider stream ended before completing the response',
    )
    this.name = 'StreamEndedEarlyError'
  }
}

/**
 * User-facing text once the stream could not be recovered: the original
 * wording, who closed the stream, and the evidence that shows how.
 */
export function formatStreamEndedEarlyMessage(
  error: StreamEndedEarlyError,
  retries?: number,
): string {
  const details: string[] = []
  if (retries !== undefined && retries > 0) {
    details.push(`retried ${retries} ${retries === 1 ? 'time' : 'times'}`)
  }
  const evidence = error.evidence
  if (evidence) {
    details.push(
      `${evidence.eventCount} ${evidence.eventCount === 1 ? 'event' : 'events'}`,
    )
    if (evidence.lastEventType) details.push(`last ${evidence.lastEventType}`)
    details.push(`stop_reason ${evidence.stopReason ?? 'none'}`)
    if (!evidence.messageStopReceived) details.push('message_stop missing')
    if (evidence.openBlockCount > 0) {
      details.push(
        `${evidence.openBlockCount} ${evidence.openBlockCount === 1 ? 'block' : 'blocks'} open`,
      )
    }
    details.push(`${Math.round(evidence.elapsedMs / 1000)}s`)
  }
  const summary = `${error.message}. The upstream model provider closed the stream before the reply finished; this is not a context-limit error.`
  return details.length > 0 ? `${summary} (${details.join(' · ')})` : summary
}
