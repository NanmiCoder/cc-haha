export const SHUTDOWN_TEAM_PROMPT = `<system-reminder>
You are running in non-interactive mode and cannot return a response to the user until your team is shut down.

You MUST shut down your team before preparing your final response:
1. Use requestShutdown to ask each team member to shut down gracefully
2. Wait for shutdown approvals
3. Use the cleanup operation to clean up the team
4. Only then provide your final response to the user

The user cannot receive your response until the team is completely shut down.
</system-reminder>

Shut down your team and prepare your final response for the user.`

/**
 * The desktop's stand-in for SHUTDOWN_TEAM_PROMPT: a desktop lead's input never
 * closes, so it is reminded once its approved team has finished instead. Only
 * members still running are named; a shutdown request to a stopped member would
 * restart it just to stop it again.
 */
export function formatTeamFinishedPrompt(teamName: string, runningMembers: readonly string[]): string {
  const shutdown = runningMembers.length > 0
    ? `shut the team down: send each of ${runningMembers.join(', ')} its own shutdown_request with SendMessage (structured messages cannot be broadcast), wait for their approvals, then call TeamDelete.`
    : 'every teammate has already stopped, so call TeamDelete to end the team.'
  return `<system-reminder>
Every task on the shared task list of your team ${teamName} is completed and no teammate is working.
If the user's request is done, ${shutdown} Then give the user your final response.
If more work is needed, assign it instead. If the user asked to keep the team running, leave it.
</system-reminder>`
}

/** Recognize the exact legacy instruction even when it was persisted without isMeta. */
export function isShutdownTeamPrompt(content: unknown): boolean {
  const text = typeof content === 'string' ? content :
    Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' ? content[0].text : null
  return text === SHUTDOWN_TEAM_PROMPT
}
