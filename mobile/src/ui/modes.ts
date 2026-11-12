import type { PermissionMode } from '../core/types'

/** App-wide permission mode names: the input, new task, plan execution and settings all use this set. */
export const modes: {
  id: PermissionMode
  title: string
  description: string
}[] = [
  { id: 'default', title: 'Ask', description: 'Asks you before actions that need permission' },
  {
    id: 'acceptEdits',
    title: 'Auto-accept edits',
    description: 'File edits no longer ask you; other actions are confirmed as usual',
  },
  { id: 'auto', title: 'Auto', description: 'Handled by the auto approval rules on the computer' },
  { id: 'plan', title: 'plan', description: 'Discuss and plan first, run after you approve' },
  {
    id: 'bypassPermissions',
    title: 'Full access',
    description: 'Skips all tool approvals; use only in projects you trust',
  },
]

const extraModeNames: Record<string, string> = { dontAsk: 'Don’t ask' }

export const modeName = (id?: string) =>
  modes.find((mode) => mode.id === id)?.title ??
  (id ? (extraModeNames[id] ?? id) : 'Ask')

/** Execution modes available when approving a plan (excluding "plan" itself). */
export const planExecutionModes = modes.filter((mode) =>
  ['default', 'acceptEdits', 'bypassPermissions'].includes(mode.id)
)

const effortNames: Record<string, string> = {
  none: 'Close',
  minimal: 'Minimum',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Max',
  max: 'Highest',
}

/** Unified names for thinking effort; unknown values shown as is, unset shows "Default". */
export const effortName = (effort?: string | null) =>
  effort ? (effortNames[effort] ?? effort) : 'Default'

/** Standard / Lean User-visible names of the two run tiers. */
export const profileName = (profile?: string | null) =>
  profile === 'lean' ? 'Light' : 'Full tools'

export const profileDescription = (profile?: string | null) =>
  profile === 'lean'
    ? 'Lean tool environment; no plan mode or teams'
    : 'Full tools, plan and team capabilities'
