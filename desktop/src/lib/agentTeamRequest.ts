/**
 * The message wrapper behind the composer's Agent Team switch.
 *
 * Armed, the next message goes to the model with a fixed instruction block in
 * front of it, while the bubble shows only what the user typed. The block has
 * a tag of its own so a reloaded transcript can drop it again; its text is
 * English on purpose, since it talks to the model, not the user.
 */

const OPEN_TAG = '<agent-team-request>'
const CLOSE_TAG = '</agent-team-request>'

export const AGENT_TEAM_REQUEST_INSTRUCTION =
  'Use an Agent Team for this request: create a team, split the goal below into tasks with clear owners, '
  + 'and coordinate the teammates until the goal is done.'

const REQUEST_BLOCK = new RegExp(`${OPEN_TAG}[\\s\\S]*?${CLOSE_TAG}\\n*`)

export function withAgentTeamRequest(content: string): string {
  const block = `${OPEN_TAG}\n${AGENT_TEAM_REQUEST_INSTRUCTION}\n${CLOSE_TAG}`
  return content ? `${block}\n\n${content}` : block
}

/** The user-facing text of a message, with the Agent Team block removed. */
export function stripAgentTeamRequest(text: string): { content: string, requested: boolean } {
  if (!text.includes(OPEN_TAG)) return { content: text, requested: false }
  const content = text.replace(REQUEST_BLOCK, '')
  return content === text ? { content: text, requested: false } : { content, requested: true }
}
