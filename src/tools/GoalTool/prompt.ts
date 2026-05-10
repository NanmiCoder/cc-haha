export const GET_GOAL_DESCRIPTION =
  'Read the current persistent session goal and its status.'

export const CREATE_GOAL_DESCRIPTION =
  'Create or replace the persistent session goal only when the user explicitly asks to track a long-running goal.'

export const UPDATE_GOAL_DESCRIPTION =
  'Mark the persistent session goal complete after you have audited that the objective is fully achieved.'

export const GET_GOAL_PROMPT = `
Reads the active session goal, if one exists. Use this when you need to confirm
the objective, current status, or budget before continuing goal-directed work.
`.trim()

export const CREATE_GOAL_PROMPT = `
Creates or replaces the persistent session goal for the current conversation.
Only use this when the user explicitly asks to set, create, or change a
long-running goal. Do not create goals opportunistically.
`.trim()

export const UPDATE_GOAL_PROMPT = `
Updates the persistent session goal. This tool currently only supports marking
the goal complete. Before calling it, perform a completion audit: verify the
objective is satisfied, there are no obvious failing checks left, and there is
no remaining work you can complete without asking the user.
`.trim()
