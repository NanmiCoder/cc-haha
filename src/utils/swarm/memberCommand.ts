/**
 * A slash command the user sends from a desktop member's conversation. It runs
 * in the member's own CLI (`/compact`, a skill) instead of reaching the member
 * as a teammate message, the way a pane teammate's user types into its REPL.
 */
export type MemberCommand = { name: string }

// A command name, not a path such as "/tmp/out.log is empty".
const COMMAND = /^\/([a-z0-9][\w:.-]*)(?:\s|$)/i

export function parseMemberCommand(text: string): MemberCommand | null {
  const match = COMMAND.exec(text.trim())
  return match ? { name: match[1]!.toLowerCase() } : null
}

/**
 * Commands that would undo what the member is: clearing drops the task it was
 * given, and its model belongs to the approved team (changed with the model
 * selector, which restarts the member under its team identity).
 */
const UNSUPPORTED: Record<string, string> = {
  clear: "A member's conversation cannot be cleared: it would lose the task the team gave it. Use /compact to make room instead.",
  reset: "A member's conversation cannot be cleared: it would lose the task the team gave it. Use /compact to make room instead.",
  new: "A member's conversation cannot be cleared: it would lose the task the team gave it. Use /compact to make room instead.",
  model: "Change this member's model with the model selector.",
}

export function unsupportedMemberCommandReason(command: MemberCommand): string | undefined {
  return UNSUPPORTED[command.name]
}
