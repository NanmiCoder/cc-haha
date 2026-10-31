/**
 * Messages the desktop server writes into a team lead's conversation on the
 * user's behalf: the approved team is running, the plan was returned, cancelled
 * or ended, a launch failed, members stopped. They reach the CLI as ordinary
 * user turns (a stop report must batch with the user's next words), but they
 * are not the user's words, so restored history and live replay leave them out.
 *
 * The wording is model-facing and recorded in replay cassettes; it must not
 * change. Each notice is one template that both writes the text and recognizes
 * it exactly, so the two cannot drift apart.
 */

type Template = {
  format(...values: string[]): string
  matches(text: string): boolean
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function template(strings: TemplateStringsArray, ..._slots: string[]): Template {
  const pattern = new RegExp(`^${strings.map(escape).join('[\\s\\S]*?')}$`)
  return {
    // Values fill the slots only; a template with fewer slots ignores the rest.
    format: (...values) => strings.reduce((text, part, index) => text + (index > 0 ? values[index - 1] ?? '' : '') + part, ''),
    matches: (text) => pattern.test(text),
  }
}

const LAUNCHED = template`Approved team ${'team'} is running. Members and their shared tasks are ready.${'waiting'} Continue coordinating the approved team; do not spawn these members again. Members report back automatically when they finish or fail; you do not need to poll or wait in a loop.`
const WAITING = template` Every task of ${'members'} waits on other tasks: such a member gets its instructions automatically once one of its tasks is ready. Messages sent to it before that wait in its inbox and arrive with those instructions. Each member is told to send its result to the members whose tasks depend on it before completing, so forward a result yourself only when a member says one is missing.`

const ADDITION_FAILED = template`[Team runtime notice] The members you proposed to add to your team ${'team'} did not start. Members already running are not affected. The user can review the plan and start it again, or cancel it, from the team card; do not spawn those members yourself.${'reason'}`
const LAUNCH_FAILED = template`[Team runtime notice] Your team ${'team'} did not start, so none of its members is running. The user can review the plan and start it again, or cancel the team, from the team card; do not create the team again yourself.${'reason'}`

const STOPPED_TAIL = 'A stopped member does nothing until it is messaged: if the work should go on, SendMessage each member that still has work, and it resumes from its saved conversation where it left off. Do not spawn replacements or redo their tasks. If a woken member fails again with the same error (a usage limit, billing, the network), tell the user instead of retrying. If the user wants the team to stay stopped, leave them.'
const STOPPED = {
  user: template`[Team runtime notice] The user's Stop also stopped your team ${'team'}. These members are stopped and keep their work so far:\n${'lines'}\n${'tail'}`,
  restart: template`[Team runtime notice] The app restarted, which stopped these members of your team ${'team'}. They keep their work so far:\n${'lines'}\n${'tail'}`,
  error: template`[Team runtime notice] These members of your team ${'team'} stopped on an error and keep their work so far:\n${'lines'}\n${'tail'}`,
}

const PLAN = {
  returned: template`The user returned team plan ${'team'} for revision. No members were launched. Feedback: ${'feedback'}`,
  cancelled: template`The user cancelled team plan ${'team'}. Do not launch its members. Wait for new user instructions.`,
  removed: template`The user cancelled team plan ${'team'} before any member started, and the team was removed. You no longer lead a team. Wait for new user instructions.`,
  ended: template`The user ended team ${'team'}: its members were stopped and the team was removed. You no longer lead a team. Wait for new user instructions.`,
}

const ALL: Template[] = [LAUNCHED, ADDITION_FAILED, LAUNCH_FAILED, ...Object.values(STOPPED), ...Object.values(PLAN)]

/** The approved team is running (sent once its members are ready). */
export function teamLaunchedNotice(teamName: string, waitingMembers: readonly string[]): string {
  return LAUNCHED.format(teamName, waitingMembers.length > 0 ? WAITING.format(waitingMembers.join(', ')) : '')
}

/** A launch failed; `failure` is the already-shortened error, if any. */
export function teamLaunchFailedNotice(teamName: string, addition: boolean, failure?: string): string {
  return (addition ? ADDITION_FAILED : LAUNCH_FAILED).format(teamName, failure ? `\nWhat failed: ${failure}` : '')
}

/** Members that are not running, one `- name: …` line each. */
export function teamStoppedNotice(teamName: string, cause: keyof typeof STOPPED, lines: readonly string[]): string {
  return STOPPED[cause].format(teamName, lines.join('\n'), STOPPED_TAIL)
}

/** The user acted on the plan from the team card. */
export function teamPlanNotice(kind: keyof typeof PLAN, teamName: string, feedback?: string): string {
  return PLAN[kind].format(teamName, feedback ?? 'Revise the team proposal.')
}

/** Exactly one of the notices above (as the CLI persisted or replayed it), not the user's words. */
export function isTeamLeadNotice(content: unknown): boolean {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' && typeof content[0].text === 'string'
      ? content[0].text
      : null
  return text !== null && ALL.some(notice => notice.matches(text))
}
