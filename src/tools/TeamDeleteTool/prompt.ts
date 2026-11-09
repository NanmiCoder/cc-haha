export function getPrompt(): string {
  return `
# TeamDelete

Remove team and task directories when the swarm work is complete.

This operation:
- Removes the team directory (\`~/.claude/teams/{team-name}/\`)
- Removes the task directory (\`~/.claude/tasks/{team-name}/\`)
- Clears team context from the current session

**IMPORTANT**: TeamDelete will fail while teammates are still running. Send each running teammate a shutdown_request, then call TeamDelete after their approvals arrive; a teammate that is already stopped needs no request. Never delete the team or task directories yourself: if they are already gone, TeamDelete still releases the team.

Use this when all teammates have finished their work and you want to clean up the team resources, or the user asks to end the team. New work does not need a new team: message the existing teammates or add members to this team instead. The team name is automatically determined from the current session's team context.
`.trim()
}
