/**
 * Agent Messages between team members (including the lead) are written into the recipient's
 * transcriptas a `<teammate-message teammate_id="…">` envelope. Same as desktop: the lead's main conversation does not treat it as user speech; only the member page shows the body, 
 * JSON of lifecycle notifications (idle, shutdown request etc) is not shown.
 */
const ENVELOPE = /<teammate-message\s+teammate_id="([^"]+)"[^>]*>\n?([\s\S]*?)\n?<\/teammate-message>/g
const LIFECYCLE = new Set([
  'shutdown_approved',
  'shutdown_rejected',
  'shutdown_request',
  'teammate_terminated',
  'idle_notification',
])

/** Only count complete open/close tags: mentioning the tag name when pasting code or discussing the protocol does not count. */
export function isTeammateEnvelope(text: string) {
  return text.includes('<teammate-message') && text.includes('</teammate-message>')
}

/** The human-facing message inside the envelope; returns null if not an envelope, and an empty array if all are lifecycle notifications. */
export function teammateMessages(text: string): { from: string; text: string }[] | null {
  if (!isTeammateEnvelope(text)) return null
  const messages: { from: string; text: string }[] = []
  for (const match of text.matchAll(ENVELOPE)) {
    const content = match[2]?.trim()
    if (!content) continue
    if (content.startsWith('{') && content.endsWith('}')) {
      try {
        const body = JSON.parse(content) as { type?: unknown }
        if (typeof body.type === 'string' && LIFECYCLE.has(body.type)) continue
      } catch {
        // and plain text that looks like JSON is shown as usual.
      }
    }
    messages.push({ from: match[1] ?? '', text: content })
  }
  return messages
}

/** team-lead is the lead; everything else is a member name. */
export const teammateLabel = (from: string) => (from === 'team-lead' || from.startsWith('team-lead@') ? 'Lead' : from.split('@')[0] || from)
