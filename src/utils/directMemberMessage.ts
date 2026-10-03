import type { AppState } from '../state/AppState.js'

/**
 * Parse `@agent-name message` syntax for direct team member messaging.
 */
export function parseDirectMemberMessage(input: string): {
  recipientName: string
  message: string
} | null {
  const match = input.match(/^@([\w-]+)\s+(.+)$/s)
  if (!match) return null

  const [, recipientName, message] = match
  if (!recipientName || !message) return null

  const trimmedMessage = message.trim()
  if (!trimmedMessage) return null

  return { recipientName, message: trimmedMessage }
}

export type DirectMessageResult =
  | { success: true; recipientName: string }
  | {
      success: false
      error: 'no_team_context' | 'unknown_recipient' | 'delivery_failed'
      recipientName?: string
    }

/** Resolves true once the message is persisted in the member's inbox. */
type WriteToMailboxFn = (
  recipientName: string,
  message: { from: string; text: string; timestamp: string },
  teamName: string,
) => Promise<boolean>

/**
 * Send a direct message to a team member, bypassing the model.
 */
export async function sendDirectMemberMessage(
  recipientName: string,
  message: string,
  teamContext: AppState['teamContext'],
  writeToMailbox?: WriteToMailboxFn,
): Promise<DirectMessageResult> {
  if (!teamContext || !writeToMailbox) {
    return { success: false, error: 'no_team_context' }
  }

  // Find team member by name
  const member = Object.values(teamContext.teammates ?? {}).find(
    t => t.name === recipientName,
  )

  if (!member) {
    return { success: false, error: 'unknown_recipient', recipientName }
  }

  const delivered = await writeToMailbox(
    recipientName,
    {
      from: 'user',
      text: message,
      timestamp: new Date().toISOString(),
    },
    teamContext.teamName,
  )
  if (!delivered) {
    return { success: false, error: 'delivery_failed', recipientName }
  }

  return { success: true, recipientName }
}
